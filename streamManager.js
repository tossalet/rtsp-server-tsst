const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// In-memory store for active processes
const activeInputs = {};
const activeOutputs = {};
const telemetryCache = {};

// Locate FFmpeg binary (handles Windows local download vs Linux global)
function getFFmpegPath() {
    if (os.platform() === 'win32') {
        const binDir = path.join(__dirname, 'ffmpeg_bin');
        if (fs.existsSync(binDir)) {
            // Find inner folder (like ffmpeg-7.0.2-essentials_build)
            const subdirs = fs.readdirSync(binDir);
            for (let sub of subdirs) {
                const exePath = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exePath)) return exePath;
            }
        }
    }
    return 'ffmpeg'; // Linux Docker fallback
}

/**
 * Start an Input Stream (Listener or Pull)
 * Receives external signal and pushes to Local UDP multiplexer.
 */
function startInput(inputObj) {
    const { channel, url, udpsrv, audiowtdg, wtdgsecs } = inputObj;
    if (activeInputs[channel]) {
        console.log(`Input ${channel} is already running.`);
        return;
    }

    const ffmpegCmd = getFFmpegPath();
    const localTcpOut = `tcp://127.0.0.1:${udpsrv}`;

    // Base args: Read from URL
    const args = [
        '-hide_banner',
        '-y',
        '-fflags', '+genpts'
    ];

    // Editable Buffer para entrada
    if (inputObj.buffer && inputObj.buffer > 0) {
        // En UDP/RTSP previene smearing/artifacts ajustando la recolección
        args.push('-buffer_size', `${inputObj.buffer}M`);
    }

    // Forzar modo TCP para cámaras de vigilancia RTSP (evita artefactos y cortes rápidos)
    if (url.startsWith('rtsp://')) {
        args.push('-rtsp_transport', 'tcp');
    }

    args.push('-i', url);

    // Main Output: copy codec, output to local MPEG-TS TCP
    args.push('-map', '0:v?');
    args.push('-map', '0:a?');
    args.push('-c:v', 'copy');
    args.push('-c:a', 'aac');
    args.push('-b:a', '128k');
    if (url.startsWith('rtmp')) {
        args.push('-bsf:v', 'h264_mp4toannexb'); // Force bitstream conversion only for RTMP to avoid corrupting native SRT
    }
    args.push('-f', 'mpegts');
    args.push('-muxdelay', '0.5'); // Dar margen de medio segundo para que FFmpeg ordene y pacifique los paquetes TS
    args.push('-muxpreload', '0.5');
    args.push(localTcpOut);

    // Visual Preview Generation is now strictly decoupled into its own independent ffmpeg process!



    console.log(`[STARTING INPUT ${channel}] ${ffmpegCmd} ${args.join(' ')}`);
    const child = spawn(ffmpegCmd, args);

    child.on('error', (err) => {
        console.error(`[FATAL IN-${channel}] FFmpeg missing or crashed:`, err.message);
    });

    let lastParseTime = 0;
    let codecFound = false;
    
    child.stderr.on('data', (data) => {
        const out = data.toString();
        
        // Extraer codec en cuanto aparezca (suele estar en los primeros chunks, no limitarlo por tiempo)
        if (!codecFound) {
            const codecMatch = out.match(/Video:\s*([a-zA-Z0-9_-]+)/);
            if (codecMatch && activeInputs[channel]) {
                let parsedCodec = codecMatch[1].toUpperCase();
                if (parsedCodec === 'HEVC') parsedCodec = 'H.265';
                else if (parsedCodec === 'H264') parsedCodec = 'H.264';
                
                activeInputs[channel].codec = parsedCodec;
                codecFound = true;
            }
        }

        const now = Date.now();
        // THRESHOLD LIMIT: Solo analizamos estadísticas 2 veces por segundo para evitar saturar NodeJS
        if (now - lastParseTime < 500) return;
        lastParseTime = now;
        
        // Match FFmpeg stats
        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);
        
        if (bitrateMatch && ioInstance) {
            if (activeInputs[channel]) activeInputs[channel].lastUpdate = now;
            
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            const brText = bitrateMatch[1];
            const br = parseFloat(brText); // ej. "4500.5kbits/s" -> 4500.5
            
            telemetryCache[channel].push({ t: new Date().toLocaleTimeString(), y: br || 0 });
            if (telemetryCache[channel].length > 60) telemetryCache[channel].shift(); // Keep last 60 points
            
            ioInstance.emit('stats', {
                channel: channel,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                codec: activeInputs[channel] ? activeInputs[channel].codec : '',
                history: telemetryCache[channel] // Payload con curva precargada
            });
        }
    });

    // Setup TCP Multiplexer in Node.js (Eliminates UDP packet loss on loopback completely)
    const net = require('net');
    const router = net.createServer((socket) => {
        socket.on('data', (data) => {
            for (const sub of router.subscribers) {
                // Backpressure protection: Drop slow clients to prevent Node OOM
                if (sub.writableLength > 256 * 1024 * 1024) {
                    sub.destroy();
                    router.subscribers.delete(sub);
                    console.log(`[ROUTER ${channel}] Killed slow subscriber to prevent memory leak.`);
                } else {
                    sub.write(data);
                }
            }
        });
        socket.on('error', () => {});
    });
    router.subscribers = new Set();
    router.port = udpsrv;
    
    // Bind to the udpsrv generated port to receive FFmpeg feed
    let _routerRetries = 0;
    const _routerBind = () => router.listen(udpsrv, '127.0.0.1', () => {
        console.log(`[ROUTER] Channel ${channel} bound on TCP ${udpsrv}`);
    });
    _routerBind();
    
    router.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            _routerRetries++;
            if (_routerRetries > 6) {
                console.error(`[ROUTER ${channel}] Port ${udpsrv} permanently busy after ${_routerRetries} retries. Giving up.`);
                return;
            }
            console.log(`[ROUTER ${channel}] Port ${udpsrv} busy (TIME_WAIT), retry ${_routerRetries}/6 in 5s...`);
            setTimeout(() => {
                try { router.close(() => _routerBind()); } catch(e) { _routerBind(); }
            }, 5000);
        } else {
            console.error(`[ROUTER ${channel}] TCP Socket Error:`, err.message);
        }
    });

    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Input ${channel} exited with code ${code}`);
        // Shutdown router safely
        try { router.close(); } catch (e) {}
        try { sender.close(); } catch (e) {}
        
        if (telemetryCache[channel]) delete telemetryCache[channel]; // Limpiar RAM historico
        
        // Remove thumbnail so UI flips to TV Bars
        const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
        fs.unlink(extPath, (err) => {});
        
        stopPreview(channel);

        // Auto-Restart Logic (If not deliberately stopped by user)
        if (!intentionalStop) {
            console.log(`[IN-${channel}] Connection lost or crashed. Auto-restarting in 10s...`);
            // Turn yellow in UI (we fake an active signal with 0 bitrate)
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
            
            // Si nadie reemplazó manualmente el activeInputs, usamos un timeout para reconectar
            if (activeInputs[channel] && activeInputs[channel].process === child) {
                activeInputs[channel].autoRestart = setTimeout(() => {
                    delete activeInputs[channel];
                    startInput(inputObj);
                }, 10000);
            } else if (!activeInputs[channel]) {
                setTimeout(() => { startInput(inputObj); }, 10000);
            }
        } else {
            // Intentional stop
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: false });
        }
    });

    activeInputs[channel] = { process: child, router: router, lastUpdate: Date.now(), inputObj: inputObj, isStopping: false, prevProcess: null, prevPort: null };
    
    if (inputObj.preview_enabled !== 0) {
        startPreview(channel, false);
    } else {
        startPreview(channel, true);
    }

    return true;
}

function startPreview(channel, singleFrame = false) {
    if (!activeInputs[channel] || !activeInputs[channel].router) return;
    if (activeInputs[channel].prevProcess) stopPreview(channel);

    const prevPort = 30000 + Math.floor(Math.random() * 30000);
    activeInputs[channel].prevPort = prevPort;

    const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
    const ffmpegCmd = getFFmpegPath();
    const args = [
        '-hide_banner', '-y',
        '-skip_frame', 'nokey',
        '-i', `tcp://127.0.0.1:${prevPort}?listen`,
        '-map', '0:v?'
    ];

    if (singleFrame) {
        args.push('-frames:v', '1', '-q:v', '5', '-update', '1', '-f', 'image2', extPath);
    } else {
        args.push('-update', '1', '-q:v', '5', '-f', 'image2', extPath);
    }

    const child = spawn(ffmpegCmd, args);
    activeInputs[channel].prevProcess = child;
    
    child.on('error', (err) => {
        console.error(`[PREVIEW ERROR CH-${channel}] Failed to run ffmpeg:`, err.message);
    });

    // Connect Node to the FFmpeg preview TCP listener
    setTimeout(() => {
        if (child.exitCode === null && activeInputs[channel] && activeInputs[channel].router) {
            const net = require('net');
            const sock = new net.Socket();
            sock.connect(prevPort, '127.0.0.1', () => {
                activeInputs[channel].router.subscribers.add(sock);
            });
            sock.on('error', () => { activeInputs[channel].router.subscribers.delete(sock); });
            sock.on('close', () => { activeInputs[channel].router.subscribers.delete(sock); });
            activeInputs[channel].prevSocket = sock;
        }
    }, 1500);

    if (singleFrame) {
        setTimeout(() => stopPreview(channel), 15000);
    }

    child.on('close', () => {
        if (activeInputs[channel]) {
            if (activeInputs[channel].prevSocket) activeInputs[channel].prevSocket.destroy();
            if (activeInputs[channel].prevProcess === child) activeInputs[channel].prevProcess = null;
        }
    });
}

function stopPreview(channel) {
    const inp = activeInputs[channel];
    if (inp && inp.prevProcess) {
        inp.prevProcess.kill('SIGKILL');
        if (inp.prevSocket) {
            inp.prevSocket.destroy();
            if (inp.router) inp.router.subscribers.delete(inp.prevSocket);
        }
        inp.prevProcess = null;
    }
}

/**
 * Stop an Input Stream
 */
function stopInput(channel) {
    if (activeInputs[channel]) {
        console.log(`[STOPPING INPUT ${channel}] Killing process and router...`);
        if (activeInputs[channel].autoRestart) clearTimeout(activeInputs[channel].autoRestart);
        
        if (activeInputs[channel].process) {
            if (typeof activeInputs[channel].process.markIntentionalStop === 'function') {
                activeInputs[channel].process.markIntentionalStop();
            }
            activeInputs[channel].process.kill('SIGKILL');
        }
        try { activeInputs[channel].router.close(); } catch(e){}
        
        delete activeInputs[channel];
        return true;
    }
    return false;
}

/**
 * Start an Output Stream
 * Pulls from the Local UDP multiplexer (udpsrv) and pushes to destination URL.
 */
function startOutput(outputObj) {
    const { id, channel, url } = outputObj; 
    if (activeOutputs[id]) {
        console.log(`Output ${id} is already running.`);
        return;
    }
    
    // Check if input stream is alive
    if (!activeInputs[channel]) {
        console.log(`Cannot start Output ${id}: Input ${channel} is offline.`);
        return; // Will stay disabled until input connects
    }

    // Generate unique local UDP port for this specific output receiver
    const localPort = 20000 + Math.floor(Math.random() * 30000); // 20000-50000 range
    
    // We assign child process FIRST so we can measure if it dies instantly
    let processStarted = false;

    const ffmpegCmd = getFFmpegPath();
    // Migrado a TCP para evitar el límite de buffer de 64KB de Windows UDP que causaba pérdida de frames en local
    const localTcpIn = `tcp://127.0.0.1:${localPort}?listen`;

    const isRtmp = url.startsWith('rtmp');
    const isDisk = url.startsWith('disk://');
    let format = 'mpegts';
    let destUrl = url;
    
    if (isRtmp) format = 'flv';
    if (isDisk) {
        destUrl = url.replace('disk://', '');
        
        // AUTO-TIMESTAMP TO PREVENT OVERWRITES:
        // Inject current datetime into filename: NombreInput_20260418_223500.mp4
        const now = new Date();
        const df = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
        
        const lastSlash = Math.max(destUrl.lastIndexOf('/'), destUrl.lastIndexOf('\\'));
        const lastDot = destUrl.lastIndexOf('.');
        
        if (!destUrl.toLowerCase().endsWith('.m3u8')) {
            if (lastDot > lastSlash) {
                destUrl = destUrl.substring(0, lastDot) + '_' + df + destUrl.substring(lastDot);
            } else {
                destUrl += '_' + df + '.mp4';
            }
        }

        if (destUrl.toLowerCase().endsWith('.ts')) format = 'mpegts';
        else if (destUrl.toLowerCase().endsWith('.mkv')) format = 'matroska';
        else if (destUrl.toLowerCase().endsWith('.m3u8')) format = 'hls';
        else format = 'mp4';
    }

    const vcodec = outputObj.vcodec || 'copy';

    const args = [
        '-hide_banner',
        '-y',
        '-fflags', '+genpts', // Critical for UDP to MP4 timebase
        '-thread_queue_size', '4096', // Evita que el hilo de lectura TCP dropee paquetes si la escritura a disco o SRT se atasca
        '-i', localTcpIn
    ];
    
    if (vcodec === 'copy') {
        args.push('-c', 'copy');
    } else if (vcodec === 'h264_qsv' || vcodec === 'hevc_qsv') {
        // Hardware Acceleration Intel UHD 630
        args.push('-c:v', vcodec);
        args.push('-preset', 'veryfast');
        args.push('-global_quality', '23'); // Alternativa a CRF para Intel QSV
        args.push('-look_ahead', '0'); // Baja latencia
        args.push('-g', '25'); // Keyframe cada 25 frames
        args.push('-c:a', 'aac');
        args.push('-b:a', '128k');
    } else {
        args.push('-c:v', vcodec);
        args.push('-preset', 'ultrafast');
        args.push('-crf', '23');
        args.push('-g', '25');         // Force keyframe every 25 frames
        args.push('-sc_threshold', '0'); // Disable scene-change keyframes
        args.push('-c:a', 'aac');
        args.push('-b:a', '128k');
    }
    
    args.push('-max_muxing_queue_size', '9999'); // Prevenir hangs del ffmpeg en la cola de muxing
    
    // Critical bitstream filter for AAC audio inside MP4 container from raw UDP streams
    if (format === 'mp4' || format === 'hls') {
        args.push('-bsf:a', 'aac_adtstoasc');
    } else if (format === 'mpegts') {
        // Aumentar el delay y preload a 500ms para garantizar un pacing (PCR) perfecto hacia vMix sin tirones
        args.push('-muxdelay', '0.5');
        args.push('-muxpreload', '0.5');
    }
    
    if (isDisk && format === 'mp4') {
        args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof'); // MP4 fragmentado rocoso
    }
    
    if (format === 'hls') {
        args.push('-hls_time', '2');       // 2s segments = faster live edge
        args.push('-hls_list_size', '0'); // Keep all segments for replay
        args.push('-hls_segment_type', 'mpegts');
        args.push('-f', 'hls');
    } else {
        args.push('-f', format);
    }
    args.push(destUrl);

    console.log(`[STARTING OUTPUT ${id}] ${ffmpegCmd} ${args.join(' ')}`);

    const child = spawn(ffmpegCmd, args);
    processStarted = true;
    
    // Subscribe this output ONLY IF ffmpeg survives the first 1.5 seconds.
    setTimeout(() => {
        if (child.exitCode === null && activeInputs[channel] && activeInputs[channel].router) {
            const net = require('net');
            // Test connection to verify port is alive before letting ffmpeg connect
            const sock = net.createConnection(localPort, '127.0.0.1', () => {
                console.log(`[OUT-${id}] Validated and successfully subscribed to local TCP ${localPort}`);
                activeInputs[channel].router.subscribers.add(sock);
                activeOutputs[id].tcpSocket = sock;
            });
            sock.on('error', () => {
                console.log(`[OUT-${id}] Router port ${localPort} unreachable. FFmpeg will fail.`);
            });
            sock.on('close', () => { 
                if (activeInputs[channel] && activeInputs[channel].router) {
                    activeInputs[channel].router.subscribers.delete(sock); 
                }
            });
            
            if (activeOutputs[id]) activeOutputs[id].tcpSocket = sock;
        }
    }, 1500);

    child.on('error', (err) => {
        console.error(`[FATAL OUT-${id}] FFmpeg missing or crashed:`, err.message);
    });

    // Suppress heavy console logs but quietly parse bitrate metrics for UI telemetry without blocking V8
    let lastParseTime = 0;
    
    child.stderr.on('data', (data) => {
        const now = Date.now();
        if (now - lastParseTime < 500) return;
        lastParseTime = now;
        
        const out = data.toString();
        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);
        
        if (bitrateMatch && ioInstance) {
            const outChan = 'out_' + id;
            if (activeOutputs[id]) activeOutputs[id].lastUpdate = now;
            
            if (!telemetryCache[outChan]) telemetryCache[outChan] = [];
            const brText = bitrateMatch[1];
            const br = parseFloat(brText); // ej. "4500.5kbits/s" -> 4500.5
            
            telemetryCache[outChan].push({ t: new Date().toLocaleTimeString(), y: br || 0 });
            if (telemetryCache[outChan].length > 60) telemetryCache[outChan].shift();
            
            ioInstance.emit('stats', {
                channel: outChan,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                history: telemetryCache[outChan]
            });
        }
    });

    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Output ${id} exited with code ${code}`);
        
        // Remove subscriber socket
        if (activeOutputs[id] && activeOutputs[id].tcpSocket) {
            activeOutputs[id].tcpSocket.destroy();
            if (activeInputs[channel] && activeInputs[channel].router) {
                activeInputs[channel].router.subscribers.delete(activeOutputs[id].tcpSocket);
            }
        }
        
        // Auto-Restart Logic
        if (!intentionalStop) {
            console.log(`[OUT-${id}] Connection lost or crashed. Auto-restarting target in 10s...`);
            if (activeOutputs[id] && activeOutputs[id].process === child) {
                activeOutputs[id].autoRestart = setTimeout(() => {
                    delete activeOutputs[id];
                    startOutput(outputObj);
                }, 10000);
            } else if (!activeOutputs[id]) {
                setTimeout(() => { startOutput(outputObj); }, 10000);
            }
        }
    });

    activeOutputs[id] = { process: child, localPort: localPort, parentChannel: channel, outputObj: outputObj, lastUpdate: Date.now() };
    return true;
}

function stopOutput(id) {
    if (activeOutputs[id]) {
        console.log(`[STOPPING OUTPUT ${id}] Killing process...`);
        if (activeOutputs[id].autoRestart) clearTimeout(activeOutputs[id].autoRestart);
        
        const { process, localPort, parentChannel } = activeOutputs[id];
        
        if (process) {
            if (typeof process.markIntentionalStop === 'function') {
                process.markIntentionalStop();
            }
            process.kill('SIGKILL');
        }
        
        if (activeOutputs[id].tcpSocket) {
            activeOutputs[id].tcpSocket.destroy();
            if (activeInputs[parentChannel] && activeInputs[parentChannel].router) {
                activeInputs[parentChannel].router.subscribers.delete(activeOutputs[id].tcpSocket);
            }
        }
        
        delete activeOutputs[id];
        return true;
    }
    return false;
}

// Global Heartbeat Monitor: Detect frozen input streams and push zero telemetry
setInterval(() => {
    const now = Date.now();
    for (const channel in activeInputs) {
        const inp = activeInputs[channel];
        if (inp && inp.lastUpdate && (now - inp.lastUpdate > 5000)) {
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            telemetryCache[channel].push({ t: new Date().toLocaleTimeString(), y: 0 });
            if (telemetryCache[channel].length > 60) telemetryCache[channel].shift();
            
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: channel,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--', 
                    active: true,
                    history: telemetryCache[channel]
                });
            }
            inp.lastUpdate = now; 
        }
    }
    
    // Heartbeat for Active Outputs
    for (const id in activeOutputs) {
        const outp = activeOutputs[id];
        const outChan = 'out_' + id;
        if (outp && outp.lastUpdate && (now - outp.lastUpdate > 5000)) {
            if (!telemetryCache[outChan]) telemetryCache[outChan] = [];
            telemetryCache[outChan].push({ t: new Date().toLocaleTimeString(), y: 0 });
            if (telemetryCache[outChan].length > 60) telemetryCache[outChan].shift();
            
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: outChan,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--', 
                    active: true,
                    history: telemetryCache[outChan]
                });
            }
            outp.lastUpdate = now;
        }
    }
}, 1000);

function getTotalBitrates() {
    let rx = 0;
    let tx = 0;
    for (const channel in activeInputs) {
        if (telemetryCache[channel] && telemetryCache[channel].length > 0) {
            rx += telemetryCache[channel][telemetryCache[channel].length - 1].y || 0;
        }
    }
    for (const id in activeOutputs) {
        const outChan = 'out_' + id;
        if (telemetryCache[outChan] && telemetryCache[outChan].length > 0) {
            tx += telemetryCache[outChan][telemetryCache[outChan].length - 1].y || 0;
        }
    }
    return { rx: (rx / 1000).toFixed(2), tx: (tx / 1000).toFixed(2) };
}

module.exports = {
    setIo,
    startInput,
    stopInput,
    startOutput,
    stopOutput,
    startPreview,
    stopPreview,
    getTotalBitrates,
    activeInputs,
    activeOutputs
};

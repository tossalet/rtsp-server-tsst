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
    const localUdpOut = `udp://127.0.0.1:${udpsrv}?pkt_size=1316&buffer_size=8388608`;

    // Base args: Read from URL
    const args = [
        '-hide_banner',
        '-y',
        '-fflags', '+genpts'
    ];

    // Forzar modo TCP para cámaras de vigilancia RTSP (evita artefactos)
    if (url.startsWith('rtsp://')) {
        args.push('-rtsp_transport', 'tcp');
    }

    args.push('-i', url);

    // Main Output: copy codec, output to local MPEG-TS UDP
    args.push('-map', '0:v?');
    args.push('-map', '0:a?');
    args.push('-c:v', 'copy');
    args.push('-c:a', 'aac');
    args.push('-b:a', '128k');
    if (url.startsWith('rtmp')) {
        args.push('-bsf:v', 'h264_mp4toannexb'); // Force bitstream conversion only for RTMP to avoid corrupting native SRT
    }
    args.push('-f', 'mpegts');
    args.push('-muxdelay', '0.1'); // Fix TS mux errors with missing audio/video sync
    args.push(localUdpOut);

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
        const bitrateMatch = out.match(/bitrate=\s*([a-zA-Z0-9.\/]+)/);
        const timeMatch = out.match(/time=([\d:.]+)/);
        
        if ((bitrateMatch || timeMatch) && ioInstance) {
            if (activeInputs[channel]) activeInputs[channel].lastUpdate = now;
            
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            let brText = bitrateMatch ? bitrateMatch[1] : '0.0kbits/s';
            if (brText.includes('N/A')) brText = 'VBR (N/A)';
            const br = parseFloat(brText) || 0;
            
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

    // Setup UDP Multiplexer in Node.js
    const router = dgram.createSocket('udp4');
    const sender = dgram.createSocket('udp4'); // DEDICATED TX SOCKET to prevent ICMP Error poisoning!
    router.subscribers = new Set();
    
    // Auto-tune sending buffer for the dedicated TX socket
    try { sender.setSendBufferSize(8388608); } catch(e){}

    // Recover existing active outputs if this is a restart
    for (const outId in activeOutputs) {
        if (activeOutputs[outId].parentChannel === channel) {
            router.subscribers.add(activeOutputs[outId].localPort);
            console.log(`[ROUTER] Re-linked orphan output ${outId} (port ${activeOutputs[outId].localPort}) to Input ${channel}`);
        }
    }
    
    // Bind to the udpsrv generated port to receive FFmpeg feed
    router.bind(udpsrv, '127.0.0.1', () => {
        try { router.setRecvBufferSize(8388608); } catch(e){} // 8MB buffer to prevent Node UDP packet drop
        console.log(`[ROUTER] Channel ${channel} bound on UDP ${udpsrv}`);
    });
    
    // Error boundary fatal para ENOBUFS en Raspberry
    router.on('error', (err) => {
        console.error(`[ROUTER ${channel}] UDP Socket Error (Kernel buffer full?):`, err.message);
    });

    // Multiplex payload to all subscribers using the isolated DEDICATED TX SOCKET
    // Highly optimized using empty fallback callback instead of try/catch to avoid V8 de-optimization
    const noop = () => {};
    router.on('message', (msg) => {
        for (const port of router.subscribers) {
            sender.send(msg, port, '127.0.0.1', noop);
        }
    });

    // Swallow async datagram errors
    router.on('error', (err) => {});
    sender.on('error', (err) => {
        // ICMP Port Unreachable errors land here cleanly, without poisoning the router RX loop!
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
            console.log(`[IN-${channel}] Connection lost or crashed. Auto-restarting in 3s...`);
            // Turn yellow in UI (we fake an active signal with 0 bitrate)
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
            
            // Si nadie reemplazó manualmente el activeInputs, usamos un timeout para reconectar
            if (activeInputs[channel] && activeInputs[channel].process === child) {
                activeInputs[channel].autoRestart = setTimeout(() => {
                    delete activeInputs[channel];
                    startInput(inputObj);
                }, 3000);
            } else if (!activeInputs[channel]) {
                setTimeout(() => { startInput(inputObj); }, 3000);
            }
        } else {
            // Intentional stop
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: false });
        }
    });

    activeInputs[channel] = { process: child, router: router, lastUpdate: Date.now(), inputObj: inputObj, isStopping: false, prevProcess: null, prevPort: null };
    
    // Start recurring poller or single grab
    if (inputObj.preview_enabled !== 0) {
        // Ejecución única inicial, y luego temporizador periódico sin dejar procesos zombis estancados en Linux
        startPreview(channel, true);
        activeInputs[channel].previewInterval = setInterval(() => {
            if (activeInputs[channel] && !activeInputs[channel].prevProcess) {
                startPreview(channel, true);
            }
        }, 5000);
    } else {
        // Grab a single snapshot frame even if preview is disabled
        startPreview(channel, true);
    }

    return true;
}

function startPreview(channel, singleFrame = false) {
    if (!activeInputs[channel] || !activeInputs[channel].router) return;
    if (activeInputs[channel].prevProcess) stopPreview(channel);

    const prevPort = 30000 + Math.floor(Math.random() * 30000);
    activeInputs[channel].prevPort = prevPort;
    activeInputs[channel].router.subscribers.add(prevPort);

    const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
    const ffmpegCmd = getFFmpegPath();
    const args = [
        '-hide_banner', '-y',
        '-skip_frame', 'nokey',
        '-i', `udp://127.0.0.1:${prevPort}?overrun_nonfatal=1`,
        '-map', '0:v?',
        '-frames:v', '1', '-q:v', '5', '-update', '1', '-f', 'image2', extPath
    ];

    const child = spawn(ffmpegCmd, args);
    activeInputs[channel].prevProcess = child;
    
    child.on('error', (err) => {
        console.error(`[PREVIEW ERROR CH-${channel}] Failed to run ffmpeg:`, err.message);
    });

    // Matar proceso después de 15 segundos si se queda colgado esperando un Keyframe lejano
    setTimeout(() => stopPreview(channel), 15000);

    child.on('close', () => {
        if (activeInputs[channel] && activeInputs[channel].router && activeInputs[channel].prevPort === prevPort) {
            activeInputs[channel].router.subscribers.delete(prevPort);
            if (activeInputs[channel].prevProcess === child) {
                activeInputs[channel].prevProcess = null;
            }
        }
    });
}

function stopPreview(channel) {
    const inp = activeInputs[channel];
    if (inp && inp.prevProcess) {
        inp.prevProcess.kill('SIGKILL');
        if (inp.router && inp.prevPort) inp.router.subscribers.delete(inp.prevPort);
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
        if (activeInputs[channel].previewInterval) clearInterval(activeInputs[channel].previewInterval);
        
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
    const localUdpIn = `udp://127.0.0.1:${localPort}?pkt_size=1316&buffer_size=8388608&overrun_nonfatal=1`;

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
        
        if (lastDot > lastSlash) {
            destUrl = destUrl.substring(0, lastDot) + '_' + df + destUrl.substring(lastDot);
        } else {
            destUrl += '_' + df + '.mp4';
        }

        if (destUrl.toLowerCase().endsWith('.ts')) format = 'mpegts';
        else if (destUrl.toLowerCase().endsWith('.mkv')) format = 'matroska';
        else format = 'mp4';
    }

    const vcodec = outputObj.vcodec || 'copy';

    const args = [
        '-hide_banner',
        '-y',
        '-fflags', '+genpts', // Critical for UDP to MP4 timebase
        '-i', localUdpIn
    ];
    
    if (vcodec === 'copy') {
        args.push('-c', 'copy');
    } else {
        args.push('-c:v', vcodec);
        args.push('-preset', 'ultrafast');
        args.push('-c:a', 'copy');
    }
    
    // Critical bitstream filter for AAC audio inside MP4 container from raw UDP streams
    if (format === 'mp4') {
        args.push('-bsf:a', 'aac_adtstoasc');
        args.push('-max_muxing_queue_size', '1024'); // Prevent FFmpeg hanging on thread queue
    }
    
    if (isDisk && format === 'mp4') {
        args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof'); // MP4 fragmentado rocoso
    }
    
    args.push('-f', format);
    args.push(destUrl);

    console.log(`[STARTING OUTPUT ${id}] ${ffmpegCmd} ${args.join(' ')}`);

    const child = spawn(ffmpegCmd, args);
    processStarted = true;
    
    // Subscribe this output ONLY IF ffmpeg survives the first 1.5 seconds.
    // If it dies early (e.g. bad remote RTMP) and we still subscribe, NodeJS floods a dead port causing Kernel ICMP Storms!
    setTimeout(() => {
        if (child.exitCode === null && activeInputs[channel] && activeInputs[channel].router) {
            activeInputs[channel].router.subscribers.add(localPort);
            console.log(`[OUT-${id}] Validated and successfully subscribed to local UDP ${localPort}`);
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
        const bitrateMatch = out.match(/bitrate=\s*([a-zA-Z0-9.\/]+)/);
        const timeMatch = out.match(/time=([\d:.]+)/);
        
        if ((bitrateMatch || timeMatch) && ioInstance) {
            const outChan = 'out_' + id;
            if (activeOutputs[id]) activeOutputs[id].lastUpdate = now;
            
            if (!telemetryCache[outChan]) telemetryCache[outChan] = [];
            let brText = bitrateMatch ? bitrateMatch[1] : '0.0kbits/s';
            if (brText.includes('N/A')) brText = 'VBR (N/A)';
            const br = parseFloat(brText) || 0;
            
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
        // Remove subscriber port
        if (activeInputs[channel] && activeInputs[channel].router) {
            activeInputs[channel].router.subscribers.delete(localPort);
        }
        
        // Auto-Restart Logic
        if (!intentionalStop) {
            console.log(`[OUT-${id}] Connection lost or crashed. Auto-restarting target...`);
            if (activeOutputs[id] && activeOutputs[id].process === child) {
                activeOutputs[id].autoRestart = setTimeout(() => {
                    delete activeOutputs[id];
                    startOutput(outputObj);
                }, 3000);
            } else if (!activeOutputs[id]) {
                setTimeout(() => { startOutput(outputObj); }, 3000);
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
        
        // Unsubscribe from router
        if (activeInputs[parentChannel] && activeInputs[parentChannel].router) {
            activeInputs[parentChannel].router.subscribers.delete(localPort);
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

module.exports = {
    setIo,
    startInput,
    stopInput,
    startOutput,
    stopOutput,
    startPreview,
    stopPreview,
    activeInputs,
    activeOutputs
};

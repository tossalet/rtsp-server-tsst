const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// In-memory store for active processes
const activeInputs = {};
const activeOutputs = {};
const telemetryCache = {};

// Distribución en memoria: cada canal tiene un "hub" (Set de stdin de FFmpeg).
// El input escribe por stdout (pipe) y Node reparte los chunks a los stdin de outputs/preview.
// Sin puertos TCP locales, sin timeouts de 1.5s y, al reiniciarse la cámara, los outputs
// siguen suscritos (antes se quedaban colgados en el router viejo y el SRT moría).
const hubs = {};
const MAX_SUB_BUFFER = 8 * 1024 * 1024; // 8MB: si un consumidor se atasca (p.ej. SRT listener sin caller) se descartan chunks
const INPUT_STALL_MS = 20000;           // Sin datos de la cámara durante 20s -> matar y reconectar
const RESTART_DELAY_MS = 5000;

function getHub(channel) {
    if (!hubs[channel]) hubs[channel] = new Set();
    return hubs[channel];
}

function subscribe(channel, stream) {
    const hub = getHub(channel);
    hub.add(stream);
    stream.on('error', () => hub.delete(stream)); // EPIPE cuando FFmpeg muere: no debe tumbar Node
    stream.on('close', () => hub.delete(stream));
}

function unsubscribe(channel, stream) {
    if (hubs[channel]) hubs[channel].delete(stream);
}

function broadcast(channel, chunk) {
    const hub = hubs[channel];
    if (!hub) return;
    for (const sub of hub) {
        if (sub.destroyed) { hub.delete(sub); continue; }
        if (sub.writableLength > MAX_SUB_BUFFER) continue; // consumidor lento: descartar en vez de acumular RAM
        sub.write(chunk);
    }
}

// Cierra stdin para que FFmpeg termine limpio (MP4/MKV con trailer); si no sale en 3s, SIGKILL
function killGracefully(child) {
    if (!child || child.exitCode !== null) return;
    try { child.stdin.end(); } catch (e) {}
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
}

// Locate FFmpeg binary (handles Windows local download vs Linux global). Se resuelve una sola vez.
let ffmpegPathCache = null;
function getFFmpegPath() {
    if (ffmpegPathCache) return ffmpegPathCache;
    ffmpegPathCache = 'ffmpeg'; // Linux / Docker
    if (os.platform() === 'win32') {
        const binDir = path.join(__dirname, 'ffmpeg_bin');
        if (fs.existsSync(binDir)) {
            // Find inner folder (like ffmpeg-7.0.2-essentials_build)
            for (const sub of fs.readdirSync(binDir)) {
                const exePath = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exePath)) { ffmpegPathCache = exePath; break; }
            }
        }
    }
    return ffmpegPathCache;
}

function pushTelemetry(key, kbps) {
    if (!telemetryCache[key]) telemetryCache[key] = [];
    telemetryCache[key].push({ t: new Date().toLocaleTimeString(), y: kbps || 0 });
    if (telemetryCache[key].length > 60) telemetryCache[key].shift(); // Keep last 60 points
    return telemetryCache[key];
}

/**
 * Start an Input Stream (RTSP pull, SRT, RTMP...)
 * FFmpeg remuxes to MPEG-TS on stdout and Node distributes it to the channel hub.
 */
function startInput(inputObj) {
    const { channel, url } = inputObj;
    const current = activeInputs[channel];
    if (current && current.process) {
        console.log(`Input ${channel} is already running.`);
        return;
    }
    if (current && current.autoRestart) clearTimeout(current.autoRestart);

    const args = ['-hide_banner', '-nostdin', '-fflags', '+genpts'];

    // Editable Buffer para entrada
    if (inputObj.buffer && inputObj.buffer > 0) {
        args.push('-buffer_size', `${inputObj.buffer}M`);
    }

    // Forzar modo TCP para cámaras de vigilancia RTSP (evita artefactos y cortes rápidos)
    if (url.startsWith('rtsp://')) {
        args.push('-rtsp_transport', 'tcp');
    }

    args.push('-i', url);
    args.push('-map', '0:v?', '-map', '0:a?');
    args.push('-c:v', 'copy');
    args.push('-c:a', 'aac', '-b:a', '128k'); // G.711 de cámaras no cabe en MPEG-TS: se pasa a AAC una sola vez aquí
    if (url.startsWith('rtmp')) {
        args.push('-bsf:v', 'h264_mp4toannexb'); // Force bitstream conversion only for RTMP to avoid corrupting native SRT
    }
    args.push('-f', 'mpegts');
    args.push('-muxdelay', '0.5', '-muxpreload', '0.5'); // Margen para que FFmpeg ordene los paquetes TS
    args.push('pipe:1');

    const ffmpegCmd = getFFmpegPath();
    console.log(`[STARTING INPUT ${channel}] ${ffmpegCmd} ${args.join(' ')}`);
    const child = spawn(ffmpegCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const state = {
        process: child,
        inputObj,
        lastUpdate: Date.now(),
        lastData: Date.now(),
        codec: current ? current.codec : '',
        intentionalStop: false,
        autoRestart: null,
        prevProcess: current ? current.prevProcess : null // la preview sobrevive a los reinicios del input
    };
    activeInputs[channel] = state;

    child.on('error', (err) => {
        console.error(`[FATAL IN-${channel}] FFmpeg missing or crashed:`, err.message);
    });

    child.stdout.on('data', (chunk) => {
        state.lastData = Date.now();
        broadcast(channel, chunk);
    });

    let lastParseTime = 0;
    let codecFound = false;

    child.stderr.on('data', (data) => {
        const out = data.toString();

        // Extraer codec en cuanto aparezca (suele estar en los primeros chunks)
        if (!codecFound) {
            const codecMatch = out.match(/Video:\s*([a-zA-Z0-9_-]+)/);
            if (codecMatch) {
                let parsedCodec = codecMatch[1].toUpperCase();
                if (parsedCodec === 'HEVC') parsedCodec = 'H.265';
                else if (parsedCodec === 'H264') parsedCodec = 'H.264';
                state.codec = parsedCodec;
                codecFound = true;
            }
        }

        const now = Date.now();
        // Solo analizamos estadísticas 2 veces por segundo para evitar saturar NodeJS
        if (now - lastParseTime < 500) return;
        lastParseTime = now;

        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);

        if (bitrateMatch && ioInstance) {
            state.lastUpdate = now;
            const brText = bitrateMatch[1];
            ioInstance.emit('stats', {
                channel: channel,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                codec: state.codec,
                history: pushTelemetry(channel, parseFloat(brText)) // Payload con curva precargada
            });
        }
    });

    if (!state.prevProcess || state.prevProcess.exitCode !== null) {
        startPreview(channel, inputObj.preview_enabled === 0);
    }

    child.on('close', (code) => {
        console.log(`Input ${channel} exited with code ${code}`);
        if (activeInputs[channel] !== state) return; // ya reemplazado o borrado por stopInput
        state.process = null;

        // Remove thumbnail so UI flips to TV Bars (la preview la regenerará al volver la señal)
        fs.unlink(path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`), () => {});

        if (state.intentionalStop) return;

        console.log(`[IN-${channel}] Connection lost or crashed. Auto-restarting in ${RESTART_DELAY_MS / 1000}s...`);
        // Turn yellow in UI (we fake an active signal with 0 bitrate)
        if (ioInstance) ioInstance.emit('stats', { channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
        state.autoRestart = setTimeout(() => {
            if (activeInputs[channel] === state) startInput(inputObj);
        }, RESTART_DELAY_MS);
    });

    return true;
}

function startPreview(channel, singleFrame = false) {
    const inp = activeInputs[channel];
    if (!inp) return;
    if (inp.prevProcess) stopPreview(channel);

    const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-skip_frame', 'nokey', // solo decodifica keyframes: coste de CPU mínimo
        '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:v?'
    ];
    if (singleFrame) args.push('-frames:v', '1');
    args.push('-update', '1', '-q:v', '5', '-f', 'image2', '-y', extPath);

    const child = spawn(getFFmpegPath(), args, { stdio: ['pipe', 'ignore', 'ignore'] });
    inp.prevProcess = child;
    subscribe(channel, child.stdin);

    child.on('error', (err) => {
        console.error(`[PREVIEW ERROR CH-${channel}] Failed to run ffmpeg:`, err.message);
    });
    child.on('close', () => {
        unsubscribe(channel, child.stdin);
        if (activeInputs[channel] && activeInputs[channel].prevProcess === child) activeInputs[channel].prevProcess = null;
    });

    // Seguridad: un snapshot que no consigue fotograma no puede quedarse vivo
    if (singleFrame) {
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 15000);
    }
}

function stopPreview(channel) {
    const inp = activeInputs[channel];
    if (inp && inp.prevProcess) {
        unsubscribe(channel, inp.prevProcess.stdin);
        inp.prevProcess.kill('SIGKILL');
        inp.prevProcess = null;
    }
}

/**
 * Stop an Input Stream
 */
function stopInput(channel) {
    const inp = activeInputs[channel];
    if (!inp) return false;
    console.log(`[STOPPING INPUT ${channel}] Killing process...`);
    inp.intentionalStop = true;
    if (inp.autoRestart) clearTimeout(inp.autoRestart);
    stopPreview(channel); // antes la preview quedaba huérfana y su socket podía tumbar Node
    if (inp.process) inp.process.kill('SIGKILL');
    delete activeInputs[channel];
    delete telemetryCache[channel];
    fs.unlink(path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`), () => {});
    if (ioInstance) ioInstance.emit('stats', { channel: channel, active: false });
    return true;
}

/**
 * Start an Output Stream
 * Reads the channel MPEG-TS from stdin and pushes it to the destination URL (SRT, RTMP, disk...).
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

    const isRtmp = url.startsWith('rtmp');
    const isDisk = url.startsWith('disk://');
    let format = 'mpegts';
    let destUrl = url;

    if (isRtmp) format = 'flv';
    if (isDisk) {
        destUrl = url.replace('disk://', '');

        // AUTO-TIMESTAMP TO PREVENT OVERWRITES: NombreInput_20260418_223500.mp4
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

    const vcodec    = outputObj.vcodec || 'copy';
    const isQSV     = vcodec.endsWith('_qsv');
    const isNVENC   = vcodec.endsWith('_nvenc');
    const isVAAPI   = vcodec.endsWith('_vaapi');
    const isHWCodec = isQSV || isNVENC || isVAAPI;

    const args = ['-hide_banner', '-y'];

    // VAAPI requires -vaapi_device BEFORE -i as a global option
    if (isVAAPI) args.push('-vaapi_device', '/dev/dri/renderD128');

    args.push('-fflags', '+genpts', '-thread_queue_size', '4096', '-f', 'mpegts', '-i', 'pipe:0');

    if (vcodec === 'copy') {
        args.push('-c', 'copy');
    } else if (isVAAPI) {
        // Intel VAAPI: CPU decodes → NV12 → hwupload to GPU → GPU encodes.
        // hwupload is MANDATORY. Intel UHD 630 only supports CQP: -qp instead of -b:v.
        console.log(`[HW-ACCEL] VAAPI encode: CPU→${vcodec} via /dev/dri/renderD128 (CQP mode)`);
        args.push('-vf', 'format=nv12,hwupload');
        args.push('-c:v', vcodec, '-qp', '23', '-g', '50');
        args.push('-c:a', 'copy'); // el audio ya es AAC desde el input
    } else if (isNVENC || isQSV) {
        // NVIDIA NVENC / Intel QSV (CPU decodes, GPU encodes)
        console.log(`[HW-ACCEL] ${isNVENC ? 'NVENC' : 'QSV'} encode: CPU→${vcodec}`);
        args.push('-c:v', vcodec, '-b:v', '4M', '-g', '50');
        args.push('-c:a', 'copy');
    } else {
        args.push('-c:v', vcodec);
        args.push('-preset', 'ultrafast');
        args.push('-crf', '23');
        args.push('-g', '25');         // Force keyframe every 25 frames
        args.push('-sc_threshold', '0'); // Disable scene-change keyframes
        args.push('-c:a', 'copy'); // el audio ya es AAC desde el input
    }

    args.push('-max_muxing_queue_size', '9999'); // Prevenir hangs del ffmpeg en la cola de muxing

    // Critical bitstream filter for AAC audio inside MP4 container from MPEG-TS
    if (format === 'mp4' || format === 'hls' || format === 'flv') {
        args.push('-bsf:a', 'aac_adtstoasc');
    } else if (format === 'mpegts') {
        // Delay y preload a 500ms para garantizar un pacing (PCR) correcto hacia vMix/Race Control
        args.push('-muxdelay', '0.5', '-muxpreload', '0.5');
    }

    if (isDisk && format === 'mp4') {
        args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof'); // MP4 fragmentado: legible aunque se corte
    }

    if (format === 'hls') {
        args.push('-hls_time', '2');       // 2s segments = faster live edge
        args.push('-hls_list_size', '0'); // Keep all segments for replay
        args.push('-hls_segment_type', 'mpegts');
    }
    args.push('-f', format, destUrl);

    const ffmpegCmd = getFFmpegPath();
    console.log(`[STARTING OUTPUT ${id}] ${ffmpegCmd} ${args.join(' ')}`);
    const child = spawn(ffmpegCmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    subscribe(channel, child.stdin);

    const state = { process: child, parentChannel: channel, outputObj, lastUpdate: Date.now(), intentionalStop: false, autoRestart: null };
    activeOutputs[id] = state;

    child.on('error', (err) => {
        console.error(`[FATAL OUT-${id}] FFmpeg missing or crashed:`, err.message);
    });

    // HW codecs: log every non-progress line for the first 20s so GPU errors are visible.
    // Then (and for SW codecs) only parse bitrate metrics for UI telemetry, throttled to 2/s
    const hwStartTime = Date.now();
    let lastParseTime = 0;
    const outChan = 'out_' + id;

    child.stderr.on('data', (data) => {
        const now = Date.now();
        const out = data.toString();

        if (isHWCodec && (now - hwStartTime) < 20000) {
            out.split('\n').forEach(line => {
                const l = line.trim();
                if (l && !l.startsWith('frame=') && !l.startsWith('fps=') && !l.startsWith('size=')) {
                    console.log(`[OUT-${id}][HW] ${l}`);
                }
            });
        }

        if (now - lastParseTime < 500) return;
        lastParseTime = now;

        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);

        if (bitrateMatch && ioInstance) {
            state.lastUpdate = now;
            const brText = bitrateMatch[1];
            ioInstance.emit('stats', {
                channel: outChan,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                history: pushTelemetry(outChan, parseFloat(brText))
            });
        }
    });

    child.on('close', (code) => {
        console.log(`Output ${id} exited with code ${code}`);
        unsubscribe(channel, child.stdin);
        if (activeOutputs[id] !== state || state.intentionalStop) return;

        console.log(`[OUT-${id}] Connection lost or crashed. Auto-restarting target in 10s...`);
        state.autoRestart = setTimeout(() => {
            if (activeOutputs[id] !== state) return;
            delete activeOutputs[id];
            startOutput(outputObj);
        }, 10000);
    });

    return true;
}

function stopOutput(id) {
    const outp = activeOutputs[id];
    if (!outp) return false;
    console.log(`[STOPPING OUTPUT ${id}] Stopping process...`);
    outp.intentionalStop = true;
    if (outp.autoRestart) clearTimeout(outp.autoRestart);
    if (outp.process) {
        unsubscribe(outp.parentChannel, outp.process.stdin);
        killGracefully(outp.process);
    }
    delete activeOutputs[id];
    delete telemetryCache['out_' + id];
    return true;
}

// Elimina el hub de un canal borrado
function removeChannel(channel) {
    stopInput(channel);
    delete hubs[channel];
}

// Global Heartbeat Monitor: detect frozen streams, push zero telemetry and kill stalled inputs
setInterval(() => {
    const now = Date.now();
    for (const channel in activeInputs) {
        const inp = activeInputs[channel];

        // Watchdog: cámara colgada sin cerrar la conexión -> FFmpeg bloqueado para siempre. Lo matamos y se reconecta.
        if (inp.process && now - inp.lastData > INPUT_STALL_MS) {
            console.log(`[IN-${channel}] Sin datos durante ${INPUT_STALL_MS / 1000}s. Forzando reconexión...`);
            inp.lastData = now;
            inp.process.kill('SIGKILL');
        }

        if (now - inp.lastUpdate > 5000) {
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: channel,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--',
                    active: true,
                    history: pushTelemetry(channel, 0)
                });
            }
            inp.lastUpdate = now;
        }
    }

    for (const id in activeOutputs) {
        const outp = activeOutputs[id];
        if (now - outp.lastUpdate > 5000) {
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: 'out_' + id,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--',
                    active: true,
                    history: pushTelemetry('out_' + id, 0)
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
        const h = telemetryCache[channel];
        if (h && h.length > 0) rx += h[h.length - 1].y || 0;
    }
    for (const id in activeOutputs) {
        const h = telemetryCache['out_' + id];
        if (h && h.length > 0) tx += h[h.length - 1].y || 0;
    }
    return { rx: (rx / 1000).toFixed(2), tx: (tx / 1000).toFixed(2) };
}

// Al parar el servicio (systemd/docker) cerrar los FFmpeg para no dejar procesos huérfanos
function shutdown() {
    for (const id in activeOutputs) stopOutput(id);
    for (const channel in activeInputs) stopInput(channel);
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = {
    setIo,
    startInput,
    stopInput,
    startOutput,
    stopOutput,
    startPreview,
    stopPreview,
    removeChannel,
    getTotalBitrates,
    activeInputs,
    activeOutputs
};

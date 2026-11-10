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
// Contadores para /metrics (Prometheus). Se mantienen aunque el proceso se reinicie.
const counters = { inputBytes: {}, inputRestarts: {}, outputRestarts: {} };
const inputRate = {}; // canal -> bits/s medidos en Node (último segundo)

// Distribución en memoria: cada canal tiene un "hub" (Set de stdin de FFmpeg).
// El input escribe por stdout (pipe) y Node reparte los chunks a los stdin de outputs/preview.
// Sin puertos TCP locales, sin timeouts de 1.5s y, al reiniciarse la cámara, los outputs
// siguen suscritos (antes se quedaban colgados en el router viejo y el SRT moría).
const hubs = {};
// Control de consumidores lentos. Descartar datos de un receptor ACTIVO corrompe la imagen (macrobloques)
// hasta el siguiente keyframe, así que los atascos breves se absorben en RAM sin perder nada.
// Solo se descarta cuando el consumidor lleva >3s sin vaciar (p.ej. listener SRT esperando a Race Control),
// y entonces con un tope pequeño para que al conectar no reciba segundos de vídeo viejo.
const SUB_LOW_WATER = 256 * 1024;            // por debajo: consumidor al día
const SUB_STUCK_MS = 3000;                   // sin bajar de LOW_WATER durante 3s = parado
const MAX_SUB_BUFFER = 32 * 1024 * 1024;     // atasco breve: hasta 32MB sin descartar
const MAX_STUCK_BUFFER = 1 * 1024 * 1024;    // parado: tope 1MB
const INPUT_STALL_MS = 20000;           // Sin datos de la cámara durante 20s -> matar y reconectar
const RESTART_DELAY_MS = 5000;
const OUTPUT_RESTART_MS = 2000;         // Listener SRT: reabrir rápido para que Race Control pueda reconectar
const OUTPUT_FAIL_RESTART_MS = 10000;   // Si FFmpeg muere nada más arrancar (URL mala, puerto ocupado) no machacar
const LISTENER_RESTART_MS = 1000;       // Input SRT listener: reabrir rápido para que el emisor pueda reconectar

// Input SRT en modo listener: el servidor espera a que el emisor (vMix, codificador...) se conecte
function isSrtListener(url) {
    return typeof url === 'string' && url.startsWith('srt://') && /[?&]mode=listener/.test(url);
}

// FFmpeg/libsrt espera latency, rcvlatency y peerlatency en MICROSEGUNDOS (por defecto 120ms).
// Un valor < 1000 casi seguro se escribió pensando en ms (latency=200 serían 0.2ms -> pérdidas): se convierte.
// Sin latency en la URL libsrt usa 120 ms, poco para estas redes (macrobloques): se pone 500 ms por defecto.
const DEFAULT_SRT_LATENCY_US = 500000;
function normalizeSrtUrl(url) {
    if (!url.startsWith('srt://')) return url;
    if (!/[?&]latency=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'latency=' + DEFAULT_SRT_LATENCY_US;
    return url.replace(/([?&](?:latency|rcvlatency|peerlatency)=)(\d+)/g, (m, key, val) => {
        const n = parseInt(val, 10);
        if (n > 0 && n < 1000) {
            console.log(`[SRT] ${key.slice(1, -1)}=${n} interpretado como ms -> ${n * 1000} µs`);
            return key + (n * 1000);
        }
        return m;
    });
}

// rtsp://usuario:clave@ip -> rtsp://***@ip para que las contraseñas de las cámaras no acaben en el log
function maskCredentials(text) {
    return text
        .replace(/(\w+:\/\/)[^\s\/]*@/g, '$1***@') // codicioso: hasta la última @ (claves con @)
        .replace(/(passphrase=)[^&\s]+/g, '$1***'); // clave de cifrado SRT
}

// Guarda las últimas líneas de error de FFmpeg (sin progreso) para mostrarlas si el proceso muere
function makeStderrTail(size = 6) {
    const lines = [];
    return {
        push(text) {
            for (const raw of text.split(/\r?\n|\r/)) {
                const l = raw.trim();
                if (!l || /^(frame|fps|size|stream_\d|bitrate|progress)=/.test(l) || l.startsWith('frame=')) continue;
                lines.push(l);
                if (lines.length > size) lines.shift();
            }
        },
        text() { return lines.join(' | '); }
    };
}

function getHub(channel) {
    if (!hubs[channel]) hubs[channel] = new Set();
    return hubs[channel];
}

function subscribe(channel, stream, label) {
    const hub = getHub(channel);
    stream._label = label; // null = no avisar de descartes
    stream._lowAt = Date.now();
    stream._dropped = 0;
    stream._dropLogAt = 0;
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
    const now = Date.now();
    for (const sub of hub) {
        if (sub.destroyed) { hub.delete(sub); continue; }
        const queued = sub.writableLength;
        if (queued < SUB_LOW_WATER) sub._lowAt = now;
        const stuck = now - sub._lowAt > SUB_STUCK_MS;
        if (queued > (stuck ? MAX_STUCK_BUFFER : MAX_SUB_BUFFER)) {
            // Un receptor parado (esperando conexión) descarta sin avisar: es lo normal.
            // Un receptor activo que no da abasto sí se avisa: es causa directa de macrobloques.
            if (!stuck && sub._label) {
                sub._dropped += chunk.length;
                if (now - sub._dropLogAt > 10000) {
                    sub._dropLogAt = now;
                    console.error(`[CH-${channel}] ${sub._label} no da abasto: descartados ${Math.round(sub._dropped / 1024)} KB (imagen con macrobloques)`);
                    sub._dropped = 0;
                }
            }
            continue;
        }
        sub.write(chunk);
    }
}

// Cierra stdin para que FFmpeg termine limpio (MP4/MKV con trailer); si no sale en 3s, SIGKILL
function killGracefully(child) {
    if (!child || child.exitCode !== null) return;
    try { child.stdin.end(); } catch (e) {}
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000);
}

// Procesos parados que aún no han terminado de cerrarse. Al reiniciar (editar una entrada o salida) el FFmpeg nuevo
// espera a que el viejo suelte el puerto: si no, el listener SRT nuevo no podía abrirlo y quedaba ~10 s sin señal.
const exiting = { input: {}, output: {} };
const pendingStart = { input: {}, output: {} };
function trackExit(kind, key, child) {
    exiting[kind][key] = child;
    child.once('close', () => {
        if (exiting[kind][key] !== child) return;
        delete exiting[kind][key];
        const obj = pendingStart[kind][key];
        delete pendingStart[kind][key];
        if (obj) (kind === 'input' ? startInput : startOutput)(obj);
    });
}
// true si hay que esperar: el arranque se hará solo al cerrarse el proceso anterior
function deferStart(kind, key, obj) {
    if (!exiting[kind][key]) return false;
    pendingStart[kind][key] = obj;
    return true;
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
    if (deferStart('input', channel, inputObj)) return true;

    const args = ['-hide_banner', '-nostdin', '-fflags', '+genpts'];

    // Editable Buffer para entrada
    if (inputObj.buffer && inputObj.buffer > 0) {
        args.push('-buffer_size', `${inputObj.buffer}M`);
    }

    // Forzar modo TCP para cámaras de vigilancia RTSP (evita artefactos y cortes rápidos)
    if (url.startsWith('rtsp://')) {
        args.push('-rtsp_transport', 'tcp');
    }

    // Latencia editable (ms, 0 = automático). SRT: buffer de recuperación de paquetes (sustituye al de la URL).
    // RTSP: margen de demux/reordenación para absorber llegadas irregulares de la cámara.
    let inputUrl = url;
    const latencyMs = parseInt(inputObj.latency_ms, 10) || 0;
    if (latencyMs > 0) {
        if (url.startsWith('srt://')) {
            inputUrl = /[?&]latency=\d+/.test(url)
                ? url.replace(/([?&]latency=)\d+/, `$1${latencyMs * 1000}`)
                : url + (url.includes('?') ? '&' : '?') + `latency=${latencyMs * 1000}`;
        } else if (url.startsWith('rtsp://')) {
            args.push('-max_delay', String(latencyMs * 1000));
        }
    }

    args.push('-i', normalizeSrtUrl(inputUrl));
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
    console.log(`[STARTING INPUT ${channel}] ${ffmpegCmd} ${maskCredentials(args.join(' '))}`);
    const child = spawn(ffmpegCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errTail = makeStderrTail();

    const state = {
        process: child,
        inputObj,
        lastUpdate: Date.now(),
        lastData: Date.now(),
        startedAt: Date.now(),
        gotData: false,
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
        state.gotData = true;
        state.lastData = Date.now();
        counters.inputBytes[channel] = (counters.inputBytes[channel] || 0) + chunk.length;
        broadcast(channel, chunk);
    });

    let lastParseTime = 0;
    let codecFound = false;

    child.stderr.on('data', (data) => {
        const out = data.toString();
        errTail.push(out);

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

        if (code !== 0) console.error(`[IN-${channel}] FFmpeg: ${maskCredentials(errTail.text()) || 'sin detalle'}`);
        // Listener: si el emisor llegó a conectar, lo normal es que se haya ido y vuelva pronto; si murió
        // nada más arrancar (puerto ocupado, URL mala) no machacar.
        const listener = isSrtListener(url);
        const restartMs = listener && Date.now() - state.startedAt > 5000 ? LISTENER_RESTART_MS : RESTART_DELAY_MS;
        console.log(`[IN-${channel}] ${listener ? 'Emisor SRT desconectado' : 'Connection lost or crashed'}. Auto-restarting in ${restartMs / 1000}s...`);
        // Turn yellow in UI (we fake an active signal with 0 bitrate)
        if (ioInstance) ioInstance.emit('stats', { channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
        counters.inputRestarts[channel] = (counters.inputRestarts[channel] || 0) + 1;
        state.autoRestart = setTimeout(() => {
            if (activeInputs[channel] === state) startInput(inputObj);
        }, restartMs);
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
    subscribe(channel, child.stdin, null); // miniatura: si se retrasa da igual perder datos, no se avisa

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

/* =======================================
 *  HLS DEL PANEL (vídeo en vivo, bajo demanda)
 * =======================================
 * Pedir la lista .m3u8 arranca el HLS del canal (o lo mantiene vivo). Lo comparten todos los
 * que miran ese canal y se para a los 15 s sin peticiones. -c copy: sin recodificar, CPU casi nula.
 * Los trozos van a RAM (/dev/shm en Linux) para no desgastar el disco del mini PC.
 */
const HLS_DIR = (process.platform === 'linux' && fs.existsSync('/dev/shm'))
    ? '/dev/shm/tsst-hls'
    : path.join(os.tmpdir(), 'tsst-hls');
const HLS_IDLE_MS = 15000;
const hlsProcs = {}; // canal -> { proc, dir, at }
try { fs.rmSync(HLS_DIR, { recursive: true, force: true }); } catch (e) {} // restos de un arranque anterior

// Devuelve la carpeta de la lista, o null si el canal no está activo
function ensureHls(channel) {
    if (!activeInputs[channel]) return null;
    let h = hlsProcs[channel];
    if (h) { h.at = Date.now(); return h.dir; }

    const dir = path.join(HLS_DIR, String(channel));
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch (e) { return null; }
    const args = [
        '-hide_banner', '-nostats', '-loglevel', 'error',
        '-fflags', '+genpts', '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
        // Con copy cada trozo empieza en un keyframe: dura lo que el GOP de la cámara aunque pidamos 1 s
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '4',
        '-hls_flags', 'delete_segments+omit_endlist+temp_file',
        '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
        path.join(dir, 'index.m3u8')
    ];
    const child = spawn(getFFmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    h = hlsProcs[channel] = { proc: child, dir, at: Date.now() };
    subscribe(channel, child.stdin, null); // solo visualización: si va tarde no se avisa
    const errTail = makeStderrTail();
    child.stderr.on('data', d => errTail.push(d.toString()));
    child.on('error', () => {});
    child.on('close', (code) => {
        unsubscribe(channel, child.stdin);
        if (hlsProcs[channel] !== h) return;
        delete hlsProcs[channel]; // la siguiente petición de la lista lo vuelve a arrancar
        if (code) console.log(`[HLS-${channel}] FFmpeg terminó (${code}). ${errTail.text()}`);
    });
    console.log(`[HLS-${channel}] Vídeo en vivo para el panel (copia, sin recodificar)`);
    return dir;
}

function stopHls(channel) {
    const h = hlsProcs[channel];
    if (!h) return;
    delete hlsProcs[channel];
    unsubscribe(channel, h.proc.stdin);
    h.proc.kill('SIGKILL');
    fs.promises.rm(h.dir, { recursive: true, force: true }).catch(() => {});
}

// Nadie mira (ventana o pestaña cerrada): se para
setInterval(() => {
    const now = Date.now();
    for (const channel in hlsProcs) if (now - hlsProcs[channel].at > HLS_IDLE_MS) stopHls(channel);
}, 5000).unref();

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
    stopHls(channel);
    delete pendingStart.input[channel];
    if (inp.process) {
        trackExit('input', channel, inp.process);
        inp.process.kill('SIGKILL');
    }
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
    if (deferStart('output', id, outputObj)) return true;

    // Check if input stream is alive (o a punto de arrancar en cuanto se cierre su proceso anterior)
    if (!activeInputs[channel] && !pendingStart.input[channel]) {
        console.log(`Cannot start Output ${id}: Input ${channel} is offline.`);
        return; // Will stay disabled until input connects
    }

    const isRtmp = url.startsWith('rtmp');
    const isDisk = url.startsWith('disk://');
    let format = 'mpegts';
    let destUrl = normalizeSrtUrl(url);

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
    console.log(`[STARTING OUTPUT ${id}] ${ffmpegCmd} ${maskCredentials(args.join(' '))}`);
    const child = spawn(ffmpegCmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    subscribe(channel, child.stdin, `salida ${id} (${maskCredentials(url)})`);
    const errTail = makeStderrTail();

    const state = { process: child, parentChannel: channel, outputObj, startedAt: Date.now(), lastUpdate: Date.now(), intentionalStop: false, autoRestart: null };
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
        errTail.push(out);

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

        // Muerte inmediata = fallo de configuración (puerto ocupado, URL mala): esperar más y enseñar el error.
        // Si llevaba un rato, lo normal es que el receptor (Race Control) se haya desconectado: reabrir rápido.
        const failedFast = Date.now() - state.startedAt < 5000;
        const delay = failedFast ? OUTPUT_FAIL_RESTART_MS : OUTPUT_RESTART_MS;
        if (failedFast) console.error(`[OUT-${id}] FFmpeg: ${maskCredentials(errTail.text()) || 'sin detalle'}`);
        console.log(`[OUT-${id}] Receptor desconectado o fallo. Reiniciando salida en ${delay / 1000}s...`);
        counters.outputRestarts[id] = (counters.outputRestarts[id] || 0) + 1;
        state.autoRestart = setTimeout(() => {
            if (activeOutputs[id] !== state) return;
            delete activeOutputs[id];
            startOutput(outputObj);
        }, delay);
    });

    return true;
}

function stopOutput(id) {
    const outp = activeOutputs[id];
    if (!outp) return false;
    console.log(`[STOPPING OUTPUT ${id}] Stopping process...`);
    outp.intentionalStop = true;
    if (outp.autoRestart) clearTimeout(outp.autoRestart);
    delete pendingStart.output[id];
    if (outp.process && outp.process.exitCode === null) {
        unsubscribe(outp.parentChannel, outp.process.stdin);
        trackExit('output', id, outp.process);
        // Solo la grabación a disco necesita cierre limpio (trailer); SRT/UDP/RTMP se cortan al instante
        if (outp.outputObj.url.startsWith('disk://')) killGracefully(outp.process);
        else outp.process.kill('SIGKILL');
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
let lastRateAt = Date.now();
const lastBytes = {};
setInterval(() => {
    const now = Date.now();
    // Bitrate de entrada medido en Node (más fiable que el de FFmpeg y gratis: ya contamos los bytes)
    const dt = (now - lastRateAt) / 1000;
    lastRateAt = now;
    for (const channel in counters.inputBytes) {
        const b = counters.inputBytes[channel];
        inputRate[channel] = dt > 0 ? ((b - (lastBytes[channel] || 0)) * 8) / dt : 0;
        lastBytes[channel] = b;
    }
    for (const channel in activeInputs) {
        const inp = activeInputs[channel];

        // Watchdog: cámara colgada sin cerrar la conexión -> FFmpeg bloqueado para siempre. Lo matamos y se reconecta.
        // Un listener SRT sin emisor conectado no está colgado: simplemente espera.
        const waitingForSender = isSrtListener(inp.inputObj.url) && !inp.gotData;
        if (inp.process && !waitingForSender && now - inp.lastData > INPUT_STALL_MS) {
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

// Estado para /metrics. Solo se calcula cuando Prometheus lo pide.
function getMetricsSnapshot() {
    const lastKbps = key => { const h = telemetryCache[key]; return h && h.length ? h[h.length - 1].y || 0 : 0; };
    const inputs = Object.keys(activeInputs).map(channel => {
        const inp = activeInputs[channel];
        return {
            channel,
            running: !!inp.process,
            signal: !!inp.process && Date.now() - inp.lastData < 3000,
            bitrateBps: inputRate[channel] || 0,
            bytesTotal: counters.inputBytes[channel] || 0,
            restarts: counters.inputRestarts[channel] || 0,
            protocol: (inp.inputObj.url.match(/^(\w+):/) || [])[1] || 'otro',
            hlsViewing: !!hlsProcs[channel]
        };
    });
    const outputs = Object.keys(activeOutputs).map(id => {
        const o = activeOutputs[id];
        return {
            id, channel: o.parentChannel,
            running: !!o.process && o.process.exitCode === null,
            bitrateBps: lastKbps('out_' + id) * 1000,
            restarts: counters.outputRestarts[id] || 0,
            protocol: (o.outputObj.url.match(/^(\w+):/) || [])[1] || 'otro',
            vcodec: o.outputObj.vcodec || 'copy'
        };
    });
    return { inputs, outputs, hlsActive: Object.keys(hlsProcs).length };
}

// Al parar el servicio (systemd/docker) cerrar los FFmpeg para no dejar procesos huérfanos
function shutdown() {
    for (const channel in hlsProcs) stopHls(channel);
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
    getMetricsSnapshot,
    ensureHls,
    HLS_DIR,
    activeInputs,
    activeOutputs
};

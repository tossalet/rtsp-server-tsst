/**
 * CONSUMO REAL DE CADA PROCESO FFMPEG (CPU y GPU Intel), sin instalar nada.
 *
 * - CPU: tiempo de CPU de /proc/<pid>/stat entre dos lecturas.
 * - GPU: el driver i915 (y xe) apunta en /proc/<pid>/fdinfo/<fd> los nanosegundos que cada proceso
 *   ocupa cada motor: render (escalado/conversión), video (decodificar y codificar H.264/H.265),
 *   video-enhance (VPP). Es lo mismo que enseña intel_gpu_top, por proceso.
 *
 * Solo Linux (el mini PC). En otros sistemas no mide nada. Se muestrea cada 2 s y solo si hay
 * alguien mirando el panel: leer unos pocos ficheros de /proc cuesta prácticamente cero.
 */
const fs = require('fs');
const os = require('os');

const TICK_HZ = 100; // USER_HZ en Linux
const CORES = os.cpus().length || 1;
const SUPPORTED = process.platform === 'linux';

const prev = new Map(); // pid -> { t, cpuTicks, engines: { name: ns } }

function readCpuTicks(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return parseInt(f[11], 10) + parseInt(f[12], 10); // utime + stime (campos 14 y 15)
    } catch (e) { return null; }
}

// Suma por motor de los clientes DRM del proceso (varios fd pueden ser el mismo cliente: drm-client-id)
function readGpuEngines(pid) {
    const engines = {};
    const capacity = {};
    let dir;
    try { dir = fs.readdirSync(`/proc/${pid}/fdinfo`); } catch (e) { return null; }
    const seen = new Set();
    for (const fd of dir) {
        let txt;
        try { txt = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'); } catch (e) { continue; }
        if (!/drm-driver:\s*(i915|xe)/.test(txt)) continue;
        const id = (txt.match(/drm-client-id:\s*(\d+)/) || [])[1];
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        for (const m of txt.matchAll(/drm-engine-([\w-]+):\s*(\d+)\s*ns/g)) {
            engines[m[1]] = (engines[m[1]] || 0) + Number(m[2]);
        }
        for (const m of txt.matchAll(/drm-engine-capacity-([\w-]+):\s*(\d+)/g)) capacity[m[1]] = Number(m[2]);
    }
    return { engines, capacity };
}

// Devuelve { cpu, gpu: { render, video, enhance, max } } en % (CPU respecto al equipo entero)
function sample(pid, now) {
    const cpuTicks = readCpuTicks(pid);
    if (cpuTicks === null) { prev.delete(pid); return null; }
    const g = readGpuEngines(pid) || { engines: {}, capacity: {} };
    const p = prev.get(pid);
    prev.set(pid, { t: now, cpuTicks, engines: g.engines });
    if (!p) return null; // primera lectura: hace falta otra para tener consumo
    const dt = (now - p.t) / 1000;
    if (dt <= 0) return null;
    const cpu = ((cpuTicks - p.cpuTicks) / TICK_HZ) / dt / CORES * 100;
    const pct = name => {
        if (g.engines[name] === undefined || p.engines[name] === undefined) return 0;
        const cap = g.capacity[name] || 1;
        return Math.min(100, (g.engines[name] - p.engines[name]) / (dt * 1e9 * cap) * 100);
    };
    const gpu = { render: pct('render'), video: pct('video'), enhance: pct('video-enhance') };
    gpu.max = Math.max(gpu.render, gpu.video, gpu.enhance);
    return { cpu, gpu };
}

const round = x => Math.round(x * 10) / 10;
const addGpu = (a, b) => ({ render: a.render + b.render, video: a.video + b.video, enhance: a.enhance + b.enhance });

/**
 * procesos: [{ kind: 'input'|'preview'|'hls'|'output', key, channel?, pid, pipeline?, scaleTo? }]
 * Resultado: { supported, cores, outputs: { id: {...} }, channels: { canal: {...} }, total: {...} }
 */
function collect(processes) {
    if (!SUPPORTED) return { supported: false };
    const now = Date.now();
    const zero = () => ({ cpu: 0, gpu: { render: 0, video: 0, enhance: 0 } });
    const outputs = {}, channels = {}, total = zero();
    const alive = new Set();
    for (const p of processes) {
        alive.add(p.pid);
        const s = sample(p.pid, now);
        if (!s) continue;
        const ch = p.kind === 'output' ? p.channel : p.key;
        const c = channels[ch] || (channels[ch] = zero());
        c.cpu += s.cpu; c.gpu = addGpu(c.gpu, s.gpu);
        total.cpu += s.cpu; total.gpu = addGpu(total.gpu, s.gpu);
        if (p.kind === 'output') {
            outputs[p.key] = { cpu: round(s.cpu), gpu: round(s.gpu.max), gpuDetail: { render: round(s.gpu.render), video: round(s.gpu.video), enhance: round(s.gpu.enhance) },
                pipeline: p.pipeline, scaleTo: p.scaleTo };
        } else if (p.kind === 'input') {
            c.inputCpu = round(s.cpu);
        }
    }
    for (const pid of prev.keys()) if (!alive.has(pid)) prev.delete(pid);
    const cap = x => round(Math.min(100, x)); // varios procesos en el mismo motor no pasan del 100 %
    const fin = c => ({ cpu: round(c.cpu), gpu: cap(Math.max(c.gpu.render, c.gpu.video, c.gpu.enhance)),
        gpuDetail: { render: cap(c.gpu.render), video: cap(c.gpu.video), enhance: cap(c.gpu.enhance) }, inputCpu: c.inputCpu });
    for (const ch in channels) channels[ch] = fin(channels[ch]);
    return { supported: true, cores: CORES, outputs, channels, total: fin(total) };
}

// GPU Intel desde /sys (i915): modelo y frecuencia actual / máxima. null si no hay GPU Intel.
const INTEL_MODELS = { '3e92': 'UHD Graphics 630', '3e91': 'UHD Graphics 630', '3e98': 'UHD Graphics 630', '3e9b': 'UHD Graphics 630',
    '9bc5': 'UHD Graphics 630', '9bc8': 'UHD Graphics 630', '5912': 'HD Graphics 630', '3e93': 'UHD Graphics 610', '9ba8': 'UHD Graphics 610' };
let gpuCard; // ruta /sys/class/drm/cardN, buscada una vez
function findGpuCard() {
    if (gpuCard !== undefined) return gpuCard;
    gpuCard = null;
    try {
        for (const c of fs.readdirSync('/sys/class/drm').filter(n => /^card\d+$/.test(n))) {
            const base = `/sys/class/drm/${c}`;
            if (fs.readFileSync(`${base}/device/vendor`, 'utf8').trim() === '0x8086') { gpuCard = base; break; }
        }
    } catch (e) {}
    return gpuCard;
}
function readNum(p) { try { return parseInt(fs.readFileSync(p, 'utf8'), 10); } catch (e) { return null; } }
function gpuInfo() {
    if (!SUPPORTED) return null;
    const base = findGpuCard();
    if (!base) return null;
    let id = '';
    try { id = fs.readFileSync(`${base}/device/device`, 'utf8').trim().replace(/^0x/, '').toLowerCase(); } catch (e) {}
    return {
        model: 'Intel ' + (INTEL_MODELS[id] || `GPU (${id || '?'})`),
        freq: readNum(`${base}/gt_act_freq_mhz`) ?? readNum(`${base}/gt_cur_freq_mhz`),
        freqMax: readNum(`${base}/gt_max_freq_mhz`) ?? readNum(`${base}/gt_RP0_freq_mhz`)
    };
}

module.exports = { collect, gpuInfo, readGpuEngines, readCpuTicks, SUPPORTED };

/**
 * MÉTRICAS PROMETHEUS (GET /metrics, formato de texto 0.0.4)
 *
 * Solo responde a peticiones de la propia máquina (Prometheus corre en el mini PC). Para leerlas
 * desde otro equipo, definir METRICS_TOKEN y enviar "Authorization: Bearer <token>".
 * No cuesta nada si nadie lo pide: todo se calcula en el momento de la petición.
 *
 * Nombres compatibles con el proyecto SRT server (tsst_*), así su panel de Grafana sirve aquí.
 * Las etiquetas nunca llevan la URL (puede llevar contraseña o passphrase).
 */
const crypto = require('crypto');
const si = require('systeminformation');
const { monitorEventLoopDelay } = require('perf_hooks');
const db = require('./db');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const { version } = require('./package.json');

const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
const startedAt = Date.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

// Una petición reenviada por un proxy local también viene de 127.0.0.1: esa no cuenta como local
function isLocalRequest(req) {
    const ip = req.socket.remoteAddress;
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    return loopback && !req.headers['x-forwarded-for'] && !req.headers['forwarded'];
}

function tokenMatches(header) {
    if (!METRICS_TOKEN || !header || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(METRICS_TOKEN);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function authorize(req, res, next) {
    if (tokenMatches(req.headers.authorization) || isLocalRequest(req)) return next();
    res.status(401).type('text/plain').send('Solo accesible desde el propio servidor (o con METRICS_TOKEN)\n');
}

const escapeLabel = v => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

class Registry {
    constructor() { this.families = new Map(); }
    add(name, type, help, labels, value) {
        if (value === undefined || value === null || Number.isNaN(Number(value))) return;
        let f = this.families.get(name);
        if (!f) { f = { type, help, samples: [] }; this.families.set(name, f); }
        const l = Object.entries(labels || {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
        f.samples.push(`${name}${l ? `{${l}}` : ''} ${Number(value)}`);
    }
    gauge(name, help, labels, value) { this.add(name, 'gauge', help, labels, value); }
    counter(name, help, labels, value) { this.add(name, 'counter', help, labels, value); }
    toString() {
        let out = '';
        for (const [name, f] of this.families) out += `# HELP ${name} ${f.help}\n# TYPE ${name} ${f.type}\n${f.samples.join('\n')}\n`;
        return out;
    }
}

const dbAll = sql => new Promise(resolve => db.all(sql, [], (err, rows) => resolve(err ? [] : rows)));

// Destino de una salida sin credenciales ni parámetros (que pueden llevar passphrase)
const cleanDest = url => String(url || '').replace(/[?#].*$/, '').replace(/\/\/[^@/]*@/, '//');

async function collect() {
    const r = new Registry();
    const snap = streamManager.getMetricsSnapshot();

    r.gauge('tsst_info', 'Información del servidor', { version, app: 'rtsp-server-tsst' }, 1);
    r.gauge('tsst_start_time_seconds', 'Arranque del servidor (epoch)', {}, startedAt / 1000);

    const [inRows, outRows] = await Promise.all([
        dbAll('SELECT channel, name, enabled FROM inputs'),
        dbAll('SELECT id, channel, location, url, enabled FROM outputs')
    ]);
    const inName = new Map(inRows.map(x => [String(x.channel), x.name]));
    r.gauge('tsst_inputs_configured', 'Entradas configuradas', {}, inRows.length);
    r.gauge('tsst_inputs_enabled', 'Entradas activadas', {}, inRows.filter(x => x.enabled).length);
    r.gauge('tsst_outputs_configured', 'Salidas configuradas', {}, outRows.length);
    r.gauge('tsst_outputs_enabled', 'Salidas activadas', {}, outRows.filter(x => x.enabled).length);
    for (const x of inRows) {
        r.gauge('tsst_input_enabled', '1 si la entrada está activada en el panel', { channel: x.channel, name: x.name }, x.enabled ? 1 : 0);
    }
    const outLoc = new Map();
    for (const x of outRows) {
        const location = x.location || cleanDest(x.url);
        outLoc.set(String(x.id), location);
        r.gauge('tsst_output_enabled', '1 si la salida está activada en el panel',
            { id: x.id, channel: x.channel, name: inName.get(String(x.channel)) || '', location }, x.enabled ? 1 : 0);
    }

    for (const i of snap.inputs) {
        const l = { channel: i.channel, name: inName.get(String(i.channel)) || '', protocol: i.protocol };
        r.gauge('tsst_input_up', '1 si el proceso de ingesta está en marcha', l, i.running ? 1 : 0);
        r.gauge('tsst_input_signal', '1 si llegan datos', l, i.signal ? 1 : 0);
        r.gauge('tsst_input_bitrate_bits_per_second', 'Bitrate de entrada medido en el servidor', l, i.bitrateBps);
        r.counter('tsst_input_received_bytes_total', 'Bytes recibidos de la cámara', l, i.bytesTotal);
        r.counter('tsst_input_restarts_total', 'Reconexiones de la entrada', l, i.restarts);
        r.gauge('tsst_input_hls_viewing', '1 si alguien mira el vídeo en vivo en el panel', l, i.hlsViewing ? 1 : 0);
    }
    for (const o of snap.outputs) {
        const l = { id: o.id, channel: o.channel, location: outLoc.get(String(o.id)) || '', protocol: o.protocol };
        r.gauge('tsst_output_up', '1 si el proceso de salida está en marcha', { ...l, vcodec: o.vcodec }, o.running ? 1 : 0);
        r.gauge('tsst_output_bitrate_bits_per_second', 'Bitrate de salida', l, o.bitrateBps);
        r.counter('tsst_output_restarts_total', 'Reinicios de la salida', l, o.restarts);
    }
    r.gauge('tsst_hls_active', 'Vídeos en vivo del panel abiertos ahora', {}, snap.hlsActive);

    const host = sysMonitor.getLastStats();
    if (host) {
        r.gauge('tsst_host_cpu_load_ratio', 'Carga de CPU del host (0-1)', {}, host.cpuLoad / 100);
        r.gauge('tsst_host_memory_used_bytes', 'Memoria en uso del host', {}, host.memUsedBytes);
        r.gauge('tsst_host_memory_total_bytes', 'Memoria total del host', {}, host.memTotalBytes);
        if (host.cpuTemp !== '--') r.gauge('tsst_host_cpu_temperature_celsius', 'Temperatura de la CPU', {}, parseFloat(host.cpuTemp));
    }
    // Red real del equipo: solo se consulta cuando Prometheus lo pide
    try {
        const nets = await si.networkStats('*');
        let rx = 0, tx = 0;
        for (const n of nets) { rx += n.rx_sec > 0 ? n.rx_sec : 0; tx += n.tx_sec > 0 ? n.tx_sec : 0; }
        r.gauge('tsst_host_network_receive_bits_per_second', 'Tráfico de red entrante', {}, rx * 8);
        r.gauge('tsst_host_network_transmit_bits_per_second', 'Tráfico de red saliente', {}, tx * 8);
    } catch (e) {}

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    r.gauge('process_resident_memory_bytes', 'Memoria residente del proceso Node', {}, mem.rss);
    r.counter('process_cpu_seconds_total', 'CPU usada por Node (sin contar FFmpeg)', {}, (cpu.user + cpu.system) / 1e6);
    r.gauge('tsst_eventloop_lag_p99_seconds', 'Retardo p99 del event loop desde la última lectura', {}, loopDelay.percentile(99) / 1e9);
    loopDelay.reset();
    return r.toString();
}

async function handler(req, res) {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(await collect());
}

module.exports = { authorize, handler, collect };

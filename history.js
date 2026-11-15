/**
 * HISTORIAL (GET /api/history?range=1h)
 *
 * El Dashboard y Analytics muestran el historial que guarda Prometheus (lo mismo que ve Grafana)
 * sin salir del panel. El servidor hace de intermediario con un conjunto FIJO de consultas: el
 * navegador nunca manda PromQL. Basado en el del proyecto SRT server, sin las métricas SRT avanzadas.
 *
 * Si Prometheus no está instalado o no responde, devuelve { available: false } y el panel lo dice.
 * Coste: nada si no hay Prometheus; con él, unas pocas consultas cada 30 s y solo con el panel a la vista.
 */
const PROMETHEUS_URL = (process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090').replace(/\/+$/, '');
const TIMEOUT_MS = 3000;
const CACHE_MS = 10000;
const POINTS = 120; // puntos por serie: suficiente para la gráfica y ligero de transferir

const RANGES = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };

// Series para las gráficas (consultas de rango)
const SERIES = {
    inputBitrate: 'tsst_input_bitrate_bits_per_second',
    outputBitrate: 'tsst_output_bitrate_bits_per_second',
    restartsPerHour: 'sum by (channel, name) (increase(tsst_input_restarts_total[1h]))',
    cpu: 'tsst_host_cpu_load_ratio',
    memory: 'tsst_host_memory_used_bytes / tsst_host_memory_total_bytes'
};

// Resumen por señal en todo el rango (consultas instantáneas). {r} = rango, p. ej. 1h
const SUMMARY = {
    availability: 'avg_over_time(tsst_input_signal[{r}])',
    restarts: 'increase(tsst_input_restarts_total[{r}])',
    avgBitrate: 'avg_over_time(tsst_input_bitrate_bits_per_second[{r}])',
    minBitrate: 'min_over_time(tsst_input_bitrate_bits_per_second[{r}])'
};

const cache = new Map(); // range -> { at, data }

async function promQuery(path, params) {
    const url = `${PROMETHEUS_URL}/api/v1/${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await res.json();
    if (body.status !== 'success') throw new Error(body.error || `Prometheus ${res.status}`);
    return body.data.result;
}

async function collect(range) {
    const seconds = RANGES[range];
    const end = Math.floor(Date.now() / 1000);
    const step = Math.max(5, Math.round(seconds / POINTS));
    const rangeParams = { start: end - seconds, end, step };

    const seriesKeys = Object.keys(SERIES);
    const summaryKeys = Object.keys(SUMMARY);
    const results = await Promise.all([
        ...seriesKeys.map(k => promQuery('query_range', { query: SERIES[k], ...rangeParams })),
        ...summaryKeys.map(k => promQuery('query', { query: SUMMARY[k].replace('{r}', range), time: end }))
    ]);

    const series = {};
    seriesKeys.forEach((k, i) => {
        series[k] = results[i].map(r => ({ labels: r.metric, values: r.values.map(([t, v]) => [t, Number(v)]) }));
    });

    // Resumen agrupado por canal de entrada
    const summary = {};
    summaryKeys.forEach((k, i) => {
        for (const r of results[seriesKeys.length + i]) {
            const ch = r.metric.channel;
            if (!ch) continue;
            const row = summary[ch] || (summary[ch] = { channel: ch, name: r.metric.name || '' });
            row[k] = Number(r.value[1]);
        }
    });

    return { available: true, range, step, start: rangeParams.start, end, series, summary: Object.values(summary) };
}

async function handler(req, res) {
    const range = RANGES[req.query.range] ? req.query.range : '1h';
    const hit = cache.get(range);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.data);
    try {
        const data = await collect(range);
        cache.set(range, { at: Date.now(), data });
        res.json(data);
    } catch (err) {
        res.json({ available: false, reason: err.name === 'TimeoutError' ? 'timeout' : err.message });
    }
}

module.exports = { handler, collect, RANGES };

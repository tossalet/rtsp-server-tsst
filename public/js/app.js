const socket = io();

// State
let inputs = [];
let outputs = [];
let telemetryChart = null;
let selectedAnalyticsChannels = new Set();
let frontendTelemetryCache = {};
let serverIp = window.location.hostname;
const chartColors = ['#60A5FA', '#34d399', '#f87171', '#fbbf24', '#c084fc', '#f472b6', '#38bdf8', '#a3e635'];

// Boot configuration
fetch('/api/ports').then(r=>r.json()).then(d=>{ window.currentRtmpPort = d.rtmpPort || 1935; }).catch(()=>{ window.currentRtmpPort = 1935; });

// SPA Navigation
let currentDashboardFilter = null;

function setDashboardFilter(filter) {
    currentDashboardFilter = filter;
    renderDashboardStreams();
}

function renderDashboardStreams() {
    const container = document.getElementById('dashboard-filter-results');
    if (!container) return;
    
    if (currentDashboardFilter === null) {
        container.innerHTML = '';
        return;
    }
    
    let html = '';
    
    // Evaluate inputs
    inputs.forEach(i => {
        // Obtenemos el último valor de bitrate de la telemetría (si existe) para saber si de verdad recibe señal
        const history = frontendTelemetryCache[i.channel.toString()];
        const lastBitrate = (history && history.length > 0) ? history[history.length - 1].y : 0;
        const isOnline = i.enabled && lastBitrate > 0;
        
        let statusClass = isOnline ? 'ok' : (i.enabled ? 'warning' : '');
        if (!i.enabled) statusClass = 'error';
        
        const isOfflineCategory = !isOnline; // Si está esperando señal o apagado, es offline/erróneo
        
        if (currentDashboardFilter === 'active' && !isOnline) return;
        if (currentDashboardFilter === 'offline' && !isOfflineCategory) return;
        
        html += `
            <div class="sys-stat-card ${statusClass}" style="padding:12px 15px; border-left: 4px solid ${isOnline ? 'var(--color-green)' : (i.enabled ? 'var(--color-yellow)' : 'var(--color-red)')};">
                <div style="font-size:0.7rem; opacity:0.7; font-family:monospace;">${i.url.split('://')[0].toUpperCase()}</div>
                <div style="font-size:1rem; font-weight:600; margin:5px 0;">${i.name}</div>
                <div style="font-size:1.1rem;">
                    <i class="fa-solid ${isOnline ? 'fa-circle-check' : (i.enabled ? 'fa-spinner fa-spin' : 'fa-circle-xmark')}"></i>
                </div>
            </div>
        `;
    });
    
    // Evaluate outputs
    outputs.forEach(o => {
        let isOnline = o.enabled; // Outputs son activos por el mero hecho de estar enabled
        let statusClass = isOnline ? 'ok' : 'error';
        
        if (currentDashboardFilter === 'active' && !isOnline) return;
        if (currentDashboardFilter === 'offline' && isOnline) return;
        
        html += `
            <div class="sys-stat-card ${statusClass}" style="padding:12px 15px; border-left: 4px solid ${isOnline ? 'var(--color-green)' : 'var(--color-red)'}; background:rgba(255,255,255,0.02);">
                <div style="font-size:0.7rem; opacity:0.7; font-family:monospace;">${o.url.split('://')[0].toUpperCase()}</div>
                <div style="font-size:0.85rem; font-weight:500; margin:5px 0; word-break:break-all;">${(o.location || o.url).substring(0, 45)}</div>
                <div style="font-size:1.1rem;">
                    <i class="fa-solid ${isOnline ? 'fa-satellite-dish' : 'fa-plug-circle-xmark'}"></i>
                </div>
            </div>
        `;
    });
    
    if (html === '') html = '<div style="color:var(--text-muted); padding:20px; text-align:center; width:100%;">No hay elementos en esta categoría.</div>';
    
    container.innerHTML = html;
}

function switchTab(tabId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + tabId).classList.add('active');
    document.getElementById('view-toggle').hidden = tabId !== 'streams';

    if (tabId === 'streams') {
        document.getElementById('streamsContainer').style.display = ''; // filas o mosaico, según su clase
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Streams Manager';
        document.getElementById('topbar-subtitle').innerText = 'Live endpoints control panel';
        document.getElementById('btn-add-input').style.display = 'inline-block';
    } else if (tabId === 'analytics') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'block';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Analytics & Telemetry';
        document.getElementById('topbar-subtitle').innerText = 'Deep network inspection tools';
        document.getElementById('btn-add-input').style.display = 'none';

        populateAnalyticsGrid();
        renderSignalStatus();
        placeHistorySection('analytics-history-slot');
        loadHistory();
    } else if (tabId === 'system') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'block';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'System Dashboard';
        document.getElementById('topbar-subtitle').innerText = 'Host hardware & overview';
        document.getElementById('btn-add-input').style.display = 'none';
        placeHistorySection(null);
        loadHistory();
    } else if (tabId === 'settings') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'block';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Settings / Setup';
        document.getElementById('topbar-subtitle').innerText = 'Access control & Configuration';
        document.getElementById('btn-add-input').style.display = 'none';
        
        fetchSettingsData();
    } else if (tabId === 'storage') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'block';
        document.getElementById('topbar-title').innerText = 'Media Storage';
        document.getElementById('topbar-subtitle').innerText = 'Local recordings & file manager';
        document.getElementById('btn-add-input').style.display = 'none';
        
        fetchStorage();
    }
    syncThumbPlayers(); // al salir de Streams se paran los vídeos en vivo
}

// Escapa texto del usuario (nombres de cámara, ficheros) antes de meterlo en HTML
function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initChart() {
    const ctx = document.getElementById('bitrateChart').getContext('2d');
    telemetryChart = new Chart(ctx, {
        type: 'line',
        data: { datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: {
                legend: { display: true, labels: { color: 'rgba(255,255,255,0.7)', boxWidth: 12, font: { family: 'Inter', size: 11 } } },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.85)',
                    callbacks: {
                        title: (items) => items.length ? new Date(items[0].parsed.x).toLocaleTimeString() : '',
                        label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)} Mbps`
                    }
                }
            },
            scales: {
                // Eje de tiempo real (ms): entradas y salidas informan en instantes distintos,
                // así cada línea lleva sus propios puntos y no quedan huecos al mezclarlas
                x: {
                    type: 'linear',
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: 'rgba(255,255,255,0.4)', maxTicksLimit: 8, maxRotation: 0, callback: (v) => new Date(v).toLocaleTimeString() }
                },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, min: 0, ticks: { color: 'rgba(255,255,255,0.4)', callback: (v) => `${v} Mbps` } }
            }
        }
    });
}

function analyticsLabel(ch) {
    if (ch.startsWith('out_')) {
        const id = parseInt(ch.slice(4), 10);
        const o = outputs.find(x => x.id === id);
        return o ? `OUT_${id} (${(o.location || displayUrl(o.url)).substring(0, 24)})` : `OUT_${id}`;
    }
    const i = inputs.find(x => String(x.channel) === ch);
    return i ? `IN_${ch} (${i.name})` : `IN_${ch}`;
}

function populateAnalyticsGrid() {
    const grid = document.getElementById('analytics_grid');
    let html = '';
    inputs.filter(i => i.enabled).forEach(i => {
        const ch = String(i.channel);
        html += `
            <div class="analytics-card ${selectedAnalyticsChannels.has(ch) ? 'selected' : ''}" onclick="toggleAnalyticsChannel('${ch}')">
                <div class="acard-title">${escapeHtml(i.name)}</div>
                <div class="acard-badge">IN_${ch}</div>
            </div>`;
        // Sus salidas justo al lado de la entrada
        outputs.filter(o => o.channel === i.channel && o.enabled).forEach(o => {
            const outId = 'out_' + o.id;
            html += `
                <div class="analytics-card ${selectedAnalyticsChannels.has(outId) ? 'selected' : ''}" onclick="toggleAnalyticsChannel('${outId}')" style="margin-left: 20px; border-left: 3px solid rgba(255,255,255,0.2);">
                    <div class="acard-title" style="font-size:0.8rem; opacity:0.8;">${escapeHtml((o.location || displayUrl(o.url)).substring(0, 30))}</div>
                    <div class="acard-badge" style="background: rgba(255,255,255,0.1);">OUT_${o.id}</div>
                </div>`;
        });
    });
    grid.innerHTML = html || '<div style="color:var(--text-muted); font-size:0.9rem;">No hay señales activas</div>';
}

function updateTelemetryChart() {
    if (!telemetryChart) return;
    telemetryChart.data.datasets = Array.from(selectedAnalyticsChannels).map((ch, index) => {
        const color = chartColors[index % chartColors.length];
        const points = (frontendTelemetryCache[ch] || [])
            .filter(dp => typeof dp.t === 'number')
            .map(dp => ({ x: dp.t, y: dp.y / 1000 })); // kbps -> Mbps
        return { label: analyticsLabel(ch), data: points, borderColor: color, backgroundColor: color + '22', borderWidth: 2, tension: 0.3, fill: false, pointRadius: 0 };
    });
    telemetryChart.update('none');
}

/* ===================================
 * ESTADO DE LAS SEÑALES (Analytics), en vivo desde los eventos 'stats'
 * =================================== */
const liveStats = {}; // 'channel' | 'out_id' -> último evento stats + hora de llegada
let signalStatusTimer = null;

function noteLiveStats(data) {
    const key = String(data.channel);
    liveStats[key] = { ...(liveStats[key] || {}), ...data, at: Date.now() };
    // Como mucho un repintado por segundo, y solo con Analytics a la vista
    if (signalStatusTimer || document.getElementById('analyticsContainer').style.display === 'none') return;
    signalStatusTimer = setTimeout(() => { signalStatusTimer = null; renderSignalStatus(); }, 1000);
}

function signalState(enabled, s) {
    if (!enabled) return { cls: 'off', text: 'Apagada' };
    if (!s || Date.now() - s.at > 6000 || !s.active) return { cls: 'bad', text: 'Sin datos' };
    return parseFloat(s.bitrate) > 0 ? { cls: 'good', text: 'En vivo' } : { cls: 'warn', text: 'Esperando señal' };
}

const OUTPUT_CODECS = { h264_vaapi: 'H.264 · VAAPI', hevc_vaapi: 'H.265 · VAAPI', h264_qsv: 'H.264 · QSV', hevc_qsv: 'H.265 · QSV', libx264: 'H.264 · CPU', libx265: 'H.265 · CPU' };
function outputCodecText(o) {
    const vcodec = o.vcodec || 'copy';
    if (vcodec !== 'copy') return OUTPUT_CODECS[vcodec] || vcodec;
    const inStats = liveStats[String(o.channel)];
    return inStats && inStats.codec ? `${inStats.codec} · passthrough` : 'Passthrough';
}

function signalRow(key, name, proto, enabled, isOutput, codecText, url, latencyText) {
    const s = liveStats[key];
    const st = signalState(enabled, s);
    const kbps = s && st.cls !== 'off' ? parseFloat(s.bitrate) || 0 : null;
    const dash = '—';
    return `<tr class="${isOutput ? 'sig-out' : 'sig-in'}">
        <td>${isOutput ? '<span class="sig-branch">↳</span>' : ''}${escapeHtml(name)} <span class="sig-proto">${proto}</span></td>
        <td><span class="sig-state ${st.cls}">${st.text}</span></td>
        <td>${kbps === null ? dash : `${(kbps / 1000).toFixed(2)} Mbps`}</td>
        <td>${s && s.time && st.cls === 'good' ? s.time : dash}</td>
        <td>${codecText ? escapeHtml(codecText) : (!isOutput && s && s.codec ? escapeHtml(s.codec) : dash)}</td>
        <td>${latencyText || dash}</td>
    </tr>`;
}

function renderSignalStatus() {
    const body = document.getElementById('signal-status-body');
    if (!body) return;
    let rows = '';
    let live = 0, waiting = 0, off = 0;
    inputs.forEach(i => {
        const key = String(i.channel);
        const st = signalState(i.enabled, liveStats[key]).cls;
        if (st === 'good') live++; else if (st === 'off') off++; else waiting++;
        const inLat = i.latency_ms ? `${i.latency_ms} ms` : (i.url.startsWith('srt://') ? `${srtLatencyMs(i.url)} ms` : null);
        rows += signalRow(key, i.name, i.url.split('://')[0].toUpperCase(), i.enabled, false, null, i.url, inLat);
        outputs.filter(o => o.channel === i.channel).forEach(o => {
            rows += signalRow('out_' + o.id, o.location || displayUrl(o.url), o.url.split('://')[0].toUpperCase(), o.enabled, true,
                outputCodecText(o), o.url, o.url.startsWith('srt') ? `${srtLatencyMs(o.url)} ms` : null);
        });
    });
    body.innerHTML = rows || '<tr><td colspan="6" style="color:var(--text-muted);">No hay señales configuradas.</td></tr>';
    document.getElementById('signal-status-count').textContent = `${live} en vivo · ${waiting} sin señal · ${off} apagadas`;
}

/* ===================================
 * HISTORIAL (Prometheus: lo mismo que Grafana, sin salir del panel)
 * Un solo bloque que se coloca en el Dashboard o en Analytics según la pestaña.
 * =================================== */
let historyRange = '1h';
let historyLoading = false;
const historyCharts = {};
let historyHome = null;

function placeHistorySection(slotId) {
    const section = document.getElementById('history-section');
    if (!section) return;
    if (!historyHome) historyHome = { parent: section.parentNode, next: section.nextSibling };
    if (slotId) document.getElementById(slotId).appendChild(section);
    else historyHome.parent.insertBefore(section, historyHome.next);
    Object.values(historyCharts).forEach(c => c.resize()); // Chart.js recalcula el tamaño al volver a estar visible
}

function setHistoryRange(range) {
    historyRange = range;
    document.querySelectorAll('.history-ranges button').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    loadHistory();
}

function historyLabel(labels) {
    return labels.name || labels.location || (labels.channel ? `Canal ${labels.channel}` : 'Serie');
}

function timeLabel(ts, range) {
    const d = new Date(ts * 1000);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return range === '24h' ? `${d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${hm}` : hm;
}

// Una gráfica de líneas: todas las series comparten los instantes (mismo step de Prometheus)
function drawHistoryChart(id, seriesList, { scale = 1, unit = '', max } = {}) {
    const ts = [...new Set(seriesList.flatMap(s => s.values.map(v => v[0])))].sort((a, b) => a - b);
    const datasets = seriesList.map((s, i) => {
        const byTs = new Map(s.values.map(([t, v]) => [t, v * scale]));
        const color = s.color || chartColors[i % chartColors.length];
        return {
            label: s.label || historyLabel(s.labels),
            data: ts.map(t => (byTs.has(t) ? byTs.get(t) : null)),
            borderColor: color, backgroundColor: color + '22', borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: false
        };
    });
    const labels = ts.map(t => timeLabel(t, historyRange));
    let chart = historyCharts[id];
    if (!chart) {
        chart = historyCharts[id] = new Chart(document.getElementById(id).getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, labels: { color: 'rgba(255,255,255,0.7)', boxWidth: 12, font: { family: 'Inter', size: 11 } } },
                    tooltip: { backgroundColor: 'rgba(0,0,0,0.85)', callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(2)} ${unit}` } }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', maxTicksLimit: 8, maxRotation: 0 } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', callback: (v) => `${v} ${unit}` }, min: 0, max }
                }
            }
        });
    } else {
        chart.data.labels = labels;
        chart.data.datasets = datasets;
        chart.update('none');
    }
}

function renderHistorySummary(rows) {
    const body = document.getElementById('history-summary');
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);">Sin datos de señales en este periodo.</td></tr>';
        return;
    }
    rows.sort((a, b) => Number(a.channel) - Number(b.channel));
    const mbps = v => v === undefined ? '—' : `${(v / 1e6).toFixed(2)} Mbps`;
    body.innerHTML = rows.map(r => {
        const av = r.availability;
        const avClass = av === undefined ? '' : av >= 0.999 ? 'good' : av >= 0.95 ? 'warn' : 'bad';
        const restarts = r.restarts === undefined ? '—' : Math.round(r.restarts);
        return `<tr>
            <td>${escapeHtml(r.name || 'Canal ' + r.channel)}</td>
            <td class="${avClass}">${av === undefined ? '—' : `${(av * 100).toFixed(1)} %`}</td>
            <td class="${restarts > 0 ? 'warn' : ''}">${restarts}</td>
            <td>${mbps(r.avgBitrate)}</td>
            <td class="${r.minBitrate === 0 ? 'warn' : ''}">${mbps(r.minBitrate)}</td>
        </tr>`;
    }).join('');
}

async function loadHistory() {
    const msg = document.getElementById('history-msg');
    const body = document.getElementById('history-body');
    if (historyLoading || !msg || !body) return; // sección aún no presente en la página
    historyLoading = true;
    try {
        const data = await fetch(`/api/history?range=${historyRange}`).then(r => r.json());
        if (!data.available) {
            body.style.display = 'none';
            msg.style.display = 'block';
            msg.innerHTML = 'Historial no disponible: instala la monitorización (Prometheus + Grafana, opcional) con<br><code>sudo bash ~/rtsp-server-tsst/instalar_servidor.sh --monitorizacion</code>';
            return;
        }
        msg.style.display = 'none';
        body.style.display = 'block';
        renderHistorySummary(data.summary);
        const s = data.series;
        drawHistoryChart('hist_input', s.inputBitrate, { scale: 1e-6, unit: 'Mbps' });
        drawHistoryChart('hist_output', s.outputBitrate, { scale: 1e-6, unit: 'Mbps' });
        drawHistoryChart('hist_restarts', s.restartsPerHour, { unit: '/h' });
        drawHistoryChart('hist_host', [
            ...s.cpu.map(x => ({ ...x, label: 'CPU', color: '#60A5FA' })),
            ...s.memory.map(x => ({ ...x, label: 'Memoria', color: '#34d399' }))
        ], { scale: 100, unit: '%', max: 100 });
    } catch (e) {
        msg.style.display = 'block';
        msg.textContent = 'No se pudo cargar el historial.';
    } finally {
        historyLoading = false;
    }
}

// Refresco cada 30 s, solo con el Dashboard o Analytics a la vista y la pestaña del navegador activa
setInterval(() => {
    const visible = ['systemContainer', 'analyticsContainer'].some(id => document.getElementById(id).style.display !== 'none');
    if (visible && !document.hidden) loadHistory();
}, 30000);

function toggleAnalyticsChannel(channelId) {
    const chStr = channelId.toString();
    if (selectedAnalyticsChannels.has(chStr)) {
        selectedAnalyticsChannels.delete(chStr);
    } else {
        selectedAnalyticsChannels.add(chStr);
    }
    populateAnalyticsGrid(); // Refresca las clases "selected"
    updateTelemetryChart();
}

function appendLogToViewer(logEntry) {
    const viewer = document.getElementById('log-viewer');
    if (!viewer) return;
    
    if (viewer.innerHTML.includes('Waiting for logs...')) viewer.innerHTML = '';
    
    const color = logEntry.level === 'ERROR' ? '#ef4444' : '#34d399';
    const entryDiv = document.createElement('div');
    entryDiv.style.marginBottom = '4px';
    
    // Escapar tags HTML del mensaje por seguridad y formatear
    const safeMsg = logEntry.message ? logEntry.message.replace(/</g, "&lt;").replace(/>/g, "&gt;") : '';
    entryDiv.innerHTML = `<span style="color:#6b7280;">[${logEntry.timestamp}]</span> <span style="color:${color}; font-weight:bold;">[${logEntry.level}]</span> <span style="word-break: break-all;">${safeMsg}</span>`;
    
    viewer.appendChild(entryDiv);
    // Auto-scroll si está abajo del todo
    viewer.scrollTop = viewer.scrollHeight;
}

document.addEventListener('DOMContentLoaded', () => {
    switchTab('system'); // Iniciar en el Dashboard
    fetchData();
    initChart();
    
    fetch('/api/logs').then(r => r.json()).then(logs => {
        logs.forEach(l => appendLogToViewer(l));
    }).catch(e => console.error("Error loading logs", e));

    // Socket listeners
    socket.on('server_log', (logEntry) => {
        appendLogToViewer(logEntry);
    });

    socket.on('db_update', (data) => {
        console.log("DB Update:", data.event);
        
        // Optimización brutal: Si solo ha cambiado la previsualización, modificamos el DOM directamente
        // Así evitamos destruir el HTML de las las otras cámaras y perder sus estados (ej. barras vs imagen)
        if (data.event === 'preview_changed') {
            const inp = inputs.find(i => i.channel == data.channel);
            if (inp) inp.preview_enabled = data.preview_enabled;
            
            const img = document.getElementById(`thumb-img-${data.channel}`);
            if (img) {
                if (data.preview_enabled && inp.enabled) {
                    img.classList.add('preview-active');
                    if (img.classList.contains('has-signal')) {
                        img.style.filter = 'none'; // Restaurar color
                    }
                } else {
                    img.classList.remove('preview-active');
                    if (img.src.includes('thumb_')) {
                        img.style.filter = 'grayscale(100%) opacity(40%) blur(1px)';
                    }
                }
                
                // Botón del ojo de esta miniatura (el vídeo en vivo puede quedar entre la imagen y el botón)
                const btn = img.parentElement.querySelector('button');
                if (btn) {
                    btn.style.color = data.preview_enabled ? 'var(--color-green)' : '#fff';
                    btn.title = data.preview_enabled ? 'Desactivar Previsualización (Ahorro CPU)' : 'Activar Previsualización';
                    btn.innerHTML = `<i class="fa-solid ${data.preview_enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
                }
            }
            syncThumbPlayers(); // ojo encendido -> vídeo en vivo; apagado -> se para
            return; // Salir! No hacemos fetchData ni repintamos todo el DOM.
        }
        if (data.event === 'input_toggled') {
            const inp = inputs.find(i => i.channel == data.channel);
            if (inp) inp.enabled = data.enabled;
            syncThumbPlayers();

            // LED
            const led = document.getElementById(`led-${data.channel}`);
            if (led) {
                led.className = `connection-led ${data.enabled ? 'active yellow' : 'error'} tooltip`;
                const tt = led.querySelector('.tooltiptext');
                if (tt) tt.innerText = data.enabled ? 'Enabled' : 'Disabled';
            }
            // Toggle Icon
            const btn = document.querySelector(`#input-card-${data.channel} .toggle-enabled i`);
            if (btn) btn.className = `fa-solid ${data.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`;
            // Quality Bar
            const qbar = document.getElementById(`qbar-${data.channel}`);
            if (qbar) {
                qbar.className = `fill ${data.enabled ? 'yellow' : 'red'}`;
                qbar.style.width = data.enabled ? '100%' : '0%';
            }
            // Si lo deshabilitamos (OFF), la imagen pasa forzosamente a barras
            if (!data.enabled) {
                const img = document.getElementById(`thumb-img-${data.channel}`);
                if (img) {
                    img.src = '/images/bars.svg';
                    img.style.filter = 'none';
                    img.classList.remove('has-signal');
                }
            }
            if (currentDashboardFilter !== null) renderDashboardStreams();
            return;
        }
        if (data.event === 'output_toggled') {
            const out = outputs.find(o => o.id == data.id);
            if (out) out.enabled = data.enabled;
            // LED
            const led = document.getElementById(`led-out_${data.id}`);
            if (led) {
                led.className = `connection-led ${data.enabled ? 'active yellow' : 'error'} tooltip`;
                const tt = led.querySelector('.tooltiptext');
                if (tt) tt.innerText = data.enabled ? 'Enabled' : 'Disabled';
            }
            // Toggle Icon
            const btn = document.querySelector(`#outputs-container-${out ? out.channel : ''} button[onclick="toggleOutput(${data.id})"] i`);
            if (btn) btn.className = `fa-solid ${data.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`;
            
            if (currentDashboardFilter !== null) renderDashboardStreams();
            return;
        }
        
        fetchData();
    });

    socket.on('stats', (data) => {
        noteLiveStats(data); // tabla "Estado de las señales" de Analytics
        const bitElem = document.getElementById(`bitrate-${data.channel}`);
        const timeElem = document.getElementById(`time-${data.channel}`);
        const ledElem = document.getElementById(`led-${data.channel}`);

        if (bitElem && timeElem && ledElem) {
            if (data.active) {
                bitElem.innerText = data.bitrate.replace('bits/s', 'ps');
                timeElem.innerText = data.time;
                
                const bitVal = parseFloat(data.bitrate);
                if (bitVal > 0) {
                    ledElem.className = 'connection-led active tooltip'; // green (receiving data)
                } else {
                    ledElem.className = 'connection-led active yellow tooltip'; // yellow (waiting for data)
                }
            } else {
                bitElem.innerText = '--:-- Mbps';
                timeElem.innerText = '--:--:--';
                ledElem.className = 'connection-led error tooltip'; // red
            }
        }
        
        // Auto-cambio de Barras vs Imagen según Señal Real (Bitrate > 0)
        const imgElem = document.getElementById(`thumb-img-${data.channel}`);
        if (imgElem) {
            const bitVal = data.active && data.bitrate ? parseFloat(data.bitrate) : 0;
            const isPreviewLive = imgElem.classList.contains('preview-active');
            
            if (bitVal > 0) {
                // Cancelar cualquier cuenta atrás de pérdida de señal
                if (imgElem.dataset.offlineTimeout) {
                    clearTimeout(parseInt(imgElem.dataset.offlineTimeout));
                    delete imgElem.dataset.offlineTimeout;
                }

                // Hay señal
                if (!imgElem.classList.contains('has-signal')) {
                    imgElem.classList.add('has-signal');
                    imgElem.style.filter = isPreviewLive ? 'none' : 'grayscale(100%) opacity(40%) blur(1px)';
                    
                    if (!isPreviewLive) {
                        fetch(`/api/inputs/${data.channel}/snapshot`, { method: 'POST' }).catch(e => console.error(e));
                    }
                }
                
                // La preview en vivo la refresca el intervalo de 4s (la miniatura solo cambia en keyframes);
                // recargarla aquí suponía 2 descargas JPG por segundo y cámara
                if (!isPreviewLive && !imgElem.src.includes('thumb_')) {
                    // Restaurar foto estática single-frame a prueba de fallos y sin parpadeos
                    const temp = new Image();
                    temp.onload = () => { imgElem.src = temp.src; };
                    temp.src = `/thumbs/thumb_${data.channel}.jpg?t=${Math.floor(Date.now()/5000)}`;
                }
            } else {
                // No hay señal real (iniciar debounce para no parpadear)
                if (!imgElem.dataset.offlineTimeout) {
                    imgElem.dataset.offlineTimeout = setTimeout(() => {
                        if (imgElem.classList.contains('has-signal')) imgElem.classList.remove('has-signal');
                        // Nos aseguramos de mantener las barras
                        if (!imgElem.src.includes('bars.svg')) {
                            imgElem.src = '/images/bars.svg';
                            imgElem.style.filter = 'none';
                        }
                        delete imgElem.dataset.offlineTimeout;
                    }, 5000).toString();
                }
            }
        }
        
        if (data.codec) {
            const codecElem = document.getElementById(`codec-${data.channel}`);
            if (codecElem && data.codec.length > 0) codecElem.innerText = data.codec;
        }
        if (data.video) setVideoInfo(data.channel, data.video);

        // Backend pushes historical telemetry for each update
        if (data.history) {
            frontendTelemetryCache[data.channel.toString()] = data.history;
            if (selectedAnalyticsChannels.has(data.channel.toString())) {
                updateTelemetryChart();
            }
        }
        // Minigráfico y barra: verde con señal, amarillo esperando
        const key = data.channel.toString();
        const svg = document.querySelector(`svg.spark[data-key="${key}"]`);
        if (svg) drawSpark(svg, (frontendTelemetryCache[key] || []).map(p => p.y || 0));
        const qbar = document.getElementById(`qbar-${key}`);
        if (qbar && data.active) qbar.className = `fill ${parseFloat(data.bitrate) > 0 ? 'green' : 'yellow'}`;
        // Render streams list locally on dash
        renderDashboardStreams();
    });

    socket.on('input_video', d => setVideoInfo(d.channel, d.video));
    socket.on('proc_stats', renderProcStats);

    socket.on('sys_stats', (stats) => {
        // CPU
        const cpuLabel = document.getElementById('sys_cpu');
        const cpuBar = document.getElementById('sys_cpu_bar');
        if (cpuLabel) {
            cpuLabel.innerText = stats.cpuLoad;
            cpuBar.style.width = stats.cpuLoad + '%';
            cpuBar.style.background = stats.cpuLoad > 85 ? 'var(--color-red)' : 'var(--accent-blue)';
        }
        
        // Temperature
        const tempEl = document.getElementById('sys_temp');
        if (tempEl) {
            tempEl.innerText = stats.cpuTemp !== undefined && stats.cpuTemp !== '--' ? stats.cpuTemp + ' °C' : '-- °C';
            if (stats.cpuTemp !== undefined && stats.cpuTemp !== '--') {
                const t = parseFloat(stats.cpuTemp);
                if (t >= 80) tempEl.style.color = 'var(--color-red)';
                else if (t >= 70) tempEl.style.color = 'var(--color-yellow)';
                else tempEl.style.color = 'var(--color-green)';
            } else {
                tempEl.style.color = 'inherit';
            }
        }
        
        // RAM
        const ramLabel = document.getElementById('sys_ram');
        const ramTotalLabel = document.getElementById('sys_ram_total');
        const ramBar = document.getElementById('sys_ram_bar');
        if (ramLabel) {
            ramLabel.innerText = stats.memUsed;
            ramTotalLabel.innerText = stats.memTotal;
            ramBar.style.width = stats.memPercent + '%';
            ramBar.style.background = stats.memPercent > 85 ? 'var(--color-red)' : 'var(--color-green)';
        }

        // Net
        const txLabel = document.getElementById('sys_tx');
        const rxLabel = document.getElementById('sys_rx');
        if(txLabel) {
            txLabel.innerText = stats.netTx;
            rxLabel.innerText = stats.netRx;
        }

        // Logical Streams overview
        const tTotal = document.getElementById('sys_routes_total');
        const tOk = document.getElementById('sys_routes_ok');
        const tErr = document.getElementById('sys_routes_err');
        if(tTotal) {
            tTotal.innerText = stats.streamsTotal;
            tOk.innerText = stats.streamsActive;
            tErr.innerText = stats.streamsError;
        }
    });

    // Thumbnail auto-refresh
    setInterval(() => {
        const thumbs = document.querySelectorAll('.thumb-container img');
        thumbs.forEach(img => {
            const baseSrc = img.dataset.src;
            // Actualizar si el "Ojo" está activo, o si la imagen está trabada en las barras de color (para recuperar la foto inicial)
            // Solo con señal: sin ella la miniatura no existe y cada 4 s salían dos 404 por cámara
            if (baseSrc && img.classList.contains('has-signal') && (img.classList.contains('preview-active') || img.src.includes('bars.svg'))) {
                const tempImg = new Image();
                tempImg.onload = () => { img.src = tempImg.src; };
                // Eliminamos el onerror que forzaba falsas barras rojas si coincidía que leíamos mientras ffmpeg guardaba
                tempImg.src = `${baseSrc}?t=${Date.now()}`;
            }
        });
    }, 4000);
});

async function fetchData() {
    try {
        const resIp = await fetch('/api/server-ip').catch(() => null);
        if (resIp && resIp.ok) {
            const dataIp = await resIp.json();
            serverIp = dataIp.ip;
        }

        const [resIn, resOut] = await Promise.all([
            fetch('/api/inputs', { cache: 'no-store' }),
            fetch('/api/outputs', { cache: 'no-store' })
        ]);
        inputs = await resIn.json();
        outputs = await resOut.json();
        
        renderStreams();
    } catch (e) {
        console.error("Error fetching data:", e);
    }
}

function renderStreams() {
    // Preserve UI State
    const expandedIds = new Set();
    document.querySelectorAll('.stream-card.expand-mode').forEach(c => expandedIds.add(c.id));

    const container = document.getElementById('streamsContainer');
    container.innerHTML = '';

    inputs.forEach(input => {
        const inputOutputs = outputs.filter(o => o.channel === input.channel);
        
        let protocolBadge = 'srt';
        let protocolText = /^srt:\/\//.test(input.url) ? (/[?&]mode=listener/.test(input.url) ? 'SRT LISTENER' : 'SRT') : 'RTSP';

        const isExpandedClass = expandedIds.has(`input-card-${input.channel}`) ? 'expand-mode' : '';

        const inputHTML = `
            <div class="stream-card ${isExpandedClass}" id="input-card-${input.channel}">
                <div class="stream-header" style="cursor: pointer;" onclick="if(event.target.closest('.control-actions') || event.target.closest('button') || event.target.tagName === 'BUTTON') return; toggleExpand(${input.channel})">
                    <div class="left-section">
                        <button class="btn-expand" onclick="toggleExpand(${input.channel})"><i class="fa-solid fa-chevron-down"></i></button>
                        <div id="led-${input.channel}" class="connection-led ${input.enabled ? 'active yellow' : 'error'} tooltip">
                            <i class="fa-solid fa-lightbulb"></i>
                            <span class="tooltiptext">${input.enabled ? 'Enabled' : 'Disabled'}</span>
                        </div>
                        <div class="badge-protocol ${protocolBadge}">${protocolText}</div>
                        <span id="codec-${input.channel}" class="badge-protocol udp" style="background:#4b5563;">${videoInfo[input.channel] ? videoInfo[input.channel].codec : 'H.26X'}</span>
                        <span id="res-${input.channel}" class="badge-res" ${videoInfo[input.channel] ? '' : 'hidden'} title="${videoInfo[input.channel] ? escapeHtml(videoText(videoInfo[input.channel])) : ''}">${videoInfo[input.channel] ? resLabel(videoInfo[input.channel]) : ''}</span>
                        <span class="stream-name" style="display:flex; flex-direction:column; line-height:1.2;">
                            ${input.name || 'Channel ' + input.channel}
                            <span style="font-size:0.70rem; color:var(--accent-blue); font-family:monospace; font-weight:normal; user-select:all;">${displayUrl(input.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
                        </span>
                    </div>
                    <div class="mid-section">
                        <div class="stat-item ${!input.enabled ? 'disabled' : ''}">
                            <i class="fa-solid fa-clock"></i> <span id="time-${input.channel}">--:--:--</span>
                        </div>
                        <div class="stat-item ${!input.enabled ? 'disabled' : ''}">
                            <i class="fa-solid fa-gauge-high"></i> <span class="monospaced" id="bitrate-${input.channel}">-- Mbps</span>
                        </div>
                        <div class="quality-bar" title="Bitrate del último minuto">
                            <svg class="spark" data-key="${input.channel}" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area"/><path class="spark-line"/></svg>
                            <div class="fill ${input.enabled ? 'yellow' : 'red'}" id="qbar-${input.channel}" style="width: ${input.enabled ? '100%' : '0%'}"></div>
                        </div>
                    </div>
                    <div class="right-section">
                        <div class="control-actions">
                            <button class="action-btn toggle-enabled tooltip" onclick="toggleInput(${input.channel})">
                                <i class="fa-solid ${input.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                                <span class="tooltiptext">Toggle Input</span>
                            </button>
                            ${/^rtsp:\/\//i.test(input.url) ? `<button class="action-btn cam-btn tooltip" onclick="openCameraModal(${input.channel})" aria-label="Codificación de la cámara"><i class="fa-solid fa-sliders"></i><span class="tooltiptext">Codificación de la cámara</span></button>` : ''}
                            <button class="action-btn edit-btn" onclick="openEditInput(${input.channel})"><i class="fa-solid fa-pen"></i></button>
                            <button class="action-btn delete-btn" onclick="deleteInput(${input.channel})"><i class="fa-solid fa-trash"></i></button>
                            <button class="btn-secondary add-output" onclick="openOutputModal(${input.channel})"><i class="fa-solid fa-arrow-right-to-bracket"></i> Add Output</button>
                        </div>
                    </div>
                </div>
                
                <div class="stream-outputs" id="outputs-container-${input.channel}">
                    <div class="thumb-container" style="padding: 1rem 1.5rem; background: rgba(0,0,0,0.3); border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; gap: 20px; align-items: center;">
                        <div class="thumb-box" id="thumb-box-${input.channel}" style="position:relative; width:160px; height:90px; flex-shrink:0; border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                            <img id="thumb-img-${input.channel}" class="${input.preview_enabled && input.enabled ? 'preview-active' : ''}" data-src="/thumbs/thumb_${input.channel}.jpg" src="${input.enabled ? '/thumbs/thumb_' + input.channel + '.jpg' + (input.preview_enabled ? '?t=' + Date.now() : '') : '/images/bars.svg'}" onerror="if(!this.src.includes('bars.svg')){this.src='/images/bars.svg';}" style="width:100%; height:100%; object-fit:cover; filter: ${input.preview_enabled && input.enabled ? 'none' : 'grayscale(100%) opacity(40%) blur(1px)'}; transition: filter 0.3s;" />
                            <button onclick="togglePreview(${input.channel})" class="action-btn" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); background:rgba(0,0,0,0.6); padding:8px 12px; border:none; color:${input.preview_enabled ? 'var(--color-green)' : '#fff'}; border-radius:4px; font-size:1.2rem; cursor:pointer; opacity: 0.8; transition:0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8" title="${input.preview_enabled ? 'Desactivar Previsualización (Ahorro CPU)' : 'Activar Previsualización'}">
                                <i class="fa-solid ${input.preview_enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>
                            </button>
                        </div>
                        <div style="font-size:0.85rem; color:var(--text-muted); line-height: 1.4; display:flex; flex-direction:column; gap:5px; min-width:0;">
                            <p><strong>URL Origen:</strong></p>
                            <span style="color:#fff; font-weight:600; font-family:monospace; word-break: break-all;">${displayUrl(input.url)}</span>
                            <span style="font-size:0.75rem; color:var(--accent-blue); font-weight:600;"><i class="fa-solid fa-hourglass-half"></i> Latencia ${input.latency_ms ? input.latency_ms + ' ms' : 'auto'}${input.buffer ? ' · Buffer ' + input.buffer + ' MB' : ''}</span>
                            <span class="vinfo" id="vinfo-${input.channel}">${videoInfo[input.channel] ? '<i class="fa-solid fa-film"></i> Llega: ' + escapeHtml(videoText(videoInfo[input.channel])) : ''}</span>
                            <span class="use-line" id="use-in-${input.channel}"></span>
                        </div>
                    </div>
                    ${inputOutputs.map(out => `
                        <div class="output-row">
                            <div class="left-section sub">
                                <div id="led-out_${out.id}" class="connection-led ${out.enabled ? 'active yellow' : 'error'} tooltip" style="margin-right: -5px;">
                                    <i class="fa-solid fa-lightbulb"></i>
                                    <span class="tooltiptext">${out.enabled ? 'Enabled' : 'Disabled'}</span>
                                </div>
                                <span class="stream-name" style="display:flex; flex-direction:column; line-height:1.2;">
                                    ${out.location || displayUrl(out.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}
                                    <span style="font-size:0.70rem; color:var(--text-muted); font-family:monospace; font-weight:normal; user-select:all;">${displayUrl(out.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
                                    ${out.url.startsWith('srt') ? `<span style="font-size:0.70rem; color:var(--accent-blue); font-weight:600;"><i class="fa-solid fa-hourglass-half"></i> Latencia ${srtLatencyMs(out.url)} ms</span>` : ''}
                                    <span class="use-line" id="use-out_${out.id}">${outputUseText(out, lastProcStats && lastProcStats.outputs ? lastProcStats.outputs[out.id] : null)}</span>
                                </span>
                            </div>
                            <div class="mid-section">
                                <div class="stat-item ${!out.enabled ? 'disabled' : ''}">
                                    <i class="fa-solid fa-clock"></i> <span id="time-out_${out.id}">--:--:--</span>
                                </div>
                                <div class="stat-item ${!out.enabled ? 'disabled' : ''}">
                                    <i class="fa-solid fa-gauge-high"></i> <span class="monospaced" id="bitrate-out_${out.id}">-- Mbps</span>
                                </div>
                                <div class="quality-bar">
                                    <svg class="spark" data-key="out_${out.id}" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area"/><path class="spark-line"/></svg>
                                    <div class="fill ${out.enabled ? 'yellow' : 'red'}" id="qbar-out_${out.id}" style="width: ${out.enabled ? '100%' : '0%'}"></div>
                                </div>
                            </div>
                            <div class="right-section sub-controls">
                                <div class="control-actions">
                                    <button class="action-btn toggle-enabled" onclick="toggleOutput(${out.id})">
                                        <i class="fa-solid ${out.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                                    </button>
                                    <button class="action-btn edit-btn" onclick="openEditOutput(${out.id})"><i class="fa-solid fa-pen"></i></button>
                                    <button class="action-btn delete-btn" onclick="deleteOutput(${out.id})"><i class="fa-solid fa-trash"></i></button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        container.innerHTML += inputHTML;
    });
    // Al reconstruir las tarjetas: redibujar los minigráficos y recolocar los vídeos en vivo sin cortarlos
    container.querySelectorAll("svg.spark").forEach(svg => drawSpark(svg, (frontendTelemetryCache[svg.dataset.key] || []).map(p => p.y || 0)));
    syncThumbPlayers();
}

function toggleExpand(channel) {
    const card = document.getElementById(`input-card-${channel}`);
    card.classList.toggle('expand-mode');
    const icon = card.querySelector('.btn-expand i');
    if (card.classList.contains('expand-mode')) {
        icon.className = 'fa-solid fa-chevron-down';
    } else {
        icon.className = 'fa-solid fa-chevron-right';
    }
    syncThumbPlayers();
}

/* =======================================
 *  MINIGRÁFICO DE BITRATE (último minuto, con los datos que ya manda el servidor)
 * ======================================= */
const SPARK_POINTS = 60;
function drawSpark(svg, buf) {
    const line = svg.querySelector('.spark-line');
    const area = svg.querySelector('.spark-area');
    buf = buf.slice(-SPARK_POINTS);
    if (buf.length < 2) { line.setAttribute('d', ''); area.setAttribute('d', ''); return; }
    const max = Math.max(...buf, 1) * 1.15;
    const step = 120 / (SPARK_POINTS - 1);
    const x0 = 120 - (buf.length - 1) * step; // los datos entran por la derecha
    const d = buf.map((v, i) => `${i ? 'L' : 'M'}${(x0 + i * step).toFixed(1)} ${(27 - (v / max) * 25).toFixed(1)}`).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L120 28 L${x0.toFixed(1)} 28 Z`);
}

/* =======================================
 *  VÍDEO EN VIVO EN LA TARJETA (HLS bajo demanda)
 * =======================================
 * Con el ojo encendido y la miniatura a la vista (tarjeta desplegada o mosaico), el vídeo se
 * reproduce sin sonido encima de la imagen fija. El servidor solo copia el vídeo (sin recodificar)
 * mientras alguien lo mira y lo para a los 15 s. Los <video> viven fuera del HTML de las tarjetas:
 * renderStreams() las reconstruye y syncThumbPlayers() los recoloca sin cortarlos.
 */
const thumbPlayers = {}; // canal -> { video, hls, retry }

function wantsThumbLive(input) {
    if (document.hidden || !input.preview_enabled || !input.enabled) return false;
    const card = document.getElementById(`input-card-${input.channel}`);
    if (!card || card.offsetParent === null) return false; // pestaña Streams no visible
    const grid = document.getElementById('streamsContainer').classList.contains('view-grid');
    return grid || card.classList.contains('expand-mode');
}

function syncThumbPlayers() {
    const wanted = new Set();
    for (const input of inputs) {
        const channel = String(input.channel);
        const box = document.getElementById(`thumb-box-${channel}`);
        if (!box || !wantsThumbLive(input)) continue;
        wanted.add(channel);
        const p = thumbPlayers[channel] || startThumbPlayer(channel);
        if (p.video.parentNode !== box) {
            box.insertBefore(p.video, box.querySelector('button')); // debajo del botón del ojo
            p.video.play().catch(() => {}); // sacarlo del DOM lo pausa
        }
    }
    for (const channel of Object.keys(thumbPlayers)) if (!wanted.has(channel)) stopThumbPlayer(channel);
}

function startThumbPlayer(channel) {
    const video = document.createElement('video');
    video.className = 'live-thumb';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.onplaying = () => video.classList.add('playing');
    const p = { video, hls: null, retry: null };
    thumbPlayers[channel] = p;
    loadThumbPlayer(p, channel);
    return p;
}

function loadThumbPlayer(p, channel) {
    const src = `/hls/${channel}/index.m3u8`;
    if (window.Hls && Hls.isSupported()) {
        p.hls = new Hls({ liveSyncDurationCount: 2, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000 });
        p.hls.on(Hls.Events.MANIFEST_PARSED, () => p.video.play().catch(() => {}));
        p.hls.on(Hls.Events.ERROR, (e, data) => {
            if (!data.fatal) return;
            // Sin señal o códec que el navegador no reproduce (H.265): queda la imagen fija y se reintenta
            p.hls.destroy();
            p.hls = null;
            p.video.classList.remove('playing');
            p.retry = setTimeout(() => { p.retry = null; if (thumbPlayers[channel] === p) loadThumbPlayer(p, channel); }, 10000);
        });
        p.hls.loadSource(src);
        p.hls.attachMedia(p.video);
    } else if (p.video.canPlayType('application/vnd.apple.mpegurl')) {
        p.video.src = src; // Safari: HLS nativo
    }
}

function stopThumbPlayer(channel) {
    const p = thumbPlayers[channel];
    if (!p) return;
    delete thumbPlayers[channel];
    clearTimeout(p.retry);
    if (p.hls) p.hls.destroy();
    p.video.pause();
    p.video.removeAttribute('src');
    p.video.load();
    p.video.remove();
}

// Pestaña del navegador oculta: se paran los vídeos (el servidor apaga el HLS a los 15 s)
document.addEventListener('visibilitychange', syncThumbPlayers);

/* =======================================
 *  VISTA DE STREAMS: FILAS O MOSAICO (se recuerda en este navegador)
 * ======================================= */
function setStreamsView(mode) {
    if (mode !== 'grid') mode = 'list';
    document.getElementById('streamsContainer').classList.toggle('view-grid', mode === 'grid');
    document.querySelectorAll('#view-toggle button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === mode)));
    try { localStorage.setItem('streamsView', mode); } catch (e) {}
    syncThumbPlayers();
}
document.addEventListener('DOMContentLoaded', () => {
    let mode = 'list';
    try { mode = localStorage.getItem('streamsView') || 'list'; } catch (e) {}
    setStreamsView(mode);

    // Enlace a Grafana solo si está instalado (mismo equipo, su propio puerto)
    fetch('/api/status').then(r => r.json()).then(s => {
        if (!s.grafanaPort) return;
        const a = document.getElementById('nav-grafana');
        a.href = `${location.protocol}//${location.hostname}:${s.grafanaPort}/`;
        a.hidden = false;
        // Mismo enlace en la cabecera del historial (Dashboard y Analytics)
        const h = document.getElementById("history-grafana");
        if (h) { h.href = a.href; h.style.display = "inline-flex"; }
    }).catch(() => {});
});

// Modal Logic
// Se muestra (display), se fuerza el cálculo de estilos y se añade .open para que la transición arranque.
// (No requestAnimationFrame: se pausa con la pestaña en segundo plano y la ventana quedaba invisible tapando la página.)
// Al cerrar se quita .open y se oculta al terminar; si se reabre antes, la transición se invierte sin saltos.
function openModal(id) {
    const el = document.getElementById(id);
    clearTimeout(el._hideTimer);
    el.style.display = 'flex';
    void el.offsetWidth;
    el.classList.add('open');
    const first = [...el.querySelectorAll('input:not([type="hidden"]):not([disabled]), select, textarea')]
        .find(f => f.offsetParent !== null); // primer campo visible
    if (first) first.focus({ preventScroll: true });
}
function closeModal(id) {
    const el = document.getElementById(id);
    el.classList.remove('open');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { if (!el.classList.contains('open')) el.style.display = 'none'; }, 260);
    if (id === 'previewModal') {
        const video = document.getElementById('previewVideo');
        if (video) {
            video.pause();
            video.removeAttribute('src'); // Stop downloading segment
            video.load(); // Reset video element completely
        }
    }
}
// Esc cierra la ventana abierta
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal-overlay.open');
    if (open) closeModal(open.id);
});

// Avisos no bloqueantes (sustituyen a alert). type: 'error' | 'success' | 'info'
function toast(message, type = 'error', ms = 4500) {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toast-stack';
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    const icon = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    el.querySelector('span').textContent = message;
    stack.appendChild(el);
    void el.offsetWidth;
    el.classList.add('show');
    const dismiss = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 280); };
    el.addEventListener('click', dismiss);
    setTimeout(dismiss, ms);
}

// Borde de scroll en la cabecera fija: solo cuando hay contenido pasando por debajo
document.addEventListener('DOMContentLoaded', () => {
    const main = document.querySelector('.main-content');
    const bar = document.querySelector('.topbar');
    if (!main || !bar) return;
    const update = () => bar.classList.toggle('scrolled', main.scrollTop > 4);
    main.addEventListener('scroll', update, { passive: true });
    update();
});

function openOutputModal(channel) {
    document.getElementById('out_channel').value = channel;
    document.getElementById('out_is_edit').value = 'false';
    document.querySelector('#outputModal .modal-header h3').innerText = 'Add Output';
    document.getElementById('formOutput').reset();
    document.getElementById('out_srt_extra').value = ''; // reset() no limpia los hidden
    updateOutputFields();
    updateScaleHint();
    openModal('outputModal');
}

// "Add Input" siempre abre el formulario limpio: tras editar y cancelar seguía en modo edición
// con los datos de esa cámara, y al guardar la sobrescribía en vez de crear una nueva
function openAddInput() {
    document.getElementById('formInput').reset();
    document.getElementById('inp_is_edit').value = 'false';
    document.getElementById('inp_edit_channel').value = '';
    document.querySelector('#inputModal .modal-header h3').innerText = 'Add New Input Stream';
    updateInputFields();
    openModal('inputModal');
}

// API Interactions
function updateInputFields() {
    const proto = document.getElementById('inp_protocol').value;
    const listener = proto === 'srt_listener';
    const ipInput = document.getElementById('inp_ip');
    document.getElementById('inp_ip_container').style.display = listener ? 'none' : 'block';
    document.getElementById('inp_listener_container').style.display = listener ? 'flex' : 'none';
    ipInput.required = !listener;
    document.getElementById('inp_listen_port').required = listener;
    if (proto === 'srt_caller') {
        document.getElementById('inp_ip_label').innerText = 'URL SRT del emisor';
        ipInput.placeholder = 'srt://192.168.1.50:9000?streamid=cam1&passphrase=...';
    } else {
        document.getElementById('inp_ip_label').innerText = 'URL RTSP de la Cámara';
        ipInput.placeholder = 'rtsp://admin:12345@192.168.1.100:554/cam/realmonitor...';
    }
}

// URL guardada -> campos del formulario (tipo de fuente, puerto y passphrase del listener)
function fillInputFormFromUrl(url) {
    const protoEl = document.getElementById('inp_protocol');
    document.getElementById('inp_ip').value = url;
    document.getElementById('inp_listen_port').value = '';
    document.getElementById('inp_passphrase').value = '';
    if (/^srt:\/\//.test(url) && /[?&]mode=listener/.test(url)) {
        protoEl.value = 'srt_listener';
        const port = url.match(/^srt:\/\/[^:\/?]*:(\d+)/);
        const pass = url.match(/[?&]passphrase=([^&]+)/);
        document.getElementById('inp_listen_port').value = port ? port[1] : '';
        document.getElementById('inp_passphrase').value = pass ? pass[1] : '';
    } else {
        protoEl.value = /^srt:\/\//.test(url) ? 'srt_caller' : 'rtsp';
    }
}

function updateOutputFields() {
    const proto = document.getElementById('out_protocol').value;
    const modeContainer = document.getElementById('out_mode_container');
    const ipContainer = document.getElementById('out_ip_container');
    const portContainer = document.getElementById('out_port_container');
    const diskContainer = document.getElementById('out_disk_container');
    const ipLabel = document.getElementById('out_ip_label');
    const portLabel = document.getElementById('out_port_label');
    
    // Default hiding
    diskContainer.style.display = 'none';
    document.getElementById('out_latency_container').style.display = (proto === 'srt') ? 'block' : 'none';

    if (proto === 'srt') {
        modeContainer.style.display = 'block';
        portContainer.style.display = 'block';
        ipLabel.innerText = 'IP Destino';
        portLabel.innerText = 'Puerto';
        document.getElementById('out_port').type = 'number';
        const mode = document.getElementById('out_mode').value;
        ipContainer.style.display = (mode === 'listener') ? 'none' : 'block';
    } else if (proto === 'rtmp') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'RTMP URL de Youtube/Twitch/etc';
        document.getElementById('out_ip').placeholder = 'rtmp://a.rtmp.youtube.com/live2';
        portLabel.innerText = 'Stream Key';
        document.getElementById('out_port').placeholder = 'xxxx-xxxx-xxxx-xxxx';
        document.getElementById('out_port').type = 'text';
    } else if (proto === 'rtmp_local') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'none';
        portLabel.innerText = 'Generar Stream Key Propio';
        document.getElementById('out_port').placeholder = 'ej: streaming_final';
        document.getElementById('out_port').type = 'text';
    } else if (proto === 'disk') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'none';
        ipContainer.style.display = 'none';
        diskContainer.style.display = 'block';
        
        // Cargar discos para el dropdown
        fetch('/api/disks').then(r=>r.json()).then(disks => {
            const select = document.getElementById('out_disk');
            select.innerHTML = disks.map(d => `<option value="${d.path}">${d.name}</option>`).join('');
        });
        
        if (!document.getElementById('out_location').value || document.getElementById('out_location').value.startsWith('rec_')) {
            const channel = document.getElementById('out_channel').value;
            const inData = inputs.find(i => i.channel == channel);
            let inName = inData && inData.name ? inData.name.replace(/[^a-zA-Z0-9_\-]/g, '_') : ('CH' + channel);
            document.getElementById('out_location').value = inName + '_Grabacion.mp4';
        }
    } else {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'IP Destino';
        portLabel.innerText = 'Puerto';
        document.getElementById('out_port').type = 'number';
    }
}

function openEditInput(channel) {
    const input = inputs.find(i => i.channel === channel);
    if (!input) return;
    document.getElementById('inp_is_edit').value = 'true';
    document.getElementById('inp_edit_channel').value = channel;
    
    document.getElementById('inp_name').value = input.name;
    fillInputFormFromUrl(input.url);
    const bufEl = document.getElementById('inp_buffer');
    if(bufEl) bufEl.value = input.buffer || 0;
    document.getElementById('inp_latency').value = input.latency_ms || 0;
    
    updateInputFields();
    
    // Changing Modal Header
    document.querySelector('#inputModal .modal-header h3').innerText = 'Editar Entrada';
    openModal('inputModal');
}



// ===================================
// FILE MANAGEMENT LOGIC
// ===================================
// Disco elegido y archivos cargados: la búsqueda filtra en el navegador sin volver a pedirlos
let recDisk = null;
let recFiles = [];
let recDisks = [];

function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / Math.pow(1024, i);
    return `${v.toLocaleString('es-ES', { maximumFractionDigits: v < 10 && i > 1 ? 1 : 0 })} ${u[i]}`;
}

function diskLabel(d) {
    if (d.id === 'local_mediaroot') return d.name;
    const seg = String(d.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return seg || d.path;
}

async function fetchStorage() {
    const grid = document.getElementById('storageDisksGrid');
    if (!recDisks.length) grid.innerHTML = '<div class="rec-disk sk-card"></div><div class="rec-disk sk-card"></div>';
    try {
        const res = await fetch('/api/disks');
        recDisks = await res.json();
        if (!Array.isArray(recDisks)) recDisks = [];
    } catch (e) {
        grid.innerHTML = '<div class="rec-empty"><i class="fa-solid fa-plug-circle-xmark"></i><p>No se pudo consultar los discos.</p></div>';
        return;
    }
    if (!recDisks.length) {
        recDisk = null;
        grid.innerHTML = '<div class="rec-empty"><i class="fa-brands fa-usb"></i><h3>No hay discos conectados</h3><p>Conecta un USB al servidor y pulsa recargar.</p></div>';
        document.getElementById('storageFilesList').innerHTML = '';
        document.getElementById('recSummary').textContent = '';
        return;
    }
    if (!recDisks.find(d => d.path === recDisk)) recDisk = recDisks[0].path;
    renderDisks();
    fetchFiles();
}

function renderDisks() {
    document.getElementById('storageDisksGrid').innerHTML = recDisks.map(d => {
        const pct = d.size ? Math.min(100, Math.round(d.used / d.size * 100)) : null;
        const level = pct === null ? '' : pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
        const sel = d.path === recDisk;
        return `
            <button class="rec-disk ${sel ? 'selected' : ''}" role="radio" aria-checked="${sel}" data-path="${escapeHtml(d.path)}" onclick="selectDisk(this.dataset.path)">
                <div class="rec-disk-top">
                    <span class="rec-disk-icon"><i class="fa-solid fa-hard-drive"></i></span>
                    <span class="rec-disk-name">${escapeHtml(diskLabel(d))}${diskLabel(d) !== d.path ? `<small>${escapeHtml(d.path)}</small>` : ''}</span>
                    ${sel ? '<i class="fa-solid fa-circle-check rec-disk-check"></i>' : ''}
                </div>
                ${pct === null ? '<div class="rec-disk-meta">Capacidad desconocida</div>' : `
                <div class="rec-cap ${level}"><div style="width:${pct}%"></div></div>
                <div class="rec-disk-meta"><span><b>${fmtBytes(d.size - d.used)}</b> libres</span><span>${pct}% de ${fmtBytes(d.size)}</span></div>`}
            </button>`;
    }).join('');
}

function selectDisk(p) {
    if (p === recDisk) return;
    recDisk = p;
    recFiles = [];
    renderDisks();
    fetchFiles();
}

async function fetchFiles() {
    if (!recDisk) return;
    const list = document.getElementById('storageFilesList');
    if (!recFiles.length) list.innerHTML = '<div class="rec-row sk-row"></div><div class="rec-row sk-row"></div><div class="rec-row sk-row"></div>';
    try {
        const res = await fetch(`/api/files?disk=${encodeURIComponent(recDisk)}`);
        recFiles = await res.json();
        if (!Array.isArray(recFiles)) recFiles = [];
    } catch (e) {
        recFiles = [];
        list.innerHTML = '<div class="rec-empty"><p>No se pudo leer el disco.</p></div>';
        return;
    }
    renderFiles();
}

function recDayLabel(d) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    const txt = day.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
    return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function renderFiles() {
    const list = document.getElementById('storageFilesList');
    const q = (document.getElementById('recSearch').value || '').trim().toLowerCase();
    const files = q ? recFiles.filter(f => f.name.toLowerCase().includes(q)) : recFiles;
    const total = recFiles.reduce((a, f) => a + (f.size || 0), 0);
    document.getElementById('recSummary').textContent = recFiles.length
        ? `${recFiles.length} archivo${recFiles.length > 1 ? 's' : ''} · ${fmtBytes(total)}` : '';

    if (!recFiles.length) {
        list.innerHTML = '<div class="rec-empty"><i class="fa-regular fa-folder-open"></i><h3>Todavía no hay grabaciones</h3><p>Añade a una entrada una salida de tipo "Grabar en disco" y los archivos aparecerán aquí.</p></div>';
        return;
    }
    if (!files.length) {
        list.innerHTML = `<div class="rec-empty"><p>Ninguna grabación contiene «${escapeHtml(q)}».</p></div>`;
        return;
    }
    const now = Date.now();
    let html = '', lastDay = '';
    files.forEach(f => {
        const date = new Date(f.date);
        const day = recDayLabel(date);
        if (day !== lastDay) { html += `<div class="rec-day">${day}</div>`; lastDay = day; }
        const ext = (f.name.split('.').pop() || '').toUpperCase();
        // Escrito hace menos de 15 s: casi seguro que se está grabando ahora mismo
        const live = now - date.getTime() < 15000;
        const idx = recFiles.indexOf(f);
        html += `
            <div class="rec-row ${live ? 'live' : ''}">
                <button class="rec-thumb" onclick="previewRec(${idx})" title="Reproducir" aria-label="Reproducir ${escapeHtml(f.name)}"><i class="fa-solid fa-play"></i></button>
                <div class="rec-info">
                    <div class="rec-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
                    <div class="rec-meta">
                        ${live ? '<span class="rec-live"><span></span>Grabando</span>' : ''}
                        <span>${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span>
                        <span>${fmtBytes(f.size)}</span>
                        <span class="rec-ext">${escapeHtml(ext)}</span>
                    </div>
                </div>
                <div class="rec-actions">
                    <a class="action-btn" href="${f.url}" download="${escapeHtml(f.name)}" title="Descargar" aria-label="Descargar"><i class="fa-solid fa-download"></i></a>
                    <button class="action-btn delete-btn" onclick="deleteRec(${idx})" title="${live ? 'No se puede borrar mientras se graba' : 'Borrar'}" aria-label="Borrar" ${live ? 'disabled' : ''}><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;
    });
    list.innerHTML = html;
}

function previewRec(i) { const f = recFiles[i]; if (f) previewFile(f.url, f.name); }

async function deleteRec(i) {
    const f = recFiles[i];
    if (!f) return;
    if (!confirm(`¿Borrar «${f.name}» (${fmtBytes(f.size)})? No se puede deshacer.`)) return;
    try {
        const r = await fetch('/api/files/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath: f.url })
        });
        if (!r.ok) throw new Error();
        toast(`Borrada · ${f.name}`, 'success', 2500);
        recFiles = recFiles.filter(x => x !== f);
        renderFiles();
        fetchStorage(); // el espacio libre del disco cambia
    } catch (e) { toast('No se pudo borrar la grabación'); }
}

function previewFile(url, fname) {
    document.getElementById('previewTitle').innerText = fname;
    const video = document.getElementById('previewVideo');
    video.src = url;
    openModal('previewModal');
    video.play();
}

// Ensure video stops when modal is closed



// URL para mostrar en pantalla: oculta usuario:contraseña de la cámara y la passphrase SRT
// (el editor sigue mostrando la URL completa para poder cambiarla)
function displayUrl(url) {
    return String(url || '')
        .replace(/(\w+:\/\/)[^\s\/]*@/, '$1***@') // codicioso: hasta la última @ (claves con @)
        .replace(/(passphrase=)[^&]+/, '$1***');
}

// Latencia efectiva en ms de una URL SRT (la URL guarda µs; sin latency el servidor aplica 500 ms)
function srtLatencyMs(url) {
    const m = url.match(/[?&]latency=(\d+)/);
    if (!m) return 500;
    const v = parseInt(m[1]);
    return v < 1000 ? v : Math.round(v / 1000); // < 1000 el servidor lo trata como ms
}

function openEditOutput(id) {
    const out = outputs.find(o => o.id === id);
    if (!out) return;
    
    document.getElementById('out_is_edit').value = 'true';
    document.getElementById('out_edit_id').value = id;
    document.getElementById('out_srt_extra').value = '';
    document.getElementById('out_location').value = out.location;
    document.getElementById('out_vcodec').value = out.vcodec || 'copy';
    document.getElementById('out_channel').value = out.channel;
    document.getElementById('out_scale').value = String(out.scale || 0);
    updateScaleHint();
    
    // Parse url broadly
    if (out.url.startsWith('srt')) {
        document.getElementById('out_protocol').value = 'srt';
        const isListener = out.url.includes('mode=listener');
        document.getElementById('out_mode').value = isListener ? 'listener' : 'caller';
        const portMatch = out.url.match(/:(\d+)/);
        if(portMatch) document.getElementById('out_port').value = portMatch[1];
        if(!isListener) {
            const ipMatch = out.url.match(/\/\/([^:]+)/);
            if(ipMatch) document.getElementById('out_ip').value = ipMatch[1];
        }
        // Latencia: µs en la URL -> ms en el editor
        document.getElementById('out_latency').value = srtLatencyMs(out.url);
        // Conservar el resto de parámetros (passphrase, pbkeylen, streamid...) al guardar
        const query = out.url.split('?')[1] || '';
        document.getElementById('out_srt_extra').value = query.split('&')
            .filter(p => p && !/^(mode|pkt_size|latency)=/.test(p)).join('&');
    } else if (out.url.startsWith('rtmp://127.0.0.1:1935/out/')) {
        document.getElementById('out_protocol').value = 'rtmp_local';
        document.getElementById('out_port').value = out.url.replace('rtmp://127.0.0.1:1935/out/', '');
    } else if (out.url.startsWith('disk://')) {
        document.getElementById('out_protocol').value = 'disk';
        const fullDiskUrl = out.url.replace('disk://', '');
        const lastSlash = fullDiskUrl.lastIndexOf('/') > fullDiskUrl.lastIndexOf('\\') ? fullDiskUrl.lastIndexOf('/') : fullDiskUrl.lastIndexOf('\\');
        document.getElementById('out_location').value = fullDiskUrl.substring(lastSlash + 1);
        
        // Wait briefly for updateOutputFields to populate the disk select, then select the right one
        setTimeout(() => {
            const select = document.getElementById('out_disk');
            const pathMatch = fullDiskUrl.substring(0, lastSlash);
            if (select) {
                Array.from(select.options).forEach(opt => {
                    if (pathMatch.includes(opt.value)) select.value = opt.value;
                });
            }
        }, 150);
    } else if (out.url.startsWith('rtmp')) {
        document.getElementById('out_protocol').value = 'rtmp';
        const lastSlash = out.url.lastIndexOf('/');
        document.getElementById('out_ip').value = out.url.substring(0, lastSlash);
        document.getElementById('out_port').value = out.url.substring(lastSlash + 1);
    } else {
        document.getElementById('out_protocol').value = 'udp';
        const portMatch = out.url.match(/:(\d+)/);
        if(portMatch) document.getElementById('out_port').value = portMatch[1];
        const ipMatch = out.url.match(/\/\/([^:]+)/);
        if(ipMatch) document.getElementById('out_ip').value = ipMatch[1];
    }
    updateOutputFields();
    
    document.querySelector('#outputModal .modal-header h3').innerText = 'Editar Output Stream';
    openModal('outputModal');
}

async function submitInput(e) {
    e.preventDefault();
    let outUrl = (document.getElementById('inp_ip').value || '').trim();
    if (document.getElementById('inp_protocol').value === 'srt_listener') {
        const port = parseInt(document.getElementById('inp_listen_port').value, 10);
        const pass = document.getElementById('inp_passphrase').value.trim();
        if (!port || port < 1024 || port > 65535) { toast('Puerto de escucha no válido (1024–65535)'); return; }
        // FFmpeg no decodifica la URL SRT: la clave va tal cual, así que no puede llevar separadores de URL
        if (pass && !/^[^&?#=%\s]{10,79}$/.test(pass)) { toast('La passphrase debe tener entre 10 y 79 caracteres, sin espacios ni & ? # = %'); return; }
        outUrl = `srt://0.0.0.0:${port}?mode=listener&pkt_size=1316` + (pass ? `&passphrase=${pass}` : '');
    }

    const data = {
        name: document.getElementById('inp_name').value,
        url: outUrl,
        buffer: parseInt(document.getElementById('inp_buffer').value) || 0,
        latency_ms: parseInt(document.getElementById('inp_latency').value) || 0
    };
    
    const isEdit = document.getElementById('inp_is_edit').value === 'true';
    let res;
    if(isEdit) {
        const cId = document.getElementById('inp_edit_channel').value;
        res = await fetch(`/api/inputs/${cId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
    } else {
        res = await fetch('/api/inputs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
    }
    // Rechazo del servidor (p.ej. puerto SRT ya usado): avisar y dejar el formulario abierto para corregir
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'No se pudo guardar la entrada');
        return;
    }

    closeModal('inputModal');
    toast(isEdit ? 'Entrada actualizada' : 'Entrada creada', 'success', 2500);
    e.target.reset();
    document.getElementById('inp_is_edit').value = 'false';
    document.querySelector('#inputModal .modal-header h3').innerText = 'Add New Input Stream';
    updateInputFields();
}

async function submitOutput(e) {
    e.preventDefault();
    const proto = document.getElementById('out_protocol').value;
    const port = document.getElementById('out_port').value;
    let outUrl = '';

    if (proto === 'disk') {
        const disk = document.getElementById('out_disk').value;
        const location = document.getElementById('out_location').value || 'rec_' + Date.now() + '.mp4';
        let filename = location;
        if (!filename.match(/\.(mp4|mkv|ts)$/i)) filename += '.mp4';
        const slash = disk.endsWith('/') || disk.endsWith('\\') ? '' : '/';
        outUrl = `disk://${disk}${slash}${filename}`;
    } else if (proto === 'rtmp') {
        const ip = document.getElementById('out_ip').value;
        const key = document.getElementById('out_port').value;
        if(!ip || !key) { toast('Rellene la IP y la Clave para RTMP'); return; }
        outUrl = ip.endsWith('/') ? `${ip}${key}` : `${ip}/${key}`;
    } else if (proto === 'rtmp_local') {
        const key = document.getElementById('out_port').value || 'streaming_final';
        outUrl = `rtmp://127.0.0.1:${window.currentRtmpPort || 1935}/out/${key}`;
    } else if (proto === 'srt') {
        const mode = document.getElementById('out_mode').value;
        const ip = (mode === 'listener') ? '0.0.0.0' : document.getElementById('out_ip').value;
        if(!port) { toast('El puerto es obligatorio'); return; }
        // pkt_size=1316 (7 paquetes TS, estándar MTU) y latency en µs (FFmpeg/libsrt) desde el selector en ms
        const latencyMs = Math.min(10000, Math.max(20, parseInt(document.getElementById('out_latency').value) || 500));
        const extra = document.getElementById('out_srt_extra').value;
        outUrl = `srt://${ip}:${port}?mode=${mode}&pkt_size=1316&latency=${latencyMs * 1000}${extra ? '&' + extra : ''}`;
    } else {
        const ip = document.getElementById('out_ip').value || '127.0.0.1';
        if(!port) { toast('El puerto es obligatorio'); return; }
        outUrl = `udp://${ip}:${port}`;
    }

    const data = {
        channel: parseInt(document.getElementById('out_channel').value),
        url: outUrl,
        location: document.getElementById('out_location').value,
        vcodec: document.getElementById('out_vcodec').value || 'copy',
        scale: parseInt(document.getElementById('out_scale').value, 10) || 0
    };

    const isEdit = document.getElementById('out_is_edit').value === 'true';
    let res;
    if(isEdit) {
        const oId = document.getElementById('out_edit_id').value;
        res = await fetch(`/api/outputs/${oId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
    } else {
        res = await fetch('/api/outputs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
    }
    // Si el servidor rechaza (p.ej. puerto SRT ya usado) avisar y dejar el formulario abierto para corregir
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'No se pudo guardar la salida');
        return;
    }

    closeModal('outputModal');
    toast(isEdit ? 'Salida actualizada' : 'Salida creada', 'success', 2500);
    e.target.reset();
    document.getElementById('out_is_edit').value = 'false';
    document.querySelector('#outputModal .modal-header h3').innerText = 'Add Output';
    updateOutputFields();
}
async function fetchSettingsData() {
    try {
        const [resUsers, resPorts] = await Promise.all([
            fetch('/api/users'),
            fetch('/api/ports')
        ]);
        const users = await resUsers.json();
        const ports = await resPorts.json();
        
        // Populate Ports
        if (ports) {
            document.getElementById('cfg_chanMin').value = ports.chanMin;
            document.getElementById('cfg_chanMax').value = ports.chanMax;
            document.getElementById('cfg_udpMin').value = ports.udpMin;
            document.getElementById('cfg_udpMax').value = ports.udpMax;
            document.getElementById('cfg_rtmpPort').value = ports.rtmpPort || 1935;
            window.currentRtmpPort = ports.rtmpPort || 1935;
        }

        // Render Users
        const container = document.getElementById('usersListContainer');
        container.innerHTML = '';
        users.forEach(u => {
            const roleBadge = u.role === 4 ? '<span style="color:var(--color-red); font-weight:bold;">Admin</span>' : '<span style="color:var(--text-muted);">User</span>';
            container.innerHTML += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div>
                        <strong style="color:var(--text-main); font-size:1.05rem;">${u.username}</strong>
                        <div style="font-size:0.8rem; margin-top:2px;">Role: ${roleBadge} | ${u.email || 'No email'}</div>
                    </div>
                    <button class="action-btn terminate" onclick="deleteUser('${u.username}')" title="Borrar Cuenta" ${u.username==='admin'?'disabled':''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
        });
    } catch(e) { console.error("Error fetching settings:", e); }
}

async function savePorts(e) {
    e.preventDefault();
    const payload = {
        chanMin: parseInt(document.getElementById('cfg_chanMin').value),
        chanMax: parseInt(document.getElementById('cfg_chanMax').value),
        udpMin: parseInt(document.getElementById('cfg_udpMin').value),
        udpMax: parseInt(document.getElementById('cfg_udpMax').value),
        rtmpPort: parseInt(document.getElementById('cfg_rtmpPort').value)
    };
    try {
        await fetch('/api/ports', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        toast('Configuración de puertos actualizada', 'success');
    } catch(e) { console.error(e); }
}

async function submitUser(e) {
    e.preventDefault();
    const payload = {
        username: document.getElementById('usr_username').value,
        password: document.getElementById('usr_password').value,
        role: parseInt(document.getElementById('usr_role').value),
        email: document.getElementById('usr_email').value
    };
    try {
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            closeModal('userModal');
            fetchSettingsData();
        } else {
            const err = await res.json();
            toast('Error al crear usuario: ' + err.error);
        }
    } catch(e) { console.error(e); }
}

async function deleteUser(username) {
    if(!confirm(`¿Borrar definitivamente a ${username}?`)) return;
    try {
        await fetch(`/api/users/${username}`, { method: 'DELETE' });
        fetchSettingsData();
    } catch(e) { console.error(e); }
}

async function toggleInput(channel) {
    await fetch(`/api/inputs/${channel}/toggle`, { method: 'POST' });
    fetchData();
}

async function togglePreview(channelId) {
    try {
        await fetch(`/api/inputs/${channelId}/preview`, { method: 'POST' });
        // UI assumes success directly and waits for websocket, but we can optimistically disable polling for it
    } catch(e) { console.error('Error toggling preview', e); }
}

async function deleteInput(channelId) {
    if(confirm('Are you sure you want to delete this input and all its outputs?')) {
        await fetch(`/api/inputs/${channelId}`, { method: 'DELETE' });
    }
}

async function toggleOutput(id) {
    await fetch(`/api/outputs/${id}/toggle`, { method: 'POST' });
}

async function deleteOutput(id) {
    if(confirm('Are you sure you want to delete this output?')) {
        await fetch(`/api/outputs/${id}`, { method: 'DELETE' });
    }
}

/* =======================================
 *  RESOLUCIÓN QUE LLEGA Y CONSUMO REAL (CPU / GPU Intel)
 * ======================================= */
const videoInfo = {}; // canal -> { codec, width, height, fps, bits }
let lastProcStats = null;

function resLabel(v) {
    if (v.height >= 2160) return '4K';
    return v.height + 'p';
}
function videoText(v) {
    return `${v.codec} · ${v.width}×${v.height}${v.fps ? ' · ' + v.fps + ' fps' : ''}${v.bits > 8 ? ' · ' + v.bits + ' bits' : ''}`;
}
function setVideoInfo(channel, v) {
    if (!v) return;
    const prev = videoInfo[channel];
    videoInfo[channel] = v;
    if (prev && prev.width === v.width && prev.height === v.height && prev.fps === v.fps && prev.codec === v.codec) return;
    const badge = document.getElementById(`res-${channel}`);
    if (badge) { badge.hidden = false; badge.textContent = resLabel(v); badge.title = videoText(v); }
    const codec = document.getElementById(`codec-${channel}`);
    if (codec) codec.textContent = v.codec;
    const line = document.getElementById(`vinfo-${channel}`);
    if (line) line.innerHTML = '<i class="fa-solid fa-film"></i> Llega: ' + escapeHtml(videoText(v));
    // Las salidas de esa cámara muestran a qué resolución salen
    outputs.filter(o => String(o.channel) === String(channel)).forEach(o => {
        const el = document.getElementById(`use-out_${o.id}`);
        if (el) el.innerHTML = outputUseText(o, lastProcStats && lastProcStats.outputs ? lastProcStats.outputs[o.id] : null);
    });
}

const fmtPct = x => (x < 10 ? x.toFixed(1) : Math.round(x)) + ' %';
const useClass = x => x >= 70 ? 'hot' : x >= 40 ? 'warm' : '';

function outputUseText(o, u) {
    const vcodec = o.vcodec || 'copy';
    const src = videoInfo[o.channel];
    let what;
    if (vcodec === 'copy') {
        what = 'Copia directa' + (src ? ' · ' + resLabel(src) : '');
    } else {
        const target = o.scale && !(src && src.height <= o.scale) ? o.scale + 'p' : (src ? resLabel(src) : 'sin rescalar');
        const pipe = u && u.pipeline ? ({ GPU: 'todo en GPU', 'CPU+GPU': 'decodifica CPU, codifica GPU', CPU: 'CPU' }[u.pipeline] || '') : '';
        what = `${OUTPUT_CODECS[vcodec] || vcodec} · ${src && target !== resLabel(src) ? resLabel(src) + ' → ' : ''}${target}${pipe ? ' · ' + pipe : ''}`;
    }
    if (!u) return `<i class="fa-solid fa-microchip"></i> ${escapeHtml(what)}`;
    const gpuTitle = `GPU Intel · vídeo (decodificar/codificar) ${u.gpuDetail.video} % · render (escalar) ${u.gpuDetail.render} % · VPP ${u.gpuDetail.enhance} %`;
    return `<i class="fa-solid fa-microchip"></i> ${escapeHtml(what)} · <b class="${useClass(u.cpu)}">CPU ${fmtPct(u.cpu)}</b>` +
        (vcodec === 'copy' ? '' : ` · <b class="${useClass(u.gpu)}" title="${gpuTitle}">GPU ${fmtPct(u.gpu)}</b>`);
}

function renderProcStats(d) {
    if (!d || !d.supported) return;
    lastProcStats = d;
    outputs.forEach(o => {
        const el = document.getElementById(`use-out_${o.id}`);
        if (el) el.innerHTML = outputUseText(o, d.outputs[o.id]);
    });
    inputs.forEach(i => {
        const el = document.getElementById(`use-in-${i.channel}`);
        if (!el) return;
        const c = d.channels[i.channel];
        el.innerHTML = c ? `<i class="fa-solid fa-gauge"></i> Consumo de esta cámara: <b class="${useClass(c.cpu)}">CPU ${fmtPct(c.cpu)}</b> · <b class="${useClass(c.gpu)}">GPU ${fmtPct(c.gpu)}</b>` : '';
    });
    const tot = document.getElementById('proc-total');
    if (tot) {
        tot.hidden = false;
        tot.innerHTML = `<i class="fa-solid fa-microchip"></i> Vídeo (FFmpeg): <b class="${useClass(d.total.cpu)}">CPU ${fmtPct(d.total.cpu)}</b> · <b class="${useClass(d.total.gpu)}" title="Motor de vídeo ${d.total.gpuDetail.video} % · render ${d.total.gpuDetail.render} %">GPU Intel ${fmtPct(d.total.gpu)}</b>`;
    }
}

// Rescalar solo tiene sentido transcodificando
function updateScaleHint() {
    const vcodec = document.getElementById('out_vcodec').value || 'copy';
    const sel = document.getElementById('out_scale');
    const hint = document.getElementById('out_scale_hint');
    const src = videoInfo[document.getElementById('out_channel').value];
    sel.disabled = vcodec === 'copy';
    if (vcodec === 'copy') { sel.value = '0'; hint.textContent = 'Para rescalar hay que transcodificar: elige un códec, mejor Intel VAAPI.'; return; }
    const srcTxt = src ? `La cámara manda ${src.width}×${src.height}. ` : '';
    if (/_vaapi$/.test(vcodec)) hint.textContent = srcTxt + 'Intel VAAPI decodifica, escala y codifica en la GPU integrada, casi sin CPU. El consumo real aparece en la salida.';
    else if (/^lib/.test(vcodec)) hint.textContent = srcTxt + 'Por CPU: un 4K a 1080p puede ocupar varios núcleos. Mejor Intel VAAPI.';
    else hint.textContent = srcTxt;
}
document.addEventListener('DOMContentLoaded', () => {
    const v = document.getElementById('out_vcodec');
    if (v) v.addEventListener('change', updateScaleHint);
});

/* =======================================
 *  CODIFICACIÓN DE LA CÁMARA (Hikvision ISAPI / Dahua CGI)
 * ======================================= */
let camInfo = null;

function openCameraModal(channel) {
    const input = inputs.find(i => String(i.channel) === String(channel));
    if (!input) return;
    document.getElementById('cam_channel').value = channel;
    document.getElementById('cam_http_port').value = input.cam_http_port || 80;
    document.querySelector('#cameraModal .modal-header h3').textContent = 'Codificación · ' + (input.name || 'Canal ' + channel);
    const v = videoInfo[channel];
    document.getElementById('cam_received').innerHTML = v ? '<i class="fa-solid fa-film"></i> Llega ahora al servidor: <b>' + escapeHtml(videoText(v)) + '</b>' : '';
    openModal('cameraModal');
    loadCamera();
}

function setCamBusy(html) {
    camInfo = null;
    document.getElementById('cam_fields').disabled = true;
    document.getElementById('cam_submit').disabled = true;
    document.getElementById('cam_ident').innerHTML = html;
}

async function loadCamera() {
    const ch = document.getElementById('cam_channel').value;
    const port = parseInt(document.getElementById('cam_http_port').value, 10) || 80;
    setCamBusy('<span class="cam-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Preguntando a la cámara…</span>');
    let ok = false, d;
    try {
        const r = await fetch(`/api/inputs/${ch}/camera?port=${port}`);
        ok = r.ok;
        d = await r.json();
    } catch (e) { d = { error: 'Sin respuesta del servidor' }; }
    if (document.getElementById('cam_channel').value !== ch) return; // se abrió otra cámara mientras tanto
    if (!ok) {
        document.getElementById('cam_ident').innerHTML = '<span class="cam-error"><i class="fa-solid fa-triangle-exclamation"></i> ' + escapeHtml(d.error || 'Error') + '</span>';
        return;
    }
    camInfo = d;
    const inp = inputs.find(i => String(i.channel) === ch);
    if (inp) inp.cam_http_port = d.httpPort;
    document.getElementById('cam_ident').innerHTML = `<b>${escapeHtml(d.brand)}</b> ${escapeHtml(d.model)} · ${escapeHtml(d.stream)}` +
        (d.firmware ? `<br><small>Firmware ${escapeHtml(d.firmware)}</small>` : '');

    const c = d.current, caps = d.caps;
    const fill = (id, values, current, label) => {
        const list = [...values];
        if (current !== '' && current !== null && current !== undefined && !list.map(String).includes(String(current))) list.unshift(current);
        const el = document.getElementById(id);
        el.innerHTML = list.map(v => `<option value="${escapeHtml(String(v))}">${escapeHtml(label ? label(v) : String(v))}</option>`).join('');
        el.value = String(current);
    };
    const area = r => r.split('x').reduce((a, b) => a * b, 1);
    const resName = r => { const h = Number(r.split('x')[1]); return r.replace('x', '×') + (h >= 2160 ? ' (4K)' : h === 1080 ? ' (Full HD)' : h === 720 ? ' (HD)' : ''); };
    fill('cam_codec', caps.codecs.length ? caps.codecs : ['H.264', 'H.265'], c.codec);
    fill('cam_res', [...caps.resolutions].sort((a, b) => area(b) - area(a)), c.width && c.height ? `${c.width}x${c.height}` : '', resName);
    fill('cam_fps', [...new Set(caps.fps.length ? caps.fps : [25, 30, 50, 60])].sort((a, b) => b - a), c.fps, f => f + ' fps');
    document.getElementById('cam_rc').value = c.rc === 'VBR' ? 'VBR' : 'CBR';
    const br = document.getElementById('cam_bitrate');
    br.max = caps.bitrateMax || 32768;
    br.value = c.bitrate || 8192;
    const gop = document.getElementById('cam_gop');
    gop.max = caps.gopMax || 400;
    gop.value = c.gop || 50;
    document.getElementById('cam_smart_row').hidden = c.smartCodec !== true;
    document.getElementById('cam_smart').checked = c.smartCodec === true;
    document.getElementById('cam_fields').disabled = false;
    document.getElementById('cam_submit').disabled = false;
    updateCameraHints();
}

function updateCameraHints() {
    const fps = parseFloat(document.getElementById('cam_fps').value) || 25;
    const gop = parseInt(document.getElementById('cam_gop').value, 10) || 0;
    const h = parseInt((document.getElementById('cam_res').value || '').split('x')[1], 10) || 0;
    const sec = gop / fps;
    const tips = [];
    if (gop) tips.push(`Un keyframe cada ${sec.toFixed(sec < 10 ? 1 : 0)} s.` +
        (sec > 2 ? ` Para replay y para que Race Control y vMix enganchen rápido, mejor 1–2 s (GOP ${Math.round(fps)}–${Math.round(2 * fps)}).` : ''));
    if (h >= 2160) tips.push('4K: 12–16 Mbps en H.265 o 20–25 Mbps en H.264.');
    else if (h >= 1080) tips.push('1080p: 4–6 Mbps en H.265 o 6–8 Mbps en H.264.');
    document.getElementById('cam_hint').textContent = tips.join(' ');
}

async function submitCamera(e) {
    e.preventDefault();
    if (!camInfo) return;
    const ch = document.getElementById('cam_channel').value;
    const [width, height] = (document.getElementById('cam_res').value || 'x').split('x').map(Number);
    const body = {
        httpPort: parseInt(document.getElementById('cam_http_port').value, 10) || 80,
        codec: document.getElementById('cam_codec').value,
        width, height,
        fps: parseFloat(document.getElementById('cam_fps').value),
        rc: document.getElementById('cam_rc').value,
        bitrate: parseInt(document.getElementById('cam_bitrate').value, 10),
        gop: parseInt(document.getElementById('cam_gop').value, 10),
        smartCodec: camInfo.current.smartCodec === true && !document.getElementById('cam_smart').checked ? false : undefined
    };
    const btn = document.getElementById('cam_submit');
    btn.disabled = true;
    try {
        const r = await fetch(`/api/inputs/${ch}/camera`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'La cámara no aceptó el cambio'); btn.disabled = false; return; }
        delete videoInfo[ch]; // la nueva resolución se verá al reconectar
        closeModal('cameraModal');
        toast(d.rebootRequired ? 'Aplicado. La cámara pide reiniciarse para terminar el cambio.' : 'Aplicado en la cámara. La entrada se reconecta con la nueva codificación.', 'success', 4500);
    } catch (err) {
        toast('Sin respuesta del servidor');
        btn.disabled = false;
    }
}

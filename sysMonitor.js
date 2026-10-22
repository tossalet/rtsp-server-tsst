const os = require('os');
const si = require('systeminformation');
const db = require('./db');
const streamManager = require('./streamManager');

let ioInstance = null;
let lastCpu = os.cpus();
let smoothedCpu = 0;
let dbCache = { streamsTotal: 0, streamsActive: 0, streamsError: 0 };
let lastDbPoll = 0;
let cpuTempCache = '--';
let lastTempPoll = 0;

function getCpuLoad() {
    const cpus = os.cpus();
    let idleDiff = 0;
    let totalDiff = 0;

    for (let i = 0; i < cpus.length; i++) {
        const cpu = cpus[i];
        const last = lastCpu[i] || cpu;

        let total = 0, lastTotal = 0;
        for (const type in cpu.times) total += cpu.times[type];
        for (const type in last.times) lastTotal += last.times[type];

        idleDiff += (cpu.times.idle - last.times.idle);
        totalDiff += (total - lastTotal);
    }

    lastCpu = cpus;
    if (totalDiff === 0) return smoothedCpu;

    const rawCpu = 100 - ((idleDiff / totalDiff) * 100);

    // Exponential Moving Average (EMA) para suavizar la lectura y ocultar los micropicos de FFmpeg (20% current, 80% history)
    if (smoothedCpu === 0) smoothedCpu = rawCpu;
    else smoothedCpu = (rawCpu * 0.2) + (smoothedCpu * 0.8);

    return smoothedCpu;
}

function setIo(io) {
    ioInstance = io;
    startMonitoring();
}

function startMonitoring() {
    async function loop() {
        if (!ioInstance) return;

        try {
            const currentCpuLoad = getCpuLoad();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            const netStats = streamManager.getTotalBitrates();

            const now = Date.now();
            if (now - lastDbPoll > 10000) {
                lastDbPoll = now;
                // Count streams logically from DB
                db.all('SELECT enabled FROM inputs UNION ALL SELECT enabled FROM outputs', [], (err, rows) => {
                    if (!rows) return;
                    const streamsActive = rows.filter(r => r.enabled).length;
                    dbCache = { streamsTotal: rows.length, streamsActive, streamsError: rows.length - streamsActive };
                });
            }

            // La temperatura cambia despacio; en Windows cada lectura lanza un proceso externo
            if (now - lastTempPoll > 10000) {
                lastTempPoll = now;
                const cpuTempData = await si.cpuTemperature();
                cpuTempCache = cpuTempData && cpuTempData.main ? cpuTempData.main.toFixed(1) : '--';
            }

            ioInstance.emit('sys_stats', {
                cpuLoad: currentCpuLoad.toFixed(1),
                cpuTemp: cpuTempCache,
                memUsed: (usedMem / (1024*1024*1024)).toFixed(2), // GB
                memTotal: (totalMem / (1024*1024*1024)).toFixed(2), // GB
                memPercent: ((usedMem / totalMem) * 100).toFixed(1),
                netTx: netStats.tx, // Mbps
                netRx: netStats.rx, // Mbps
                streamsTotal: dbCache.streamsTotal,
                streamsActive: dbCache.streamsActive,
                streamsError: dbCache.streamsError
            });
        } catch (e) {
            console.error("System Polling Error", e);
        }

        setTimeout(loop, 2500);
    }

    loop(); // init
}

module.exports = { setIo };

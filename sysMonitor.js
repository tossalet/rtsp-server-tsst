const os = require('os');
const db = require('./db');
const streamManager = require('./streamManager');

let ioInstance = null;
let lastCpu = os.cpus();

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
    if (totalDiff === 0) return 0;
    return 100 - ((idleDiff / totalDiff) * 100);
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

            // Count streams logically from DB
            db.all('SELECT enabled FROM inputs', [], (err, inps) => {
                db.all('SELECT enabled FROM outputs', [], (err, outs) => {
                    let streamsTotal = 0, streamsActive = 0, streamsError = 0;
                    if(inps) {
                        streamsTotal += inps.length;
                        inps.forEach(i => i.enabled ? streamsActive++ : streamsError++);
                    }
                    if(outs) {
                        streamsTotal += outs.length;
                        outs.forEach(i => i.enabled ? streamsActive++ : streamsError++);
                    }

                    const stats = {
                        cpuLoad: currentCpuLoad.toFixed(1),
                        memUsed: (usedMem / (1024*1024*1024)).toFixed(2), // GB
                        memTotal: (totalMem / (1024*1024*1024)).toFixed(2), // GB
                        memPercent: ((usedMem / totalMem) * 100).toFixed(1),
                        netTx: netStats.tx, // Mbps
                        netRx: netStats.rx, // Mbps
                        streamsTotal,
                        streamsActive,
                        streamsError
                    };

                    ioInstance.emit('sys_stats', stats);
                });
            });
        } catch (e) {
            console.error("System Polling Error", e);
        }

        setTimeout(loop, 2500);
    }
    
    loop(); // init
}

module.exports = { setIo };

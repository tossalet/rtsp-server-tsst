const si = require('systeminformation');
const db = require('./db');

let ioInstance = null;

function setIo(io) {
    ioInstance = io;
    startMonitoring();
}

function startMonitoring() {
    async function loop() {
        if (!ioInstance) return;

        try {
            const [cpu, mem, net] = await Promise.all([
                si.currentLoad(),
                si.mem(),
                si.networkStats() // Auto-detect interfaces instead of 'default' string
            ]);

            let txSeq = 0, rxSeq = 0;
            if (net && net.length > 0) {
                net.forEach(iface => {
                    if (iface.operstate === 'up' && iface.iface !== 'lo') {
                        txSeq += iface.tx_sec || 0;
                        rxSeq += iface.rx_sec || 0;
                    }
                });
            }

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
                        cpuLoad: cpu.currentLoad.toFixed(1),
                        memUsed: (mem.active / (1024*1024*1024)).toFixed(2), // GB
                        memTotal: (mem.total / (1024*1024*1024)).toFixed(2), // GB
                        memPercent: ((mem.active / mem.total) * 100).toFixed(1),
                        netTx: ((txSeq * 8) / (1024*1024)).toFixed(2), // Mbps
                        netRx: ((rxSeq * 8) / (1024*1024)).toFixed(2), // Mbps
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

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const util = require('util');
const db = require('./db');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const si = require('systeminformation');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
streamManager.setIo(io);
sysMonitor.setIo(io);

// Custom System Logger
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
}
const logFile = path.join(logsDir, 'server.log');

// Rotación simple al arrancar: el log crecía sin límite en el disco del mini PC
try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 10 * 1024 * 1024) {
        fs.renameSync(logFile, logFile + '.old');
    }
} catch (e) {}

const logHistory = [];
function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function broadCastLog(level, message) {
    const logEntry = { timestamp: getTimestamp(), level, message };
    if (io) io.emit('server_log', logEntry);
    logHistory.push(logEntry);
    if (logHistory.length > 500) logHistory.shift(); // Keep last 500 lines in memory
    fs.appendFile(logFile, `[${logEntry.timestamp}] [${level}] ${message}\n`, () => {});
}

// Intercept Console
const originalLog = console.log;
console.log = function(...args) {
    const msg = util.format(...args);
    originalLog.apply(console, args);
    broadCastLog('INFO', msg);
};

const originalError = console.error;
console.error = function(...args) {
    const msg = util.format(...args);
    originalError.apply(console, args);
    broadCastLog('ERROR', msg);
};

// Media Root for USB Recording and Playback
const mediaRoot = process.platform === 'win32' ? path.join(__dirname, 'media') : '/media';
if (!fs.existsSync(mediaRoot)) {
    try { fs.mkdirSync(mediaRoot, { recursive: true }); } catch (e) {}
}

// Carpetas donde se permite listar, reproducir y borrar ficheros
const allowedRoots = process.platform === 'win32' ? [mediaRoot] : [mediaRoot, '/mnt'];

// Resuelve la ruta (elimina ../) y comprueba que queda DENTRO de una carpeta permitida.
// Antes se usaba includes('/media'), que dejaba pasar rutas como /media/../etc
function resolveAllowed(p) {
    if (!p || typeof p !== 'string') return null;
    const resolved = path.resolve(p);
    const ok = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    return ok ? resolved : null;
}

const thumbsDir = path.join(__dirname, 'public', 'thumbs');
if (!fs.existsSync(thumbsDir)) {
    try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch(e){}
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple API status endpoint
app.get('/api/status', (req, res) => {
    res.json({ online: true, app: 'RTSP_SERVER_TSST', version: '1.0.0' });
});

app.get('/api/server-ip', (req, res) => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return res.json({ ip: iface.address });
            }
        }
    }
    res.json({ ip: '127.0.0.1' });
});

app.get('/api/logs', (req, res) => {
    res.json(logHistory);
});

app.get('/api/logs/download', (req, res) => {
    if (fs.existsSync(logFile)) {
        res.download(logFile, 'server_log.txt');
    } else {
        res.status(404).send("No log file found.");
    }
});

/* =======================================
 *  REST API: INPUTS
 * ======================================= */
app.get('/api/inputs', (req, res) => {
    db.all('SELECT * FROM inputs ORDER BY channel ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/inputs', (req, res) => {
    const { url, name, provider, location, remote, enabled, buffer } = req.body;

    // udpsrv ya no se usa para enrutar (la distribución es por pipes en memoria); se conserva la columna por compatibilidad
    const query = `INSERT INTO inputs (url, name, provider, location, remote, enabled, udpsrv, preview_enabled, buffer)
                   VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`;
    const params = [ url || '', name || 'Stream', provider || 'TodoStreaming', location || '', remote || '',
                     enabled !== false ? 1 : 0, buffer || 0 ];

    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const channelId = this.lastID;
        res.status(201).json({ channel: channelId });
        io.emit('db_update', { event: 'inputs_changed' });

        // If enabled, auto-start stream Manager
        if (enabled !== false) {
            db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
                if (row) streamManager.startInput(row);
            });
        }
    });
});

app.post('/api/inputs/:channel/toggle', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        db.run('UPDATE inputs SET enabled = ? WHERE channel = ?', [newEnabled, channelId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('db_update', { event: 'input_toggled', channel: channelId, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                streamManager.startInput({ ...row, enabled: 1 });

                // Memory Feature: Restore previously active outputs (el input ya está registrado, en orden garantizado)
                db.all('SELECT * FROM outputs WHERE channel = ? AND was_enabled = 1', [channelId], (err, outputs) => {
                    if (outputs && outputs.length > 0) {
                        db.run('UPDATE outputs SET enabled = 1, was_enabled = 0 WHERE channel = ? AND was_enabled = 1', [channelId], () => {
                            io.emit('db_update', { event: 'outputs_changed' });
                            outputs.forEach(outRow => streamManager.startOutput(outRow));
                        });
                    }
                });
            } else {
                streamManager.stopInput(channelId);

                // Memory Feature: Save active outputs and disable them
                db.all('SELECT * FROM outputs WHERE channel = ? AND enabled = 1', [channelId], (err, outputs) => {
                    if (outputs && outputs.length > 0) {
                        db.run('UPDATE outputs SET was_enabled = 1, enabled = 0 WHERE channel = ? AND enabled = 1', [channelId], () => {
                            io.emit('db_update', { event: 'outputs_changed' });
                            outputs.forEach(outRow => streamManager.stopOutput(outRow.id));
                        });
                    }
                });
            }
        });
    });
});

app.post('/api/inputs/:channel/preview', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT preview_enabled FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newState = row.preview_enabled ? 0 : 1;
        db.run('UPDATE inputs SET preview_enabled = ? WHERE channel = ?', [newState, channelId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('db_update', { event: 'preview_changed', channel: channelId, preview_enabled: newState });

            const inp = streamManager.activeInputs[channelId];
            if (inp) inp.inputObj.preview_enabled = newState; // que los reinicios automáticos respeten el estado

            // Continuo, o un único fotograma congelado al pararlo
            streamManager.startPreview(channelId, newState === 0);
            res.json({ preview_enabled: newState });
        });
    });
});

app.post('/api/inputs/:channel/snapshot', (req, res) => {
    const channelId = req.params.channel;
    const inp = streamManager.activeInputs[channelId];
    // No sustituir una preview continua por un snapshot
    if (inp && !(inp.prevProcess && inp.inputObj.preview_enabled)) {
        streamManager.startPreview(channelId, true);
    }
    res.json({ status: 'Snapshot requested' });
});

app.put('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    const { url, name, buffer } = req.body;
    const query = `UPDATE inputs SET url = ?, name = ?, buffer = ? WHERE channel = ?`;

    db.run(query, [url, name, buffer || 0, channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const changes = this.changes;

        // Restart the process if it was running with new data (los outputs siguen suscritos al canal)
        streamManager.stopInput(channelId);
        db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
            if (row && row.enabled) streamManager.startInput(row);
            io.emit('db_update', { event: 'inputs_changed' });
            res.json({ updated: changes });
        });
    });
});

app.delete('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;

    db.all('SELECT id FROM outputs WHERE channel = ?', [channelId], (err, rows) => {
        if (rows) rows.forEach(r => streamManager.stopOutput(r.id));
        streamManager.removeChannel(channelId);

        db.run('DELETE FROM outputs WHERE channel = ?', [channelId], () => {
            db.run('DELETE FROM inputs WHERE channel = ?', [channelId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ deleted: true });
                io.emit('db_update', { event: 'inputs_changed' });
            });
        });
    });
});

/* =======================================
 *  REST API: OUTPUTS
 * ======================================= */
app.get('/api/outputs', (req, res) => {
    db.all('SELECT * FROM outputs', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/outputs', (req, res) => {
    const { channel, url, location, remote, enabled, vcodec } = req.body;
    if (!channel) return res.status(400).json({ error: "Input 'channel' is required" });

    db.get('SELECT channel FROM inputs WHERE channel = ?', [channel], (err, parentRaw) => {
        if (err || !parentRaw) return res.status(400).json({ error: "Parent input not found" });

        const query = `INSERT INTO outputs (channel, url, location, remote, enabled, udpsrv, vcodec)
                       VALUES (?, ?, ?, ?, ?, 0, ?)`;
        const params = [ channel, url || '', location || '', remote || '', enabled !== false ? 1 : 0, vcodec || 'copy' ];

        db.run(query, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const outId = this.lastID;
            res.status(201).json({ id: outId });
            io.emit('db_update', { event: 'outputs_changed' });

            if (enabled !== false) {
                db.get('SELECT * FROM outputs WHERE id = ?', [outId], (err, row) => {
                    if (row) streamManager.startOutput(row);
                });
            }
        });
    });
});

app.post('/api/outputs/:id/toggle', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        db.run('UPDATE outputs SET enabled = ?, was_enabled = 0 WHERE id = ?', [newEnabled, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('db_update', { event: 'output_toggled', id: id, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                streamManager.startOutput({ ...row, enabled: 1 });
            } else {
                streamManager.stopOutput(id);
            }
        });
    });
});

app.put('/api/outputs/:id', (req, res) => {
    const id = req.params.id;
    const { url, location, vcodec } = req.body;
    db.run(`UPDATE outputs SET url = ?, location = ?, vcodec = ? WHERE id = ?`, [url, location, vcodec || 'copy', id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const changes = this.changes;

        // Restart the process if it was running with new data
        streamManager.stopOutput(id);
        db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, row) => {
            if (row && row.enabled) streamManager.startOutput(row);
            io.emit('db_update', { event: 'outputs_changed' });
            res.json({ updated: changes });
        });
    });
});

app.delete('/api/outputs/:id', (req, res) => {
    const id = req.params.id;
    streamManager.stopOutput(id);

    db.run('DELETE FROM outputs WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
        io.emit('db_update', { event: 'outputs_changed' });
    });
});

/* =======================================
 *  REST API: SETTINGS / USERS / PORTS
 * ======================================= */
app.get('/api/users', (req, res) => {
    db.all('SELECT username, role, email FROM users', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/users', (req, res) => {
    const { username, password, role, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing fields" });
    db.run('INSERT INTO users (username, password, role, email) VALUES (?, ?, ?, ?)', [username, password, role || 2, email || ''], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ success: true });
    });
});

app.delete('/api/users/:username', (req, res) => {
    const user = req.params.username;
    if (user === 'admin') return res.status(403).json({ error: 'Cannot delete root admin' }); // Prevent lockout
    db.run('DELETE FROM users WHERE username = ?', [user], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

/* =======================================
 *  REST API: FILES / STORAGE
 * ======================================= */
app.get('/api/disks', async (req, res) => {
    try {
        const drives = [];

        // Escáner dinámico multi-plataforma real (Evita trampas de carpetas vacías /media/usb0 sin montar)
        const fsSizes = await si.fsSize();

        fsSizes.forEach(f => {
            // En Linux, quedarnos con externos (media/mnt). En Windows, discos secundarios
            if (f.mount && (f.mount.startsWith('/media') || f.mount.startsWith('/mnt') || (process.platform === 'win32' && f.mount !== 'C:\\' && f.mount !== 'C:'))) {
                drives.push({
                    id: f.mount.replace(/[:\\\/]/g, '_'), // ID seguro
                    name: `[${f.fs}] ${f.mount}`, // ej: [sda1] /media/pi/USB
                    path: f.mount
                });
            }
        });

        // Incluir siempre mediaRoot como disco de grabación local, el primero
        if (!drives.find(d => d.path === mediaRoot)) {
            drives.unshift({ id: 'local_mediaroot', name: 'Grabaciones Locales (/media)', path: mediaRoot });
        }

        res.json(drives);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* =======================================
 *  REST API: DISK WIPE (borrado rápido)
 * ======================================= */
app.post('/api/disks/wipe', (req, res) => {
    const diskPath = resolveAllowed(req.body.disk_path);
    if (!diskPath) return res.status(403).json({ error: 'Ruta no permitida. Solo discos bajo /media o /mnt.' });

    try {
        if (!fs.existsSync(diskPath)) return res.status(404).json({ error: 'Ruta no encontrada' });
        let removed = 0;
        for (const item of fs.readdirSync(diskPath)) {
            try {
                fs.rmSync(path.join(diskPath, item), { recursive: true, force: true });
                removed++;
            } catch(e) {
                // continue with next file
            }
        }
        res.json({ ok: true, removed });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/files', (req, res) => {
    // ParentDisk es una ruta ABSOLUTA enviada desde el frontend
    const scanPath = resolveAllowed(req.query.disk);
    if (!scanPath) return res.json([]);

    try {
        if (!fs.existsSync(scanPath)) return res.json([]);
        const files = [];
        for (const item of fs.readdirSync(scanPath, { withFileTypes: true })) {
            if (item.isFile() && item.name.match(/\.(mp4|mkv|ts|flv|m3u8)$/i)) {
                const absolutePath = path.join(scanPath, item.name);
                const stat = fs.statSync(absolutePath);
                files.push({
                    name: item.name,
                    size: stat.size,
                    date: stat.mtime,
                    url: `/api/media/play?path=${encodeURIComponent(absolutePath)}`,
                    absolutePath: absolutePath
                });
            }
        }
        res.json(files.sort((a,b) => b.date - a.date)); // Fechas más recientes primero
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Play endpoint para servir ficheros de carpetas absolutas como /mnt/usb
app.get('/api/media/play', (req, res) => {
    const fpath = resolveAllowed(req.query.path);
    if (!fpath) return res.status(403).send('Forbidden area');
    if (!fs.existsSync(fpath)) return res.status(404).send('Not found');
    res.sendFile(fpath);
});

app.post('/api/files/delete', (req, res) => {
    const { filepath } = req.body;

    // filepath podría venir como /api/media/play?path=...
    let rawPath = filepath;
    if (filepath && filepath.includes('?path=')) {
        rawPath = decodeURIComponent(filepath.split('?path=')[1]);
    }

    const absolutePath = resolveAllowed(rawPath);
    if (!absolutePath) return res.status(403).json({ error: 'Acceso denegado a esa ruta' });
    if (!fs.existsSync(absolutePath)) return res.status(400).json({ error: 'Ruta invalida o no existe' });

    try {
        fs.unlinkSync(absolutePath);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/ports', (req, res) => {
    db.get('SELECT * FROM ports LIMIT 1', [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

app.put('/api/ports', (req, res) => {
    const { chanMin, chanMax, udpMin, udpMax } = req.body;

    db.run('UPDATE ports SET chanMin=?, chanMax=?, udpMin=?, udpMax=?',
        [chanMin, chanMax, udpMin, udpMax], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: true });
    });
});

/* =======================================
 *  BOOT SEQUENCE
 * ======================================= */

// Boot active streams based on DB state (Resume capability)
function bootActiveStreams() {
    console.log("[BOOT] Iniciando secuencia de encendido escalonado de Streams...");
    db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, rows) => {
        if (!rows || rows.length === 0) return;
        let delayAccumulator = 0;

        // Stagger inputs by 200ms each to prevent CPU max-out
        rows.forEach(r => {
            setTimeout(() => streamManager.startInput(r), delayAccumulator);
            delayAccumulator += 200;
        });

        // Outputs after all inputs are registered
        db.all('SELECT * FROM outputs WHERE enabled = 1', [], (err, outRows) => {
            if (!outRows) return;
            outRows.forEach(o => {
                setTimeout(() => streamManager.startOutput(o), delayAccumulator);
                delayAccumulator += 200;
            });
        });
    });
}
db.ready.then(bootActiveStreams);

io.on('connection', (socket) => {
    console.log(`Frontend Connected: ${socket.id}`);
});

// Start Server
const PORT = process.env.PORT || 4000;
let _listenRetries = 0;
const _MAX_LISTEN_RETRIES = 15; // 15 x 4s = 60s máx

function startListen() {
    server.listen(PORT, '0.0.0.0', () => {
        _listenRetries = 0;
        console.log(`TSST SERVER running on port ${PORT}`);
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        _listenRetries++;
        if (_listenRetries > _MAX_LISTEN_RETRIES) {
            originalLog(`[SERVER] Puerto ${PORT} no disponible tras ${_MAX_LISTEN_RETRIES} intentos.`);
            originalLog(`[SERVER] Asegúrate de que no hay otro proceso en el puerto ${PORT} y reinicia.`);
            process.exit(1);
        }
        originalLog(`[SERVER] Port ${PORT} busy (TIME_WAIT), retrying in 4s... (${_listenRetries}/${_MAX_LISTEN_RETRIES})`);
        setTimeout(startListen, 4000);
    } else {
        originalLog(`[SERVER] Fatal error: ${err.message}`);
        process.exit(1);
    }
});

startListen();

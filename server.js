const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const db = require('./db');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const si = require('systeminformation');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
streamManager.setIo(io);
sysMonitor.setIo(io);

// Media Root for USB Recording and Playback
const mediaRoot = process.platform === 'win32' ? path.join(__dirname, 'media') : '/media';
if (!fs.existsSync(mediaRoot)) {
    try { fs.mkdirSync(mediaRoot, { recursive: true }); } catch (e) {}
}

const thumbsDir = path.join(__dirname, 'public', 'thumbs');
if (!fs.existsSync(thumbsDir)) {
    try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch(e){}
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(mediaRoot));

// Simple API status endpoint
app.get('/api/status', (req, res) => {
    res.json({ online: true, app: 'RTSP_SERVER_TSST', version: '1.0.0' });
});

const os = require('os');
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
    const { url, name, provider, location, remote, audiowtdg, wtdgsecs, enabled } = req.body;
    
    // Asignar Udpsrv respetando los límites de Firewall (Settings)
    db.get('SELECT udpMin, udpMax FROM ports LIMIT 1', [], (err, ports) => {
        let udpsrv = req.body.udpsrv;
        if (!udpsrv) {
            const min = ports ? ports.udpMin : 10000;
            const max = ports ? ports.udpMax : 30000;
            udpsrv = Math.floor(Math.random() * (max - min + 1)) + min;
        }
        
        const query = `INSERT INTO inputs (url, name, provider, location, remote, enabled, udpsrv) 
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [ url || '', name || 'Stream', provider || 'TodoStreaming', location || '', remote || '', 
                         enabled !== false ? 1 : 0, udpsrv ];
        
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
});

// For simplicity, a toggle endpoint
app.post('/api/inputs/:channel/toggle', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        db.run('UPDATE inputs SET enabled = ? WHERE channel = ?', [newEnabled, channelId], function(err) {
            io.emit('db_update', { event: 'input_toggled', channel: channelId, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                // Must get updated row to spawn
                db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, newRow) => {
                   if (newRow) streamManager.startInput(newRow);
                });
            } else {
                streamManager.stopInput(channelId);
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
            
            // Start or stop the actual visual ffmpeg processor independently 
            if (newState === 1) {
                streamManager.startPreview(channelId);
            } else {
                streamManager.stopPreview(channelId);
                // Extraer un fotograma congelado al pararlo
                setTimeout(() => streamManager.startPreview(channelId, true), 1000);
            }
            res.json({ preview_enabled: newState });
        });
    });
});

app.post('/api/inputs/:channel/snapshot', (req, res) => {
    const channelId = req.params.channel;
    streamManager.startPreview(channelId, true);
    res.json({ status: 'Snapshot requested' });
});

app.put('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    const { url, name } = req.body;
    const query = `UPDATE inputs SET url = ?, name = ? WHERE channel = ?`;
    
    db.run(query, [url, name, channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Restart the process if it was running with new data
        streamManager.stopInput(channelId);
        db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
            if (row && row.enabled) streamManager.startInput(row);
            io.emit('db_update', { event: 'inputs_changed' });
            res.json({ updated: this.changes });
        });
    });
});

app.delete('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    streamManager.stopInput(channelId);

    db.run('DELETE FROM inputs WHERE channel = ?', [channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        
        // Stop related outputs
        db.all('SELECT id FROM outputs WHERE channel = ?', [channelId], (err, rows) => {
            if (rows) rows.forEach(r => streamManager.stopOutput(r.id));
            db.run('DELETE FROM outputs WHERE channel = ?', [channelId], () => {
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
    
    // We need the udpsrv of the parent channel to link them
    db.get('SELECT udpsrv FROM inputs WHERE channel = ?', [channel], (err, parentRaw) => {
        if (err || !parentRaw) return res.status(400).json({ error: "Parent input not found" });

        const udpsrv = parentRaw.udpsrv;
        const query = `INSERT INTO outputs (channel, url, location, remote, enabled, udpsrv, vcodec) 
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [ channel, url || '', location || '', remote || '', enabled !== false ? 1 : 0, udpsrv, vcodec || 'copy' ];
        
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
        db.run('UPDATE outputs SET enabled = ? WHERE id = ?', [newEnabled, id], function(err) {
            io.emit('db_update', { event: 'output_toggled', id: id, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, newRow) => {
                   if (newRow) streamManager.startOutput(newRow);
                });
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
        
        // Restart the process if it was running with new data
        streamManager.stopOutput(id);
        db.get('SELECT o.*, i.udpsrv FROM outputs o JOIN inputs i ON o.channel = i.channel WHERE o.id = ?', [id], (err, row) => {
            if (row && row.enabled) streamManager.startOutput(row);
            io.emit('db_update', { event: 'outputs_changed' });
            res.json({ updated: this.changes });
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
        let drives = [];
        
        // Escáner dinámico multi-plataforma real (Evita trampas de carpetas vacías /media/usb0 sin montar)
        const fsSizes = await si.fsSize();
        
        fsSizes.forEach(f => {
            // En Linux, ignorar particiones internas base y quedarnos con externos (media/mnt). En Windows, coger discos secundarios
            if (f.mount && (f.mount.startsWith('/media') || f.mount.startsWith('/mnt') || (process.platform === 'win32' && f.mount !== 'C:\\' && f.mount !== 'C:'))) {
                drives.push({
                    id: f.mount.replace(/[:\\\/]/g, '_'), // ID seguro
                    name: `[${f.fs}] ${f.mount}`, // ej: [sda1] /media/pi/USB
                    path: f.mount
                });
            }
        });

        // Fallback robusto/Manual: Si no hay discos detectados por hardware, metemos nuestro default
        if (drives.length === 0) {
            if (process.platform === 'win32') {
                drives.push({ id: 'local_test', name: 'Disco Prueba', path: mediaRoot });
            } else if (fs.existsSync(mediaRoot)) { // Unix fallback
                drives.push({ id: 'local_unix', name: 'Ruta Host Local', path: mediaRoot });
            }
        }
        
        res.json(drives);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/files', (req, res) => {
    // ParentDisk es ahora una ruta ABSOLUTA enviada desde el frontend
    const scanPath = req.query.disk;
    if (!scanPath) return res.json([]);
    
    try {
        if (!fs.existsSync(scanPath)) return res.json([]);
        const files = [];
        
        // Scan recursivo simple o de 1 nivel
        const items = fs.readdirSync(scanPath, { withFileTypes: true });
        for (const item of items) {
            if (item.isFile() && item.name.match(/\.(mp4|mkv|ts|flv)$/i)) {
                const absolutePath = path.join(scanPath, item.name);
                const stat = fs.statSync(absolutePath);
                files.push({
                    name: item.name,
                    size: stat.size,
                    date: stat.mtime,
                    // Devolvemos el absolutePath bruto, y usaremos una url especial para cargar videos absolutos
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

// Play endpoint para bypasear la restriccion del static de /media a carpetas absolutas del OS como /mnt/usb
app.get('/api/media/play', (req, res) => {
    const fpath = req.query.path;
    if (!fpath || !fs.existsSync(fpath)) return res.status(404).send('Not found');
    if (!fpath.includes(mediaRoot) && !fpath.includes('/media') && !fpath.includes('/mnt') && !fpath.includes('\\media')) return res.status(403).send('Forbidden area');
    res.sendFile(fpath);
});

app.post('/api/files/delete', (req, res) => {
    const { filepath } = req.body;
    
    // filepath podria venir como /api/media/play?path=...
    let absolutePath = filepath;
    if(filepath && filepath.includes('?path=')) {
        absolutePath = decodeURIComponent(filepath.split('?path=')[1]);
    }

    if (!absolutePath || !fs.existsSync(absolutePath)) return res.status(400).json({ error: 'Ruta invalida o no existe' });

    // Evita Path Traversal para proteger sistema
    if (!absolutePath.includes(mediaRoot) && !absolutePath.includes('/media') && !absolutePath.includes('/mnt') && !absolutePath.includes('\\media')) {
        return res.status(403).json({ error: 'Acceso denegado a esa ruta' });
    }

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
 *  BOOT SEQUENCE & WEBSOCKETS
 * ======================================= */

// Boot active streams based on DB state (Resume capability)
function bootActiveStreams() {
    console.log("[BOOT] Iniciando secuencia de encendido escalonado de Streams...");
    setTimeout(() => {
        db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, rows) => {
            if(rows && rows.length > 0) {
                let delayAccumulator = 0;
                
                // Stagger inputs by 200ms each to prevent CPU max-out
                rows.forEach(r => {
                    setTimeout(() => streamManager.startInput(r), delayAccumulator);
                    delayAccumulator += 200;
                });
                
                // Wait for all inputs to bind their UDP ports, then stagger outputs
                db.all('SELECT * FROM outputs WHERE enabled = 1', [], (err, outRows) => {
                    if(outRows && outRows.length > 0) {
                        outRows.forEach(o => {
                            setTimeout(() => streamManager.startOutput(o), delayAccumulator);
                            delayAccumulator += 200;
                        });
                    }
                });
            }
        });
    }, 1000);
}
bootActiveStreams();

io.on('connection', (socket) => {
    console.log(`Frontend Connected: ${socket.id}`);
});

// Start Server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`TSST SERVER running on port ${PORT}`);
});

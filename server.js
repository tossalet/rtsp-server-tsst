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

const { WebSocketServer } = require('ws');
// WSS comparte el servidor HTTP (puerto 4000) — sin puerto extra que pueda colisionar
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
    const match = req.url.match(/\/live\/(\d+)/);
    if (!match) return ws.close();
    
    const channel = match[1];
    
    let attempts = 0;
    const checkInterval = setInterval(() => {
        if (streamManager.activeInputs[channel] && streamManager.activeInputs[channel].router && streamManager.activeInputs[channel].router.port) {
            clearInterval(checkInterval);
            const net = require('net');
            const localPort = streamManager.activeInputs[channel].router.port;
            
            const tcpSocket = net.createConnection(localPort, '127.0.0.1', () => {
                console.log(`[WS] Client subscribed to LIVE channel ${channel} via TCP ${localPort}`);
                streamManager.activeInputs[channel].router.subscribers.add(tcpSocket);
            });

            tcpSocket.on('data', (data) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(data);
                }
            });

            tcpSocket.on('error', (err) => {
                console.log(`[WS] TCP Socket error for live channel ${channel}: ${err.message}`);
            });

            tcpSocket.on('close', () => ws.close());
            ws.on('close', () => {
                if (streamManager.activeInputs[channel] && streamManager.activeInputs[channel].router) {
                    streamManager.activeInputs[channel].router.subscribers.delete(tcpSocket);
                }
                tcpSocket.destroy();
                console.log(`[WS] Client unsubscribed from LIVE channel ${channel}`);
            });
        } else {
            attempts++;
            if (attempts > 20) { // 10 seconds max wait
                clearInterval(checkInterval);
                console.log(`[WS] Rejecting connection to /live/${channel}: Router not active after 10s.`);
                ws.close();
            }
        }
    }, 500);
});

const util = require('util');

// Custom System Logger
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
}
const logFile = path.join(logsDir, 'server.log');

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

const thumbsDir = path.join(__dirname, 'public', 'thumbs');
if (!fs.existsSync(thumbsDir)) {
    try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch(e){}
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(mediaRoot, {
    setHeaders: (res, path) => {
        if (path.endsWith('.m3u8')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

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
    const { url, name, provider, location, remote, audiowtdg, wtdgsecs, enabled, buffer } = req.body;
    
    // Asignar Udpsrv respetando los límites de Firewall (Settings)
    db.get('SELECT udpMin, udpMax FROM ports LIMIT 1', [], (err, ports) => {
        let udpsrv = req.body.udpsrv;
        if (!udpsrv) {
            const min = ports ? ports.udpMin : 10000;
            const max = ports ? ports.udpMax : 30000;
            udpsrv = Math.floor(Math.random() * (max - min + 1)) + min;
        }
        
        const query = `INSERT INTO inputs (url, name, provider, location, remote, enabled, udpsrv, preview_enabled, buffer) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`;
        const params = [ url || '', name || 'Stream', provider || 'TodoStreaming', location || '', remote || '', 
                         enabled !== false ? 1 : 0, udpsrv, buffer || 0 ];
        
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
                
                // Memory Feature: Restore previously active outputs
                db.all('SELECT * FROM outputs WHERE channel = ? AND was_enabled = 1', [channelId], (err, outputs) => {
                    if (outputs && outputs.length > 0) {
                        db.run('UPDATE outputs SET enabled = 1, was_enabled = 0 WHERE channel = ? AND was_enabled = 1', [channelId], () => {
                            io.emit('db_update', { event: 'outputs_changed' });
                            // The startOutput will fail if input isn't fully bound yet, but streamManager auto-recovers orphaned outputs!
                            // Actually streamManager startOutput waits 1.5s then connects to input router, so it works.
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
    const { url, name, buffer } = req.body;
    const query = `UPDATE inputs SET url = ?, name = ?, buffer = ? WHERE channel = ?`;
    
    db.run(query, [url, name, buffer || 0, channelId], function(err) {
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
        db.run('UPDATE outputs SET enabled = ?, was_enabled = 0 WHERE id = ?', [newEnabled, id], function(err) {
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
 *  REST API: RECORDING SESSIONS & MARKERS
 * ======================================= */

// In-memory map of active recording FFmpeg processes { sessionId -> [childProcess, ...] }
const activeRecordingProcs = {};

// Helper: kill ALL active recording processes (used before starting a new session)
function stopAllRecordings() {
    const activeSessions = Object.keys(activeRecordingProcs);
    activeSessions.forEach(sid => {
        const procs = activeRecordingProcs[sid] || [];
        procs.forEach(child => {
            try { child.stdin.write('q'); } catch (e) {}
            try { child.kill('SIGTERM'); } catch (e) {}
        });
        delete activeRecordingProcs[sid];
        console.log(`[REC] Stopped previous session ${sid} (${procs.length} processes)`);
    });
    return activeSessions.length;
}

app.post('/api/recordings/start', (req, res) => {
    // Parar grabaciones anteriores ANTES de iniciar una nueva
    // Evita agotar conexiones RTSP de la cámara
    const stopped = stopAllRecordings();
    if (stopped > 0) {
        console.log(`[REC] Parando ${stopped} sesión(es) activa(s) antes de nueva grabación`);
    }

    const sessionId = Date.now().toString();
    const startTime = new Date().toISOString();

    db.run('INSERT INTO recording_sessions (id, start_time, name) VALUES (?, ?, ?)',
        [sessionId, startTime, req.body.name || 'Global Session'], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, inputs) => {
            if (err || !inputs || inputs.length === 0)
                return res.status(400).json({ error: 'No active inputs found' });

            const { spawn } = require('child_process');
            const ffmpegCmd = path.join(__dirname, 'ffmpeg_bin',
                fs.readdirSync(path.join(__dirname, 'ffmpeg_bin'))[0], 'bin', 'ffmpeg.exe');

            const net = require('net');

            activeRecordingProcs[sessionId] = [];
            activeRecordingProcs[sessionId].sockets = []; // cleanup sockets on stop

            inputs.forEach(input => {
                // Verificar que el router del input está activo
                const inputState = streamManager.activeInputs[input.channel];
                if (!inputState || !inputState.router) {
                    console.log(`[REC] Ch${input.channel} router not active — skipping`);
                    return;
                }

                const safeName = input.name.replace(/[^a-zA-Z0-9]/g, '_');
                const hlsPath  = path.join(mediaRoot, `${safeName}_${sessionId}.m3u8`);
                const mp4Path  = path.join(mediaRoot, `${safeName}_${sessionId}.mp4`);

                // Puerto TCP local donde el FFmpeg de grabación escucha
                const recPort = 42000 + Math.floor(Math.random() * 15000);

                // FFmpeg lee del router (TCP local) en lugar de RTSP directo
                // Evita abrir una 2ª conexión RTSP a la cámara (que la rechazaría)
                const args = [
                    '-hide_banner', '-y',
                    '-fflags', '+genpts',
                    '-thread_queue_size', '4096',
                    '-i', `tcp://127.0.0.1:${recPort}?listen`,

                    // --- HLS output (H.264 stream copy — sin re-codificación si la cámara ya es H.264) ---
                    '-map', '0:v?', '-map', '0:a?',
                    '-c:v', 'copy',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-hls_time', '2',
                    '-hls_list_size', '0',
                    '-hls_segment_type', 'mpegts',
                    '-f', 'hls', hlsPath,

                    // --- MP4 output (stream copy, calidad original) ---
                    '-map', '0:v?', '-map', '0:a?',
                    '-c', 'copy',
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                    '-f', 'mp4', mp4Path
                ];

                console.log(`[REC-START] Session ${sessionId} ch${input.channel} via TCP router :${recPort}`);
                const child = spawn(ffmpegCmd, args);

                // Throttle stderr para no bloquear el event loop
                let lastRecLog = 0;
                child.stderr.on('data', d => {
                    const text = d.toString();
                    const isImportant = /error|warning|fail|invalid|unable/i.test(text);
                    const now = Date.now();
                    if (isImportant) {
                        const line = text.split('\n')[0].trim();
                        if (line) broadCastLog('WARN', `[REC-${sessionId}|ch${input.channel}] ${line}`);
                    } else if (now - lastRecLog > 4000) {
                        lastRecLog = now;
                        const line = text.split('\n')[0].trim();
                        if (line) originalLog(`[REC-${sessionId}|ch${input.channel}] ${line}`);
                    }
                });
                child.on('exit', code => {
                    broadCastLog('INFO', `[REC-${sessionId}] ch${input.channel} FFmpeg exited ${code}`);
                });

                activeRecordingProcs[sessionId].push(child);

                // Conectar al router 1.5s después de que FFmpeg esté en escucha
                setTimeout(() => {
                    if (child.exitCode !== null) return; // ya terminó
                    const routerState = streamManager.activeInputs[input.channel];
                    if (!routerState || !routerState.router) return;

                    const sock = net.createConnection(recPort, '127.0.0.1', () => {
                        routerState.router.subscribers.add(sock);
                        console.log(`[REC] Ch${input.channel} suscrito al router TCP :${recPort}`);
                    });
                    sock.on('error', err => originalLog(`[REC] sock error ch${input.channel}: ${err.message}`));
                    sock.on('close', () => {
                        if (streamManager.activeInputs[input.channel] && streamManager.activeInputs[input.channel].router) {
                            streamManager.activeInputs[input.channel].router.subscribers.delete(sock);
                        }
                    });
                    activeRecordingProcs[sessionId].sockets.push({ sock, channel: input.channel });
                }, 1500);

                // Guardar rutas de fichero para exportación
                db.run(`INSERT OR REPLACE INTO session_files
                    (session_id, channel, hls_path, mp4_path) VALUES (?,?,?,?)`,
                    [sessionId, input.channel, hlsPath, mp4Path]);
            });


            io.emit('db_update', { event: 'recordings_started', session_id: sessionId });
            res.json({ session_id: sessionId, message: `Started ${inputs.length} recordings.` });
        });
    });
});

app.post('/api/recordings/stop/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const session = activeRecordingProcs[sessionId] || [];
    const procs = Array.isArray(session) ? session : [];
    const sockets = session.sockets || [];

    // Desconectar sockets del router
    sockets.forEach(({ sock, channel }) => {
        try { sock.destroy(); } catch (e) {}
        if (streamManager.activeInputs[channel] && streamManager.activeInputs[channel].router) {
            streamManager.activeInputs[channel].router.subscribers.delete(sock);
        }
    });

    // Matar procesos FFmpeg
    procs.forEach(child => {
        try { child.stdin.write('q'); } catch (e) {}
        try { child.kill('SIGTERM'); } catch (e) {}
    });
    delete activeRecordingProcs[sessionId];

    // Update end_time
    db.run('UPDATE recording_sessions SET end_time = ? WHERE id = ?',
        [new Date().toISOString(), sessionId]);

    io.emit('db_update', { event: 'outputs_changed' });
    res.json({ stopped: procs.length, session_id: sessionId });
});


// Export clip from MP4 using fast stream-copy (no re-encode)
app.post('/api/recordings/export', (req, res) => {
    const { session_id, channel, start_time, end_time, label } = req.body;

    if (!session_id || start_time == null || end_time == null)
        return res.status(400).json({ error: 'Missing parameters' });

    // First try to get the MP4 path from session_files
    db.get('SELECT * FROM session_files WHERE session_id = ? AND channel = ?',
        [session_id, channel], (err, fileRow) => {

        const getSourcePath = (cb) => {
            if (fileRow && fileRow.mp4_path && fs.existsSync(fileRow.mp4_path))
                return cb(fileRow.mp4_path);
            // Fallback: try HLS path
            if (fileRow && fileRow.hls_path && fs.existsSync(fileRow.hls_path))
                return cb(fileRow.hls_path);
            return res.status(404).json({ error: 'Recording file not found on disk' });
        };

        getSourcePath(sourcePath => {
            // Nombre: ClipLabel_YYYYMMDD_HHMMSS.mp4
            const now = new Date();
            const dateStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
            const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
            const clipLabel = (label || `clip_${Math.floor(start_time)}s`).replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
            const exportName = `${clipLabel}_${dateStr}_${timeStr}.mp4`;
            
            // Destino: si envían dest_path usarlo, si no, usar local mediaRoot
            const destDir = req.body.dest_path ? req.body.dest_path : mediaRoot;
            const exportPath = path.join(destDir, exportName);

            const { spawn } = require('child_process');
            const ffmpegCmd = path.join(__dirname, 'ffmpeg_bin',
                fs.readdirSync(path.join(__dirname, 'ffmpeg_bin'))[0], 'bin', 'ffmpeg.exe');

            const args = [
                '-hide_banner', '-y',
                '-ss', start_time.toString(),
                '-i', sourcePath,
                '-t', (end_time - start_time).toString(),
                '-c', 'copy',
                exportPath
            ];

            console.log(`[EXPORT] ${exportName} from ${start_time}s to ${end_time}s`);
            const child = spawn(ffmpegCmd, args);
            child.on('close', code => {
                console.log(`[EXPORT] Done: ${exportName} (code ${code})`);
                io.emit('server_log', { timestamp: new Date().toISOString(), level: 'INFO',
                    message: `Clip exportado: ${exportName}` });
            });

            // NO se inserta en clips aquí — ya fue guardado al crear el clip
            // Así se evitan duplicados en la lista de clips
            res.json({ started: true, filename: exportName });
        });

    });
});

// ── Clips (IN/OUT pairs) ────────────────────────────
app.get('/api/clips/:sessionId', (req, res) => {
    db.all('SELECT * FROM clips WHERE session_id = ? ORDER BY in_point ASC',
        [req.params.sessionId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/clips', (req, res) => {
    const { session_id, in_point, out_point, label, channels } = req.body;
    const baseLabel = label || 'Clip';
    
    // Si no envían canales, guardamos un clip genérico (comportamiento legacy)
    const chList = Array.isArray(channels) && channels.length > 0 ? channels : [null];
    
    let inserted = [];
    let errors = [];
    
    // Usamos Promesas para insertar múltiples clips
    const insertClip = (ch) => new Promise((resolve) => {
        const lbl = ch !== null ? `${baseLabel} - CH${ch}` : baseLabel;
        db.run('INSERT INTO clips (session_id, channel, in_point, out_point, label) VALUES (?,?,?,?,?)',
            [session_id, ch, in_point, out_point, lbl], function(err) {
            if (err) errors.push(err.message);
            else inserted.push({ id: this.lastID, session_id, channel: ch, in_point, out_point, label: lbl });
            resolve();
        });
    });

    Promise.all(chList.map(ch => insertClip(ch))).then(() => {
        if (errors.length > 0 && inserted.length === 0) return res.status(500).json({ error: errors.join(', ') });
        res.status(201).json({ success: true, clips: inserted });
    });
});

app.delete('/api/clips/:id', (req, res) => {
    db.run('DELETE FROM clips WHERE id = ?', [req.params.id], err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: req.params.id });
    });
});

// Actualizar etiqueta de un clip (para edición inline del nombre)
app.put('/api/clips/:id', (req, res) => {
    const { label, in_point, out_point } = req.body;
    db.run('UPDATE clips SET label = COALESCE(?, label), in_point = COALESCE(?, in_point), out_point = COALESCE(?, out_point) WHERE id = ?',
        [label ?? null, in_point ?? null, out_point ?? null, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: this.changes });
    });
});

// ── Recording Sessions ──────────────────────────────
app.get('/api/recordings', (req, res) => {
    db.all('SELECT * FROM recording_sessions ORDER BY start_time DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ── Markers ─────────────────────────────────────────
app.post('/api/markers', (req, res) => {
    const { session_id, timestamp_offset, label } = req.body;
    db.run('INSERT INTO markers (session_id, timestamp_offset, label) VALUES (?, ?, ?)',
        [session_id, timestamp_offset, label || 'Marca'], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const marker = { id: this.lastID, session_id, timestamp_offset, label };
        io.emit('marker_added', marker);
        res.status(201).json(marker);
    });
});

app.get('/api/markers/:sessionId', (req, res) => {
    db.all('SELECT * FROM markers WHERE session_id = ? ORDER BY timestamp_offset ASC',
        [req.params.sessionId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
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

        // Fallback: Si no hay discos externos, meter el mediaRoot siempre
        // Además, incluir siempre mediaRoot como disco de grabacion local
        const mediaRootEntry = { id: 'local_mediaroot', name: 'Grabaciones Locales (/media)', path: mediaRoot };
        if (!drives.find(d => d.path === mediaRoot)) {
            drives.unshift(mediaRootEntry); // Siempre el primero
        }
        
        res.json(drives);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* =======================================
 *  REST API: LIVE HLS PREVIEW (sin grabar)
 * ======================================= */
// Mapa en memoria de procesos de preview HLS activos: { channel -> { proc, hlsPath } }
const livePreviewProcs = {};

app.post('/api/preview/live/:channel', (req, res) => {
    const channel = parseInt(req.params.channel);
    const net = require('net');

    // Detener preview anterior si existe
    if (livePreviewProcs[channel]) {
        try { livePreviewProcs[channel].proc.kill('SIGKILL'); } catch(e) {}
        if (livePreviewProcs[channel].sock) { try { livePreviewProcs[channel].sock.destroy(); } catch(e) {} }
        delete livePreviewProcs[channel];
    }

    const routerState = streamManager.activeInputs[channel];
    if (!routerState || !routerState.router) {
        return res.status(503).json({ error: 'Input not ready' });
    }

    const { spawn } = require('child_process');
    // Misma resolución que el endpoint de export: busca la subcarpeta dentro de ffmpeg_bin
    let ffmpegCmd;
    try {
        const ffmpegBinDir = path.join(__dirname, 'ffmpeg_bin');
        const subDir = fs.readdirSync(ffmpegBinDir)[0];
        ffmpegCmd = path.join(ffmpegBinDir, subDir, 'bin', 'ffmpeg.exe');
        if (!fs.existsSync(ffmpegCmd)) {
            // Fallback para Linux/Mac: busca simplemente 'ffmpeg' en el directorio
            ffmpegCmd = path.join(ffmpegBinDir, 'ffmpeg');
        }
    } catch(e) {
        ffmpegCmd = 'ffmpeg'; // Fallback: ffmpeg en PATH del sistema
    }
    const previewId = `preview_ch${channel}_${Date.now()}`;
    const hlsPath = path.join(mediaRoot, `${previewId}.m3u8`);
    const tcpPort = 43000 + channel;

    const args = [
        '-hide_banner', '-y',
        '-fflags', '+genpts',
        '-thread_queue_size', '4096',
        '-i', `tcp://127.0.0.1:${tcpPort}?listen`,
        '-map', '0:v?', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
        '-vf', 'scale=-2:720',
        '-g', '50', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '96k',
        '-hls_time', '2',
        '-hls_list_size', '0',
        '-hls_segment_type', 'mpegts',
        '-f', 'hls', hlsPath
    ];

    const proc = spawn(ffmpegCmd, args);
    livePreviewProcs[channel] = { proc, hlsPath, sock: null };

    proc.on('exit', code => {
        if (livePreviewProcs[channel] && livePreviewProcs[channel].proc === proc) {
            delete livePreviewProcs[channel];
        }
    });

    // Conectar al router de la cámara
    setTimeout(() => {
        if (!livePreviewProcs[channel] || livePreviewProcs[channel].proc !== proc) return;
        const sock = net.createConnection(tcpPort, '127.0.0.1', () => {
            if (routerState.router) routerState.router.subscribers.add(sock);
        });
        sock.on('error', () => {});
        sock.on('close', () => { if (routerState.router) routerState.router.subscribers.delete(sock); });
        livePreviewProcs[channel].sock = sock;
    }, 1500);

    // Devolver la URL del HLS
    const hlsName = path.basename(hlsPath);
    res.json({ url: `/media/${hlsName}`, previewId });
});

app.delete('/api/preview/live/:channel', (req, res) => {
    const channel = parseInt(req.params.channel);
    if (livePreviewProcs[channel]) {
        try { livePreviewProcs[channel].proc.kill('SIGKILL'); } catch(e) {}
        if (livePreviewProcs[channel].sock) { try { livePreviewProcs[channel].sock.destroy(); } catch(e) {} }
        delete livePreviewProcs[channel];
    }
    res.json({ ok: true });
});

/* =======================================
 *  REST API: DISK WIPE (borrado rápido)
 * ======================================= */
app.post('/api/disks/wipe', (req, res) => {
    const { disk_path } = req.body;
    if (!disk_path) return res.status(400).json({ error: 'Missing disk_path' });
    
    // Protección: nunca borrar el disco del sistema operativo
    const forbidden = ['/', 'C:\\', 'C:', '/usr', '/etc', '/home', '/root', '/var', '/boot', '/sys', '/proc'];
    const isForbidden = forbidden.some(f => disk_path === f || disk_path.toLowerCase() === f.toLowerCase());
    if (isForbidden) return res.status(403).json({ error: 'Ruta del sistema protegida. Operación cancelada.' });

    // Es seguro: borrar contenido del disco
    try {
        if (!fs.existsSync(disk_path)) return res.status(404).json({ error: 'Ruta no encontrada' });
        const items = fs.readdirSync(disk_path);
        let removed = 0;
        for (const item of items) {
            const fullPath = path.join(disk_path, item);
            try {
                fs.rmSync(fullPath, { recursive: true, force: true });
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
    // ParentDisk es ahora una ruta ABSOLUTA enviada desde el frontend
    const scanPath = req.query.disk;
    if (!scanPath) return res.json([]);
    
    try {
        if (!fs.existsSync(scanPath)) return res.json([]);
        const files = [];
        
        // Scan recursivo simple o de 1 nivel
        const items = fs.readdirSync(scanPath, { withFileTypes: true });
        for (const item of items) {
            if (item.isFile() && item.name.match(/\.(mp4|mkv|ts|flv|m3u8)$/i)) {
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

// Redirigir el handshake WebSocket al wss (comparte puerto 4000)
// IMPORTANTE: NO destruir sockets no-/live/ — socket.io tiene su propio listener de upgrade
server.on('upgrade', (request, socket, head) => {
    if (request.url && request.url.startsWith('/live/')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
    // Si no es /live/, socket.io lo gestiona con su propio listener — no tocar
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


const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');

const isProd = process.env.NODE_ENV === 'production' || process.env.DOCKER_ENV;
const dbDir = path.join(__dirname, 'data');
if (isProd && !fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = isProd ? path.join(dbDir, 'race-control.db') : path.resolve(__dirname, 'race-control.db');

let resolveReady;
const ready = new Promise(r => { resolveReady = r; });

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database', err);
    } else {
        console.log('Connected to SQLite database.');
        initDB();
    }
});

function initDB() {
    db.serialize(() => {
        // Table inputs
        db.run(`CREATE TABLE IF NOT EXISTS inputs (
            channel INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            remote TEXT NOT NULL DEFAULT '',
            audiowtdg INTEGER NOT NULL DEFAULT 0,
            wtdgsecs INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            udpsrv INTEGER NOT NULL DEFAULT 0,
            preview_enabled INTEGER NOT NULL DEFAULT 1,
            buffer INTEGER NOT NULL DEFAULT 0
        )`);

        // Table outputs
        db.run(`CREATE TABLE IF NOT EXISTS outputs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel INTEGER NOT NULL,
            url TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            remote TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            udpsrv INTEGER NOT NULL DEFAULT 0,
            vcodec TEXT NOT NULL DEFAULT 'copy',
            was_enabled INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (channel) REFERENCES inputs (channel)
        )`);

        // Table ports
        db.run(`CREATE TABLE IF NOT EXISTS ports (
            chanMin INTEGER NOT NULL DEFAULT 1,
            chanMax INTEGER NOT NULL DEFAULT 20000,
            udpMin INTEGER NOT NULL DEFAULT 1024,
            udpMax INTEGER NOT NULL DEFAULT 49151,
            rtmpPort INTEGER NOT NULL DEFAULT 1935
        )`);

        // Table users
        db.run(`CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL,
            role INTEGER NOT NULL DEFAULT 2,
            email TEXT NOT NULL DEFAULT ''
        )`);

        // Migraciones para BDs antiguas. Van DESPUÉS de los CREATE: antes el ALTER de outputs se
        // ejecutaba sin existir la tabla y en una instalación nueva faltaba was_enabled.
        db.run("ALTER TABLE inputs ADD COLUMN preview_enabled INTEGER NOT NULL DEFAULT 1", () => {});
        db.run("ALTER TABLE inputs ADD COLUMN buffer INTEGER NOT NULL DEFAULT 0", () => {});
        db.run("ALTER TABLE outputs ADD COLUMN vcodec TEXT NOT NULL DEFAULT 'copy'", () => {});
        db.run("ALTER TABLE outputs ADD COLUMN was_enabled INTEGER NOT NULL DEFAULT 0", () => {});
        db.run("ALTER TABLE ports ADD COLUMN rtmpPort INTEGER NOT NULL DEFAULT 1935", () => {});

        // Insert initial configuration defaults if empty (cada tabla por separado)
        db.get('SELECT COUNT(*) AS count FROM users', (err, row) => {
            if (row && row.count === 0) {
                db.run(`INSERT INTO users (username, password, role) VALUES ('admin', 'admin', 4), ('user', 'user', 16)`);
            }
        });
        db.get('SELECT COUNT(*) AS count FROM ports', (err, row) => {
            if (row && row.count === 0) {
                db.run(`INSERT INTO ports (chanMin, chanMax, udpMin, udpMax) VALUES (1, 20000, 1024, 49151)`);
            }
            resolveReady(); // serialize(): todas las sentencias anteriores ya se han ejecutado
        });
    });
}

db.ready = ready;
module.exports = db;

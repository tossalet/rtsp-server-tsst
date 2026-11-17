/**
 * AJUSTES DE CODIFICACIÓN DE LA CÁMARA (Hikvision ISAPI y Dahua CGI)
 *
 * Lee y cambia lo mínimo para trabajar: códec, resolución, fps, control de bitrate, bitrate y GOP
 * del mismo stream que usa la entrada (principal o secundario, según la URL RTSP).
 * El usuario y la contraseña salen de la URL RTSP guardada: nunca viajan desde el navegador.
 * Autenticación Digest (MD5 o SHA-256) o Basic, con http/https de Node (sin dependencias).
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const TIMEOUT_MS = 6000;

// ── Petición HTTP con Digest/Basic ─────────────────────────────────────────
function rawRequest({ protocol, host, port, method, path, headers, body }) {
    const lib = protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request({
            host, port, method, path, headers: { ...headers },
            rejectUnauthorized: false, // las cámaras usan certificados propios
            timeout: TIMEOUT_MS
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('La cámara no responde'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function parseChallenge(header) {
    if (!header) return null;
    // Varias cabeceras WWW-Authenticate llegan unidas por comas: quedarse con la primera Digest (o Basic)
    const parts = String(header).split(/,\s*(?=(?:Digest|Basic)\s)/i);
    const digest = parts.find(p => /^Digest\s/i.test(p.trim()));
    if (!digest) return /Basic/i.test(header) ? { scheme: 'basic' } : null;
    const params = { scheme: 'digest' };
    const re = /(\w+)=(?:"([^"]*)"|([^,\s]*))/g;
    let m;
    while ((m = re.exec(digest))) if (!(m[1].toLowerCase() in params)) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    return params;
}

function digestHeader(ch, user, pass, method, uri) {
    const algo = /sha-?256/i.test(ch.algorithm || '') ? 'sha256' : 'md5';
    const H = s => crypto.createHash(algo).update(s).digest('hex');
    const ha1 = H(`${user}:${ch.realm}:${pass}`);
    const ha2 = H(`${method}:${uri}`);
    const qop = (ch.qop || '').split(',').map(s => s.trim()).includes('auth') ? 'auth' : '';
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = qop ? H(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`);
    let h = `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`;
    if (ch.algorithm) h += `, algorithm=${ch.algorithm}`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (ch.opaque) h += `, opaque="${ch.opaque}"`;
    return h;
}

async function request(cam, method, path, body, contentType) {
    const base = { protocol: cam.protocol, host: cam.host, port: cam.port, method, path, body,
        headers: body ? { 'Content-Type': contentType || 'application/xml', 'Content-Length': Buffer.byteLength(body) } : {} };
    let res = await rawRequest(base);
    if (res.status === 401) {
        const ch = parseChallenge(res.headers['www-authenticate']);
        if (!ch) throw httpError(401, 'La cámara pide un tipo de autenticación no soportado');
        const auth = ch.scheme === 'basic'
            ? 'Basic ' + Buffer.from(`${cam.user}:${cam.pass}`).toString('base64')
            : digestHeader(ch, cam.user, cam.pass, method, path);
        res = await rawRequest({ ...base, headers: { ...base.headers, Authorization: auth } });
        if (res.status === 401) throw httpError(401, 'Usuario o contraseña rechazados por la cámara (los de la URL RTSP)');
    }
    return res;
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// ── Datos de la cámara a partir de la URL RTSP ─────────────────────────────
function cameraFromRtsp(rtspUrl, httpPort) {
    let u;
    try { u = new URL(rtspUrl); } catch (e) { throw httpError(400, 'La URL de la entrada no es válida'); }
    if (u.protocol !== 'rtsp:') throw httpError(400, 'Solo para cámaras RTSP');
    const port = parseInt(httpPort, 10) || 80;
    const cam = {
        protocol: port === 443 ? 'https:' : 'http:',
        host: u.hostname, port,
        user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || ''),
        brand: null, hik: null, dahua: null
    };
    const path = u.pathname + u.search;
    // Hikvision: /Streaming/Channels/101 (canal 1, principal) · 102 (secundario) · /h264/ch1/main/av_stream
    let m = path.match(/\/Streaming\/Channels\/(\d+)/i);
    if (m) { cam.brand = 'hikvision'; cam.hik = { id: m[1] }; }
    else if ((m = path.match(/\/ch(\d+)\/(main|sub)/i))) { cam.brand = 'hikvision'; cam.hik = { id: `${m[1]}0${m[2].toLowerCase() === 'main' ? 1 : 2}` }; }
    // Dahua: /cam/realmonitor?channel=1&subtype=0 (0 principal, 1 y 2 secundarios)
    if (/realmonitor/i.test(path)) {
        cam.brand = 'dahua';
        cam.dahua = { ch: Math.max(0, (parseInt(u.searchParams.get('channel'), 10) || 1) - 1), subtype: parseInt(u.searchParams.get('subtype'), 10) || 0 };
    }
    return cam;
}

const streamLabel = cam => cam.brand === 'hikvision'
    ? (String(cam.hik.id).endsWith('1') ? 'Principal' : 'Secundario') + ` (stream ${cam.hik.id})`
    : (cam.dahua.subtype === 0 ? 'Principal' : `Secundario ${cam.dahua.subtype}`) + ` (canal ${cam.dahua.ch + 1})`;

// ── Hikvision (ISAPI, XML) ─────────────────────────────────────────────────
const xmlTag = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`)); return m ? m[1].trim() : null; };
const xmlOpt = (xml, tag) => { const m = xml.match(new RegExp(`<${tag}\\s[^>]*opt="([^"]*)"`)); return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : []; };
const xmlAttr = (xml, tag, attr) => { const m = xml.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`)); return m ? m[1] : null; };
const videoBlock = xml => { const m = xml.match(/<Video>[\s\S]*?<\/Video>/); return m ? m[0] : ''; };

async function hikRead(cam) {
    const info = await request(cam, 'GET', '/ISAPI/System/deviceInfo');
    if (info.status !== 200 || !/<DeviceInfo/i.test(info.body)) return null;
    const conf = await request(cam, 'GET', `/ISAPI/Streaming/channels/${cam.hik.id}`);
    if (conf.status !== 200) throw httpError(502, `La cámara no da el stream ${cam.hik.id} (HTTP ${conf.status})`);
    const v = videoBlock(conf.body);
    const caps = await request(cam, 'GET', `/ISAPI/Streaming/channels/${cam.hik.id}/capabilities`).catch(() => null);
    const c = caps && caps.status === 200 ? videoBlock(caps.body) : '';

    const widths = xmlOpt(c, 'videoResolutionWidth'), heights = xmlOpt(c, 'videoResolutionHeight');
    const resolutions = widths.length && widths.length === heights.length ? widths.map((w, i) => `${w}x${heights[i]}`) : [];
    const rc = xmlTag(v, 'videoQualityControlType') || 'VBR';
    const smart = conf.body.match(/<SmartCodec>[\s\S]*?<enabled>(true|false)<\/enabled>/);
    return {
        brand: 'Hikvision',
        model: xmlTag(info.body, 'model') || '',
        firmware: [xmlTag(info.body, 'firmwareVersion'), xmlTag(info.body, 'firmwareReleasedDate')].filter(Boolean).join(' '),
        stream: streamLabel(cam),
        current: {
            codec: xmlTag(v, 'videoCodecType') || '',
            width: parseInt(xmlTag(v, 'videoResolutionWidth'), 10) || 0,
            height: parseInt(xmlTag(v, 'videoResolutionHeight'), 10) || 0,
            fps: (parseInt(xmlTag(v, 'maxFrameRate'), 10) || 0) / 100,
            rc: rc.toUpperCase(),
            bitrate: parseInt(rc.toUpperCase() === 'CBR' ? xmlTag(v, 'constantBitRate') : (xmlTag(v, 'vbrUpperCap') || xmlTag(v, 'constantBitRate')), 10) || 0,
            gop: parseInt(xmlTag(v, 'GovLength'), 10) || 0,
            smartCodec: smart ? smart[1] === 'true' : null
        },
        caps: {
            codecs: xmlOpt(c, 'videoCodecType'),
            resolutions,
            fps: xmlOpt(c, 'maxFrameRate').map(x => parseInt(x, 10) / 100).filter(x => x >= 1),
            rc: xmlOpt(c, 'videoQualityControlType').map(s => s.toUpperCase()),
            bitrateMax: parseInt(xmlAttr(c, 'constantBitRate', 'max') || xmlAttr(c, 'vbrUpperCap', 'max'), 10) || null,
            gopMax: parseInt(xmlAttr(c, 'GovLength', 'max'), 10) || null
        }
    };
}

async function hikWrite(cam, s) {
    const conf = await request(cam, 'GET', `/ISAPI/Streaming/channels/${cam.hik.id}`);
    if (conf.status !== 200) throw httpError(502, `No se pudo leer la configuración (HTTP ${conf.status})`);
    let xml = conf.body;
    const v0 = videoBlock(xml);
    let v = v0;
    const set = (tag, val) => {
        const re = new RegExp(`(<${tag}(?:\\s[^>]*)?>)[^<]*(</${tag}>)`);
        if (re.test(v)) v = v.replace(re, `$1${val}$2`);
    };
    set('videoCodecType', s.codec);
    set('videoResolutionWidth', s.width);
    set('videoResolutionHeight', s.height);
    set('videoQualityControlType', s.rc);
    set('constantBitRate', s.bitrate);
    set('vbrUpperCap', s.bitrate);
    set('maxFrameRate', Math.round(s.fps * 100));
    set('GovLength', s.gop);
    xml = xml.replace(v0, v);
    if (s.smartCodec === false) xml = xml.replace(/(<SmartCodec>[\s\S]*?<enabled>)true(<\/enabled>)/, '$1false$2');
    const res = await request(cam, 'PUT', `/ISAPI/Streaming/channels/${cam.hik.id}`, xml, 'application/xml');
    const code = xmlTag(res.body, 'statusCode');
    if (res.status !== 200 || (code && code !== '1' && code !== '7')) {
        const why = xmlTag(res.body, 'subStatusCode') || xmlTag(res.body, 'statusString') || `HTTP ${res.status}`;
        throw httpError(502, `La cámara rechazó el cambio: ${why}`);
    }
    return { rebootRequired: code === '7' };
}

// ── Dahua (CGI, texto clave=valor) ─────────────────────────────────────────
const KNOWN_RES = { '4K': '3840x2160', '8M': '3840x2160', '6M': '3072x2048', '5M': '2592x1944', '4M': '2688x1520', '3M': '2048x1536',
    '1080P': '1920x1080', '1_3M': '1280x960', '720P': '1280x720', 'D1': '704x576', 'CIF': '352x288' };
const kv = text => Object.fromEntries(String(text).split(/\r?\n/).map(l => l.split('=')).filter(p => p.length >= 2).map(([k, ...r]) => [k.trim(), r.join('=').trim()]));
const dahuaFmt = cam => cam.dahua.subtype === 0 ? 'MainFormat[0]' : `ExtraFormat[${cam.dahua.subtype - 1}]`;

async function dahuaRead(cam) {
    const type = await request(cam, 'GET', '/cgi-bin/magicBox.cgi?action=getDeviceType');
    if (type.status !== 200 || !/type=/i.test(type.body)) return null;
    const soft = await request(cam, 'GET', '/cgi-bin/magicBox.cgi?action=getSoftwareVersion').catch(() => null);
    const conf = await request(cam, 'GET', '/cgi-bin/configManager.cgi?action=getConfig&name=Encode');
    if (conf.status !== 200) throw httpError(502, `No se pudo leer la codificación (HTTP ${conf.status})`);
    const t = kv(conf.body);
    const p = `table.Encode[${cam.dahua.ch}].${dahuaFmt(cam)}.Video.`;
    if (!(p + 'Width' in t) && !(p + 'resolution' in t)) throw httpError(502, 'La cámara no devuelve ese stream');

    const caps = await request(cam, 'GET', `/cgi-bin/encode.cgi?action=getConfigCaps&channel=${cam.dahua.ch + 1}`).catch(() => null);
    const ck = caps && caps.status === 200 ? kv(caps.body) : {};
    const fmt = dahuaFmt(cam).replace(/[[\]]/g, '\\$&');
    const capVal = name => { const k = Object.keys(ck).find(k => new RegExp(`${fmt}\\.Video\\.${name}$`).test(k)); return k ? ck[k] : null; };
    const resolutions = (capVal('ResolutionTypes') || '').split(',').map(r => r.trim()).filter(Boolean)
        .map(r => /^\d+x\d+$/i.test(r) ? r.toLowerCase() : KNOWN_RES[r.toUpperCase()]).filter(Boolean);
    const fpsMax = parseInt(capVal('FPSMax'), 10) || 30;
    const brOpts = (capVal('BitRateOptions') || '').split(',').map(x => parseInt(x, 10)).filter(Boolean);

    return {
        brand: 'Dahua',
        model: (kv(type.body).type || '').trim(),
        firmware: soft ? (kv(soft.body).version || '') : '',
        stream: streamLabel(cam),
        current: {
            codec: t[p + 'Compression'] || '',
            width: parseInt(t[p + 'Width'], 10) || 0,
            height: parseInt(t[p + 'Height'], 10) || 0,
            fps: parseFloat(t[p + 'FPS']) || 0,
            rc: (t[p + 'BitRateControl'] || 'CBR').toUpperCase(),
            bitrate: parseInt(t[p + 'BitRate'], 10) || 0,
            gop: parseInt(t[p + 'GOP'], 10) || 0,
            smartCodec: null
        },
        caps: {
            codecs: (capVal('CompressionTypes') || '').split(',').map(s => s.trim()).filter(c => /^H\.26[45]/i.test(c)),
            resolutions: [...new Set(resolutions)],
            fps: Array.from({ length: fpsMax }, (_, i) => i + 1).filter(f => [1, 5, 10, 12, 15, 20, 24, 25, 30, 50, 60].includes(f) || f === fpsMax),
            rc: ['CBR', 'VBR'],
            bitrateMax: brOpts.length ? Math.max(...brOpts) : null,
            gopMax: null
        }
    };
}

async function dahuaWrite(cam, s) {
    const p = `Encode[${cam.dahua.ch}].${dahuaFmt(cam)}.Video.`;
    const q = [['Compression', s.codec], ['Width', s.width], ['Height', s.height], ['FPS', s.fps],
        ['BitRateControl', s.rc], ['BitRate', s.bitrate], ['GOP', s.gop]]
        .map(([k, v]) => `${encodeURIComponent(p + k)}=${encodeURIComponent(v)}`).join('&');
    const res = await request(cam, 'GET', `/cgi-bin/configManager.cgi?action=setConfig&${q}`);
    if (res.status !== 200 || !/^\s*OK/i.test(res.body)) throw httpError(502, `La cámara rechazó el cambio: ${res.body.trim().slice(0, 120) || 'HTTP ' + res.status}`);
    return { rebootRequired: false };
}

// ── API pública ────────────────────────────────────────────────────────────
async function detect(cam) {
    const order = cam.brand === 'dahua' ? ['dahua', 'hikvision'] : ['hikvision', 'dahua'];
    for (const b of order) {
        if (b === 'hikvision') {
            if (!cam.hik) cam.hik = { id: '101' };
            const r = await hikRead(cam).catch(e => { if (e.status === 401 || e.code) throw e; return null; });
            if (r) { cam.brand = 'hikvision'; return r; }
        } else {
            if (!cam.dahua) cam.dahua = { ch: 0, subtype: 0 };
            const r = await dahuaRead(cam).catch(e => { if (e.status === 401 || e.code) throw e; return null; });
            if (r) { cam.brand = 'dahua'; return r; }
        }
    }
    throw httpError(502, 'No parece una cámara Hikvision ni Dahua (o el puerto web no es ese)');
}

function friendlyError(e) {
    if (e.code === 'ECONNREFUSED') return httpError(502, 'La cámara rechaza la conexión en ese puerto web');
    if (e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return httpError(504, 'La cámara no responde (¿IP o puerto web?)');
    return e.status ? e : httpError(502, e.message);
}

async function readSettings(rtspUrl, httpPort) {
    try { return await detect(cameraFromRtsp(rtspUrl, httpPort)); } catch (e) { throw friendlyError(e); }
}

function validate(s, info) {
    const out = {
        codec: String(s.codec || ''),
        width: parseInt(s.width, 10), height: parseInt(s.height, 10),
        fps: parseFloat(s.fps), rc: String(s.rc || '').toUpperCase(),
        bitrate: parseInt(s.bitrate, 10), gop: parseInt(s.gop, 10),
        smartCodec: s.smartCodec === false ? false : null
    };
    const caps = info.caps;
    if (!/^H\.26[45]/i.test(out.codec) || (caps.codecs.length && !caps.codecs.includes(out.codec))) throw httpError(400, 'Códec no admitido por la cámara');
    if (!(out.width > 0 && out.height > 0) || (caps.resolutions.length && !caps.resolutions.includes(`${out.width}x${out.height}`))) throw httpError(400, 'Resolución no admitida por la cámara');
    if (!(out.fps >= 1 && out.fps <= 60)) throw httpError(400, 'Fotogramas por segundo fuera de rango');
    if (!['CBR', 'VBR'].includes(out.rc)) throw httpError(400, 'Control de bitrate: CBR o VBR');
    if (!(out.bitrate >= 256 && out.bitrate <= (caps.bitrateMax || 32768))) throw httpError(400, `Bitrate entre 256 y ${caps.bitrateMax || 32768} kbps`);
    if (!(out.gop >= 1 && out.gop <= (caps.gopMax || 400))) throw httpError(400, 'GOP fuera de rango');
    return out;
}

async function writeSettings(rtspUrl, httpPort, settings) {
    try {
        const cam = cameraFromRtsp(rtspUrl, httpPort);
        const info = await detect(cam);
        const s = validate(settings, info);
        const r = cam.brand === 'hikvision' ? await hikWrite(cam, s) : await dahuaWrite(cam, s);
        return { ...r, applied: s };
    } catch (e) { throw friendlyError(e); }
}

module.exports = { readSettings, writeSettings, cameraFromRtsp, parseChallenge, digestHeader };

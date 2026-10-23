const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Map: deviceId -> { frame, timestamp, lastSent }
const devices = new Map();
const pendingCommands = new Map(); // deviceId -> command

// Akses kode sederhana untuk halaman /stream
const ACCESS_CODE = '1500';
const MAX_ATTEMPTS = 2;
const LOCKOUT_MS = 10000; // 10 detik
const accessAttempts = new Map(); // ip -> { attempts, lockedUntil }

// Health check
app.get('/health', (req, res) => res.send('OK'));

// Helper: update stream status in Supabase (non-blocking)
async function updateStreamStatus(deviceId, status) {
    if (!supabase) return;
    try {
        const { data, error } = await supabase
            .from('streams')
            .update({ status: status, updated_at: new Date().toISOString() })
            .eq('device_id', deviceId);
        if (error) console.error('Supabase update error:', error.message);
        else console.log(`Supabase: ${deviceId} -> ${status}`);
    } catch (e) {
        console.error('Supabase update exception:', e.message);
    }
}

// Helper: ambil IP klien
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

// Helper: baca cookie
function getCookie(req, name) {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    for (const pair of cookie.split(';')) {
        const [key, ...valParts] = pair.trim().split('=');
        if (key === name) return valParts.join('=');
    }
    return null;
}

// Helper: tampilkan form kode akses
function showAccessForm(req, res) {
    const ip = getClientIp(req);
    let record = accessAttempts.get(ip) || { attempts: 0, lockedUntil: 0 };
    const now = Date.now();
    const locked = record.lockedUntil > now;

    // Reset setelah lockout lewat, beri percobaan baru
    if (record.attempts >= MAX_ATTEMPTS && !locked) {
        record = { attempts: 0, lockedUntil: 0 };
        accessAttempts.set(ip, record);
    }

    const remaining = locked ? Math.ceil((record.lockedUntil - now) / 1000) : 0;
    const disabled = locked ? 'disabled' : '';
    const lockMsg = locked ? `<div class="error">Terlalu banyak percobaan gagal. Tunggu ${remaining} detik.</div>` : '';
    const errMsg = record.attempts > 0 && !locked ? `<div class="error">Kode salah. Sisa percobaan: ${MAX_ATTEMPTS - record.attempts}.</div>` : '';

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Akses Kamera Stream</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; text-align: center; margin: 20px; background: #f0f0f0; }
                .container { max-width: 400px; margin: 60px auto; background: white; padding: 24px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                h2 { margin-top: 0; }
                input { padding: 10px; font-size: 16px; width: 80%; box-sizing: border-box; margin-bottom: 12px; }
                button { padding: 10px 20px; font-size: 16px; cursor: pointer; background: #007bff; color: white; border: none; border-radius: 4px; width: 100%; }
                button:disabled { background: #ccc; cursor: not-allowed; }
                .error { color: #d00; margin-bottom: 12px; font-size: 14px; }
                .hint { color: #666; font-size: 13px; margin-top: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Masukkan Kode Akses</h2>
                ${lockMsg}
                ${errMsg}
                <form method="POST" action="/access">
                    <input type="text" name="code" autocomplete="off" ${disabled} placeholder="Kode akses" />
                    <button type="submit" ${disabled}>Masuk</button>
                </form>
                <div class="hint">Maksimal ${MAX_ATTEMPTS} percobaan. Setelah gagal ${MAX_ATTEMPTS} kali, tombol disable selama 10 detik.</div>
            </div>
        </body>
        </html>
    `;
    res.status(401).send(html);
}

// HP POST frame
app.post('/upload-frame/:id', express.raw({ type: 'image/jpeg', limit: '5mb' }), async (req, res) => {
    const deviceId = req.params.id;

    // Init device kalau belum ada
    if (!devices.has(deviceId)) {
        devices.set(deviceId, { frame: null, timestamp: 0, lastSent: null });
        // First upload: mark as active in Supabase
        updateStreamStatus(deviceId, 'aktif');
    }

    const device = devices.get(deviceId);
    device.frame = req.body;
    device.timestamp = Date.now();

    // Kirim command yang pending (jika ada) ke HP
    const cmd = pendingCommands.get(deviceId) || 'ok';
    pendingCommands.delete(deviceId);

    res.send(cmd);
});

// Switch camera command dari browser PC
app.post('/switch-camera/:id', (req, res) => {
    const deviceId = req.params.id;
    pendingCommands.set(deviceId, 'switch');
    res.send('Command queued');
});

// Browser GET MJPEG stream per device
app.get('/mjpeg/:id', (req, res) => {
    const deviceId = req.params.id;

    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const sendFrame = () => {
        const device = devices.get(deviceId);
        const frame = device ? device.frame : null;
        const lastSent = device ? device.lastSent : null;
        const timestamp = device ? device.timestamp : 0;

        // Kirim frame hanya kalau baru (tidak duplikat) dan fresh (<500ms old)
        if (frame && frame !== lastSent && Date.now() - timestamp < 500) {
            device.lastSent = frame;
            res.write(`--frame\r\n`);
            res.write(`Content-Type: image/jpeg\r\n`);
            res.write(`Content-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write('\r\n');
        }
        if (!res.writableEnded) setTimeout(sendFrame, 100);  // ~10fps
    };
    sendFrame();

    req.on('close', async () => {
        // Stream close: mark stream as inactive in Supabase
        await updateStreamStatus(deviceId, 'nonaktif');
        try { res.end(); } catch (_) {}
    });
});

// Browser GET HTML with stream per device
app.get('/stream/:id', (req, res) => {
    const deviceId = req.params.id;
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Camera Stream - ${deviceId}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; text-align: center; margin: 20px; background: #f0f0f0; }
                .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                .img-wrapper { position: relative; display: inline-block; }
                img { max-width: 100%; height: auto; border: 1px solid #ccc; border-radius: 4px; background: #000; display: block; }
                button { padding: 12px 24px; font-size: 16px; cursor: pointer; margin-top: 10px; background: #007bff; color: white; border: none; border-radius: 4px; position: relative; z-index: 10; }
                button:hover { background: #0056b3; }
                .btn-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 10px; position: relative; z-index: 10; }
                .device-id { color: #666; font-size: 14px; margin-top: 8px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Camera Stream</h1>
                <div class="device-id">Device: ${deviceId}</div>
                <div class="img-wrapper">
                    <img src="/mjpeg/${deviceId}" alt="Camera Stream">
                </div>
                <br>
                <div class="btn-row">
                    <button onclick="switchCamera('${deviceId}')">Switch Camera</button>
                    <button onclick="rotateImg(90)">↻ 90°</button>
                    <button onclick="rotateImg(180)">↻ 180°</button>
                    <button onclick="rotateImg(270)">↻ 270°</button>
                    <button onclick="rotateImg(0)">Reset</button>
                </div>
                <script>
                    const img = document.querySelector('img');
                    const deviceId = '${deviceId}';
                    function rotateImg(deg) {
                        img.style.transform = 'rotate(' + deg + 'deg)';
                    }
                    function switchCamera() {
                        fetch('/switch-camera/' + deviceId, { method: 'POST' })
                            .then(r => r.text())
                            .then(msg => alert('Switch command sent to phone'))
                            .catch(e => console.error(e));
                    }
                </script>
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

// Root: daftar device aktif (dari Supabase, fallback ke in-memory jika supabase belum siap)
app.get('/stream', async (req, res) => {
    if (getCookie(req, 'access_granted') !== '1') {
        return showAccessForm(req, res);
    }

    let rows = [];
    if (supabase) {
        try {
            const { data, error } = await supabase
                .from('streams')
                .select('device_id, status, updated_at')
                .order('updated_at', { ascending: false })
                .limit(10);
            if (error) console.error('Supabase query error:', error.message);
            else rows = data || [];
        } catch (e) {
            console.error('Supabase query exception:', e.message);
        }
    }

    const rowsHtml = rows.length > 0
        ? rows.map(r => `<tr><td><a href="/stream/${r.device_id}">${r.device_id}</a></td><td>${r.status}</td></tr>`).join('')
        : '<tr><td colspan="2" style="color:#666">Belum ada device streaming</td></tr>';

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Camera Stream Relay</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; text-align: center; margin: 20px; background: #f0f0f0; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                h1 { margin-top: 0; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                th { background: #f4f4f4; }
                a { color: #007bff; text-decoration: none; font-size: 16px; }
                a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Camera Stream Relay</h1>
                <p>Device aktif (dari database):</p>
                <table>
                    <thead><tr><th>Device ID</th><th>Status</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

// Proses login kode akses
app.post('/access', express.urlencoded({ extended: false }), (req, res) => {
    const ip = getClientIp(req);
    const record = accessAttempts.get(ip) || { attempts: 0, lockedUntil: 0 };
    const now = Date.now();

    if (record.lockedUntil > now) {
        return res.redirect('/stream');
    }

    const code = req.body.code;
    if (code === ACCESS_CODE) {
        accessAttempts.delete(ip);
        res.setHeader('Set-Cookie', 'access_granted=1; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax');
        return res.redirect('/stream');
    }

    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
        record.lockedUntil = now + LOCKOUT_MS;
    }
    accessAttempts.set(ip, record);

    res.redirect('/stream');
});

// Redirect root ke /stream
app.get('/', (req, res) => {
    res.redirect('/stream');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Relay running on ${PORT}`);
    if (supabase) console.log('Supabase client initialized');
    else console.warn('Supabase not configured (missing SUPABASE_URL or SUPABASE_KEY)');
});

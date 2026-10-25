const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Load .env manually
if (fs.existsSync('.env')) {
    const content = fs.readFileSync('.env', 'utf8');
    content.split('\n').forEach(line => {
        const [key, ...val] = line.split('=');
        if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
}

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

// Helper: tampilkan form kode akses (Glassmorphism dark theme)
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

    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CameraStream — Akses Terlindungi</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body {
            display: flex; justify-content: center; align-items: center; min-height: 100vh;
            background-color: #000000; color: #ffffff; padding: 20px; overflow-x: hidden;
        }
        .card-wrapper {
            position: relative; width: 100%; max-width: 900px; height: 520px;
            background: #000000; border-radius: 20px; overflow: hidden;
            display: flex; justify-content: center; align-items: center;
            box-shadow: 0 20px 50px rgba(255, 255, 255, 0.05);
        }
        .card-wrapper::before {
            content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
            background: conic-gradient(
                transparent 0deg, transparent 75deg, #ffffff 88deg, #ffffff 92deg,
                transparent 105deg, transparent 255deg, #ffffff 268deg, #ffffff 272deg,
                transparent 285deg, transparent 360deg
            );
            animation: rotateSnake 8s linear infinite;
        }
        @keyframes rotateSnake {
            0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); }
        }
        .card-inner {
            position: absolute; inset: 2px;
            background-color: #000000; border-radius: 18px; z-index: 2;
            display: grid; grid-template-columns: 1fr 1fr; overflow: hidden;
        }
        .grid-left {
            position: relative; background-color: #ffffff; display: flex;
            justify-content: center; align-items: flex-end; overflow: hidden; user-select: none;
        }
        .grid-left svg { width: 100%; height: 100%; object-fit: contain; }
        .grid-right {
            display: flex; flex-direction: column; justify-content: center;
            padding: 50px 45px; background: #000000;
        }
        .login-header { margin-bottom: 32px; }
        .login-header h2 { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 6px; }
        .login-header p { font-size: 0.85rem; color: #777777; }
        .form-group { margin-bottom: 20px; position: relative; }
        .form-group label {
            display: block; font-size: 0.75rem; font-weight: 600;
            text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; color: #aaaaaa;
        }
        .form-group input {
            width: 100%; padding: 14px 16px; background: #1a1a1a; border: 1px solid #333333;
            border-radius: 8px; color: #ffffff; font-size: 0.9rem; outline: none; transition: all 0.3s ease;
        }
        .form-group input::placeholder { color: #444444; }
        .form-group input:focus { border-color: #ffffff; background: #111111; box-shadow: 0 0 10px rgba(255, 255, 255, 0.1); }
        .form-options {
            display: flex; justify-content: space-between; align-items: center;
            font-size: 0.8rem; margin-bottom: 28px; color: #777777;
        }
        .form-options label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .form-options a { color: #ffffff; text-decoration: none; transition: opacity 0.2s; }
        .form-options a:hover { opacity: 0.7; }
        .btn-login {
            width: 100%; padding: 14px; background: #ffffff; color: #000000;
            border: 1px solid #ffffff; border-radius: 8px; font-size: 0.85rem; font-weight: 700;
            letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer; transition: all 0.3s ease;
        }
        .btn-login:hover { background: #000000; color: #ffffff; box-shadow: 0 0 15px rgba(255, 255, 255, 0.2); }
        @media (max-width: 768px) {
            .card-wrapper { height: auto; }
            .card-inner { grid-template-columns: 1fr; }
            .grid-left { display: none; }
            .grid-right { padding: 40px 25px; }
        }
        .pupil { transition: cx 0.1s ease, cy 0.1s ease; }
        .eye-white { transition: ry 0.3s ease; }
        .eye-closed { ry: 1 !important; }
        #gridLeft { cursor: crosshair; }
    </style>
</head>
<body>
    <div class="card-wrapper">
        <div class="card-inner">
            <div class="grid-left" id="gridLeft">
                <svg class="silhouette-svg" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" id="avatarSvg">
                    <defs><mask id="body-cutout"><rect x="0" y="0" width="300" height="300" fill="#ffffff"/><circle cx="150" cy="115" r="70" fill="#000000"/></mask></defs>
                    <path d="M 30,300 L 270,300 L 270,250 C 270,185 215,165 150,165 C 85,165 30,185 30,250 Z" fill="#000000" mask="url(#body-cutout)"/>
                    <circle cx="150" cy="115" r="65" fill="#000000"/>
                    <ellipse id="eyeLeft" class="eye-white" cx="132" cy="110" rx="9" ry="14" fill="#ffffff"/>
                    <ellipse id="eyeRight" class="eye-white" cx="168" cy="110" rx="9" ry="14" fill="#ffffff"/>
                    <circle id="pupilLeft" class="pupil" cx="132" cy="110" r="6" fill="#000000"/>
                    <circle id="pupilRight" class="pupil" cx="168" cy="110" r="6" fill="#000000"/>
                </svg>
            </div>
            <div class="grid-right">
                <div class="login-header">
                    <h2>CameraStream</h2>
                    <p>Silakan masukkan kode akses untuk melihat device</p>
                </div>
                <form method="POST" action="/access" novalidate>
                    <div class="form-group">
                        <label for="access-code">Kode Akses</label>
                        <input type="text" id="access-code" name="code" autocomplete="one-time-code" placeholder="Ketik kode..." ${disabled} required>
                    </div>
                    <button type="submit" id="submit-btn" class="btn-login" ${disabled}>
                        <span id="btn-text">${locked ? 'Tunggu (' + remaining + 's)' : 'Masuk Sekarang'}</span>
                    </button>
                </form>
            </div>
        </div>
    </div>
    <script>
        (function() {
            const input = document.getElementById('access-code');
            const btnText = document.getElementById('btn-text');
            let remaining = ${remaining};

            if (remaining > 0) {
                const timer = setInterval(function() {
                    remaining--;
                    if (remaining <= 0) { clearInterval(timer); window.location.reload(); }
                    else btnText.textContent = 'Tunggu (' + remaining + 's)';
                }, 1000);
            } else if (input && !input.disabled) { input.focus(); }

            // Eye tracking
            const svg = document.getElementById('avatarSvg');
            const pupilLeft = document.getElementById('pupilLeft');
            const pupilRight = document.getElementById('pupilRight');
            const eyeLeftCenter = { x: 132, y: 110 };
            const eyeRightCenter = { x: 168, y: 110 };
            const maxDistance = 4.2;

            function getSvgCoordinates(clientX, clientY) {
                const point = svg.createSVGPoint();
                point.x = clientX; point.y = clientY;
                return point.matrixTransform(svg.getScreenCTM().inverse());
            }

            function updateEyeTracking(mouseX, mouseY) {
                const pos = getSvgCoordinates(mouseX, mouseY);
                let dx, dy, angle, dist, x, y;
                dx = pos.x - eyeLeftCenter.x; dy = pos.y - eyeLeftCenter.y;
                angle = Math.atan2(dy, dx); dist = Math.min(Math.hypot(dx, dy), maxDistance);
                x = eyeLeftCenter.x + Math.cos(angle) * dist; y = eyeLeftCenter.y + Math.sin(angle) * dist;
                pupilLeft.setAttribute('cx', x); pupilLeft.setAttribute('cy', y);
                dx = pos.x - eyeRightCenter.x; dy = pos.y - eyeRightCenter.y;
                angle = Math.atan2(dy, dx); dist = Math.min(Math.hypot(dx, dy), maxDistance);
                x = eyeRightCenter.x + Math.cos(angle) * dist; y = eyeRightCenter.y + Math.sin(angle) * dist;
                pupilRight.setAttribute('cx', x); pupilRight.setAttribute('cy', y);
            }

            window.addEventListener('mousemove', function(e) { requestAnimationFrame(function() { updateEyeTracking(e.clientX, e.clientY); }); });
            window.addEventListener('touchmove', function(e) { if (e.touches.length > 0) { requestAnimationFrame(function() { updateEyeTracking(e.touches[0].clientX, e.touches[0].clientY); }); } });

            // Eye blinking on input focus/typing
            const eyeLeft = document.getElementById('eyeLeft');
            const eyeRight = document.getElementById('eyeRight');
            let isFocused = false;
            let typingTimer = null;

            input.addEventListener('focus', function() {
                isFocused = true;
                eyeLeft.classList.add('eye-closed');
                eyeRight.classList.add('eye-closed');
                eyeLeft.style.ry = 1;
                eyeRight.style.ry = 1;
            });

            input.addEventListener('blur', function() {
                isFocused = false;
                eyeLeft.classList.remove('eye-closed');
                eyeRight.classList.remove('eye-closed');
                eyeLeft.style.ry = '';
                eyeRight.style.ry = '';
            });

            input.addEventListener('input', function() {
                if (typingTimer) clearTimeout(typingTimer);
                if (!isFocused) return;
                
                eyeLeft.style.ry = 1;
                eyeRight.style.ry = 1;
                
                typingTimer = setTimeout(function() {
                    if (!isFocused) return;
                    eyeLeft.style.ry = '';
                    eyeRight.style.ry = '';
                }, 300);
            });
        })();
    </script>
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
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Stream ${deviceId} — CameraStream</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body {
            display: flex; justify-content: center; align-items: center; min-height: 100vh;
            background-color: #000000; color: #ffffff; padding: 20px; overflow-x: hidden;
        }
        .card-wrapper {
            position: relative; width: 100%; max-width: 1100px; min-height: 600px;
            background: #000000; border-radius: 20px; overflow: hidden;
            display: flex; justify-content: center; align-items: center;
            box-shadow: 0 20px 50px rgba(255, 255, 255, 0.05);
        }
        .card-wrapper::before {
            content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
            background: conic-gradient(
                transparent 0deg, transparent 75deg, #ffffff 88deg, #ffffff 92deg,
                transparent 105deg, transparent 255deg, #ffffff 268deg, #ffffff 272deg,
                transparent 285deg, transparent 360deg
            );
            animation: rotateSnake 8s linear infinite;
        }
        @keyframes rotateSnake {
            0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); }
        }
        .card-inner {
            position: absolute; inset: 2px;
            background-color: #000000; border-radius: 18px; z-index: 2;
            display: flex; flex-direction: column; padding: 40px;
        }
        .header {
            display: flex; flex-direction: column; align-items: center; justify-content: center; margin-bottom: 32px; text-align: center;
        }
        .title-group { display: flex; flex-direction: column; gap: 6px; }
        .title-group h1 { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.5px; }
        .device-id { font-size: 0.85rem; color: #777777; letter-spacing: 1px; }
        .stream-wrapper {
            flex: 1; position: relative; background: #0a0a0a; border-radius: 12px; overflow: hidden;
            border: 1px solid #222222; margin-bottom: 24px; min-height: 400px;
            display: flex; align-items: center; justify-content: center;
        }
        .stream-wrapper img {
            width: 100%; height: 100%; object-fit: contain; display: block;
        }
        .stream-wrapper .status-message {
            position: absolute; color: #777777; font-size: 1.1rem; text-align: center;
        }
        .actions {
            display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; align-items: center;
        }
        .btn {
            display: inline-flex; align-items: center; justify-content: center; gap: 10px;
            padding: 12px 24px; background: #ffffff; color: #000000; border-radius: 8px;
            font-size: 0.75rem; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
            border: none; cursor: pointer; transition: all 0.3s ease;
        }
        .btn:hover {
            background: #000000; color: #ffffff; box-shadow: 0 0 15px rgba(255, 255, 255, 0.2);
        }
        .btn-icon {
            display: inline-flex; align-items: center; justify-content: center;
            padding: 10px; border-radius: 6px; background: #1a1a1a; color: #ffffff;
            border: 1px solid #333333; cursor: pointer; transition: all 0.3s ease;
        }
        .btn-icon:hover {
            background: #000000; border-color: #ffffff; box-shadow: 0 0 15px rgba(255, 255, 255, 0.2);
        }
        @media (max-width: 768px) {
            .card-inner { padding: 30px 20px; }
            .header { flex-direction: column; align-items: stretch; }
            .stream-wrapper { min-height: 300px; }
        }
    </style>
</head>
<body>
    <div class="card-wrapper">
        <div class="card-inner">
            <div class="header">
                <div class="title-group">
                    <h1>Camera Stream</h1>
                    <div class="device-id">Device ID: ${deviceId}</div>
                </div>
            </div>

            <div class="stream-wrapper" id="streamWrapper">
                <img src="/mjpeg/${deviceId}" alt="Camera Stream ${deviceId}" id="cameraStream" style="display:none;">
                <div class="status-message" id="statusMsg">Device ${deviceId} tidak aktif</div>
            </div>

            <div class="actions">
                <button class="btn" onclick="switchCamera()">
                    Ganti Kamera
                </button>
                <button class="btn-icon" onclick="rotateImg(270)" title="Putar 270°">↺</button>
                <button class="btn-icon" onclick="rotateImg(180)" title="Putar 180°">↻</button>
                <button class="btn-icon" onclick="rotateImg(90)" title="Putar 90°">↻</button>
                <button class="btn-icon" onclick="rotateImg(0)" title="Reset">⟲</button>
            </div>
        </div>
    </div>
    <script>
        const img = document.getElementById('cameraStream');
        const statusMsg = document.getElementById('statusMsg');
        
        img.onload = function() {
            img.style.display = 'block';
            statusMsg.style.display = 'none';
        };
        img.onerror = function() {
            img.style.display = 'none';
            statusMsg.style.display = 'block';
        };
        
        function rotateImg(deg) { img.style.transform = 'rotate(' + deg + 'deg)'; }
        function switchCamera() {
            fetch('/switch-camera/${deviceId}', { method: 'POST' }).then(r => r.text()).then(msg => alert(msg)).catch(e => console.error(e));
        }
    </script>
</body>
</html>
    `;
    res.send(html);
});

// Root: daftar device aktif (dari Supabase, fallback ke in-memory jika supabase belum siap)
app.get('/stream', async (req, res) => {
    try {
        const cookieValue = getCookie(req, 'access_granted');
        console.log('Cookie check: access_granted=' + cookieValue);
        console.log('Full cookie header:', req.headers.cookie);
        if (cookieValue !== '1') {
            console.log('No auth, showing access form');
            return showAccessForm(req, res);
        }
        console.log('Auth OK, showing table');

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
                rows = [];
            }
        }

    const rowsHtml = rows.length > 0
        ? rows.map(r => {
            const isAktif = r.status === 'aktif';
            const badgeClass = isAktif ? 'badge-active' : 'badge-inactive';
            const statusText = isAktif ? 'AKTIF' : 'NONAKTIF';
            const dotColor = isAktif ? '#22C55E' : '#64748B';
            return `
            <tr>
                <td class="col-device">
                    <a href="/stream/${r.device_id}" class="device-link">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="m11.2 8.375l3.5-6q2.275.6 4.038 2.2t2.562 3.8zm-2.775 2.5L5 4.875q1.35-1.325 3.138-2.1T12 2q.325 0 .75.038t.775.087zm-6.1 3.625q-.15-.6-.238-1.225T2 12q0-1.775.575-3.35T4.2 5.775L9.25 14.5zm7 7.125q-2.275-.6-4.05-2.2t-2.575-3.8h10.075zM12 22q-.375 0-.763-.05t-.737-.1l5.075-8.725l3.425 6q-1.35 1.325-3.137 2.1T12 22m7.8-3.775L14.75 9.5h6.925q.15.6.238 1.225T22 12q0 1.75-.612 3.35T19.8 18.225"/></svg>
                        <code>${r.device_id}</code>
                    </a>
                </td>
                <td class="col-status">
                    <span class="status-badge ${badgeClass}" role="status" aria-atomic="true">
                        <span class="status-dot" style="background:${dotColor}"></span>
                        ${statusText}
                    </span>
                </td>
                <td class="col-action">
                    <a href="/stream/${r.device_id}" class="btn-view">
                        Lihat Stream
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="m12 16l4-4l-4-4l-1.4 1.4l1.6 1.6H8v2h4.2l-1.6 1.6zM12 22q-2.075 0-3.9-.788t-3.175-2.137T2.788 15.9T2 12t.788-3.9t2.137-3.175T8.1 2.788T12 2t3.9.788t3.175 2.137T21.213 8.1T22 12t-.788 3.9t-2.137 3.175t-3.175 2.138T12 22"/></svg>
                    </a>
                </td>
            </tr>`;
        }).join('')
        : `<tr><td colspan="3" class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="m11.2 8.375l3.5-6q2.275.6 4.038 2.2t2.562 3.8zm-2.775 2.5L5 4.875q1.35-1.325 3.138-2.1T12 2q.325 0 .75.038t.775.087zm-6.1 3.625q-.15-.6-.238-1.225T2 12q0-1.775.575-3.35T4.2 5.775L9.25 14.5zm7 7.125q-2.275-.6-4.05-2.2t-2.575-3.8h10.075zM12 22q-.375 0-.763-.05t-.737-.1l5.075-8.725l3.425 6q-1.35 1.325-3.137 2.1T12 22m7.8-3.775L14.75 9.5h6.925q.15.6.238 1.225T22 12q0 1.75-.612 3.35T19.8 18.225"/></svg>
            <div>Belum ada device streaming</div>
            <p style="font-size:0.85rem; color:#777777; margin-top:6px;">Tekan "Start Stream" pada aplikasi Android untuk memulai</p>
          </td></tr>`;

    const cardRows = rows.length > 0
        ? rows.map(r => {
            const isAktif = r.status === 'aktif';
            const badgeClass = isAktif ? 'badge-active' : 'badge-inactive';
            const statusText = isAktif ? 'AKTIF' : 'NONAKTIF';
            const dotColor = isAktif ? '#ffffff' : '#777777';
            return `
            <div class="device-card">
                <div class="device-header">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="m11.2 8.375l3.5-6q2.275.6 4.038 2.2t2.562 3.8zm-2.775 2.5L5 4.875q1.35-1.325 3.138-2.1T12 2q.325 0 .75.038t.775.087zm-6.1 3.625q-.15-.6-.238-1.225T2 12q0-1.775.575-3.35T4.2 5.775L9.25 14.5zm7 7.125q-2.275-.6-4.05-2.2t-2.575-3.8h10.075zM12 22q-.375 0-.763-.05t-.737-.1l5.075-8.725l3.425 6q-1.35 1.325-3.137 2.1T12 22m7.8-3.775L14.75 9.5h6.925q.15.6.238 1.225T22 12q0 1.75-.612 3.35T19.8 18.225"/></svg>
                    <code>${r.device_id}</code>
                </div>
                <span class="status-badge ${badgeClass}">
                    <span class="status-dot" style="background:${dotColor}"></span>
                    ${statusText}
                </span>
                <a href="/stream/${r.device_id}" class="btn-view">Lihat Stream</a>
            </div>`;
        }).join('')
        : `<div class="empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="m11.2 8.375l3.5-6q2.275.6 4.038 2.2t2.562 3.8zm-2.775 2.5L5 4.875q1.35-1.325 3.138-2.1T12 2q.325 0 .75.038t.775.087zm-6.1 3.625q-.15-.6-.238-1.225T2 12q0-1.775.575-3.35T4.2 5.775L9.25 14.5zm7 7.125q-2.275-.6-4.05-2.2t-2.575-3.8h10.075zM12 22q-.375 0-.763-.05t-.737-.1l5.075-8.725l3.425 6q-1.35 1.325-3.137 2.1T12 22m7.8-3.775L14.75 9.5h6.925q.15.6.238 1.225T22 12q0 1.75-.612 3.35T19.8 18.225"/></svg>
            <div>Belum ada device streaming</div>
            <p style="font-size:0.85rem; color:#777777; margin-top:6px;">Tekan "Start Stream" pada aplikasi Android untuk memulai</p>
          </div>`;

    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CameraStream — Daftar Device Aktif</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        body {
            display: flex; justify-content: center; align-items: center; min-height: 100vh;
            background-color: #000000; color: #ffffff; padding: 20px; overflow-x: hidden;
        }
        .card-wrapper {
            position: relative; width: 100%; max-width: 900px; height: 520px;
            background: #000000; border-radius: 20px; overflow: hidden;
            display: flex; justify-content: center; align-items: center;
            box-shadow: 0 20px 50px rgba(255, 255, 255, 0.05);
        }
        .card-wrapper::before {
            content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
            background: conic-gradient(
                transparent 0deg, transparent 75deg, #ffffff 88deg, #ffffff 92deg,
                transparent 105deg, transparent 255deg, #ffffff 268deg, #ffffff 272deg,
                transparent 285deg, transparent 360deg
            );
            animation: rotateSnake 8s linear infinite;
        }
        @keyframes rotateSnake {
            0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); }
        }
        .card-inner {
            position: absolute; inset: 2px;
            background-color: #000000; border-radius: 18px; z-index: 2;
            display: flex; flex-direction: column; overflow: hidden;
        }
        .header { margin: 32px 40px 24px; text-align: center; }
        .header h2 { font-size: 1.6rem; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 6px; }
        .header p { font-size: 0.85rem; color: #777777; }
        .device-list {
            flex: 1; overflow-y: auto; padding: 0 40px 40px;
            display: flex; flex-direction: column; gap: 20px;
        }
        .device-list::-webkit-scrollbar { width: 6px; }
        .device-list::-webkit-scrollbar-track { background: #111111; border-radius: 3px; }
        .device-list::-webkit-scrollbar-thumb { background: #333333; border-radius: 3px; }
        .device-card {
            display: flex; align-items: center; justify-content: space-between; gap: 16px;
            padding: 20px; background: #111111; border-radius: 12px;
            border: 1px solid #222222; transition: all 0.3s ease;
        }
        .device-card:hover { background: #1a1a1a; border-color: #333333; }
        .device-header {
            display: flex; align-items: center; gap: 12px; color: #ffffff;
        }
        .device-header svg { width: 20px; height: 20px; flex-shrink: 0; }
        .device-header code { font-family: 'Fira Code', monospace; font-size: 0.95rem; }
        .status-badge {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 5px 12px; border-radius: 100px; font-size: 0.7rem; font-weight: 600;
            letter-spacing: 0.5px;
        }
        .badge-active { background: #ffffff; color: #000000; }
        .badge-inactive { background: #333333; color: #999999; }
        .status-dot { width: 6px; height: 6px; border-radius: 50%; }
        .badge-active .status-dot { background: #000000; }
        .badge-inactive .status-dot { background: #666666; }
        .btn-view {
            padding: 10px 20px; background: #ffffff; color: #000000;
            border-radius: 8px; font-size: 0.8rem; font-weight: 700;
            letter-spacing: 1px; text-transform: uppercase; text-decoration: none;
            transition: all 0.3s ease;
        }
        .btn-view:hover { background: #000000; color: #ffffff; box-shadow: 0 0 15px rgba(255, 255, 255, 0.2); transform: none; }
        .empty-state {
            text-align: center; padding: 60px 24px; color: #666666;
        }
        .empty-state svg { width: 48px; height: 48px; margin-bottom: 16px; opacity: 0.3; }
        .empty-state div { font-size: 0.95rem; font-weight: 500; margin-bottom: 8px; }
        .empty-state p { font-size: 0.8rem; color: #777777; }
        @media (max-width: 640px) {
            .card-wrapper { height: auto; }
            .card-inner { flex-direction: column; }
            .header { margin: 24px 24px 16px; }
            .device-list { padding: 0 24px 24px; }
            .device-card { flex-direction: column; align-items: stretch; text-align: center; gap: 12px; }
            .btn-view { width: 100%; }
        }
    </style>
</head>
<body>
    <div class="card-wrapper">
        <div class="card-inner">
            <div class="header">
                <h2>CameraStream Relay</h2>
                <p>Daftar device streaming aktif</p>
            </div>
            <div class="device-list">
                ${cardRows}
            </div>
        </div>
    </div>
</body>
</html>
    `;
    res.send(html);
  } catch (err) {
    console.error('Table route error:', err.message);
    res.status(500).send('Internal Server Error');
  }
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
    console.log('POST /access code:', code, 'expected:', ACCESS_CODE);
    if (code === ACCESS_CODE) {
        accessAttempts.delete(ip);
        console.log('Setting cookie access_granted=1');
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

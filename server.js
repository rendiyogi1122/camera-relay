const express = require('express');
const app = express();

// Map: deviceId -> { frame, timestamp, lastSent }
const devices = new Map();
const pendingCommands = new Map(); // deviceId -> command

// HP POST frame di sini
app.post('/upload-frame/:id', express.raw({ type: 'image/jpeg', limit: '5mb' }), (req, res) => {
    const deviceId = req.params.id;
    
    // Init device kalau belum ada
    if (!devices.has(deviceId)) {
        devices.set(deviceId, { frame: null, timestamp: 0, lastSent: null });
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
    res.set({
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
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
        if (!req.closed) setTimeout(sendFrame, 100);  // ~10fps
    };
    sendFrame();
    
    req.on('close', () => res.end());
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

// Root: daftar device aktif
app.get('/stream', (req, res) => {
    const links = Array.from(devices.entries()).map(([id]) => `<li><a href="/stream/${id}">${id}</a></li>`).join('');
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
                a { color: #007bff; text-decoration: none; font-size: 18px; }
                a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Camera Stream Relay</h1>
                <p>Device aktif:</p>
                <ul style="text-align: left; list-style: none; padding: 0;">
                    ${links || '<li style="color:#666">Belum ada device streaming</li>'}
                </ul>
            </div>
        </body>
        </html>
    `;
    res.send(html);
});

// Redirect root ke /stream
app.get('/', (req, res) => {
    res.redirect('/stream');
});

// Health check untuk Render
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Relay running on ${PORT}`));

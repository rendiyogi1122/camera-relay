const express = require('express');
const app = express();

let latestFrame = null;
let frameTimestamp = 0;
let pendingCommand = null;
let lastSentFrame = null;

// HP POST frame di sini
app.post('/upload-frame', express.raw({ type: 'image/jpeg', limit: '5mb' }), (req, res) => {
    latestFrame = req.body;
    frameTimestamp = Date.now();
    
    // Kirim command yang pending (jika ada) ke HP
    const cmd = pendingCommand || 'ok';
    pendingCommand = null;
    
    res.send(cmd);
});

// Switch camera command dari browser PC
app.post('/switch-camera', (req, res) => {
    pendingCommand = 'switch';
    res.send('Command queued');
});

// Browser GET MJPEG stream
app.get('/stream', (req, res) => {
    res.set({
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    const sendFrame = () => {
        // Kirim frame hanya kalau baru (tidak duplikat) dan fresh (<500ms old)
        if (latestFrame && latestFrame !== lastSentFrame && Date.now() - frameTimestamp < 500) {
            lastSentFrame = latestFrame;
            res.write(`--frame\r\n`);
            res.write(`Content-Type: image/jpeg\r\n`);
            res.write(`Content-Length: ${latestFrame.length}\r\n\r\n`);
            res.write(latestFrame);
            res.write('\r\n');
        }
        if (!req.closed) setTimeout(sendFrame, 100);  // ~10fps
    };
    sendFrame();
    
    req.on('close', () => res.end());
});

// Serve HTML control page di GET /
app.get('/', (req, res) => {
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Camera Stream Relay</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: sans-serif; text-align: center; margin: 20px; background: #f0f0f0; }
                .container { max-width: 800px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                img { max-width: 100%; height: auto; border: 1px solid #ccc; border-radius: 4px; background: #000; }
                button { padding: 12px 24px; font-size: 16px; cursor: pointer; margin-top: 10px; background: #007bff; color: white; border: none; border-radius: 4px; }
                button:hover { background: #0056b3; }
                .btn-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Camera Stream Relay</h1>
                <img src="/stream" alt="Camera Stream">
                <br>
                <div class="btn-row">
                    <button onclick="switchCamera()">Switch Camera</button>
                    <button onclick="rotateImg(90)">↻ 90°</button>
                    <button onclick="rotateImg(180)">↻ 180°</button>
                    <button onclick="rotateImg(270)">↻ 270°</button>
                    <button onclick="rotateImg(0)">Reset</button>
                </div>
                <script>
                    const img = document.querySelector('img');
                    function rotateImg(deg) {
                        img.style.transform = 'rotate(' + deg + 'deg)';
                    }
                    function switchCamera() {
                        fetch('/switch-camera', { method: 'POST' })
                            .then(r => r.text())
                            .then(msg => alert('Switch command sent to phone'))
                            .catch(e => console.error(e));
                    }
                </script>
        </body>
        </html>
    `;
    res.send(html);
});

// Health check untuk Render
app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Relay running on ${PORT}`));

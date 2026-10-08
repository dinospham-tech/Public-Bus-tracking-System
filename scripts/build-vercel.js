const fs = require('node:fs');
const path = require('node:path');

const configuredApiUrl = process.env.BUS_API_URL;
if (!configuredApiUrl) {
    throw new Error('Set BUS_API_URL in Vercel to the deployed backend URL (for example, https://your-service.onrender.com).');
}

let apiUrl;
try {
    const parsed = new URL(configuredApiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
    apiUrl = parsed.origin;
} catch {
    throw new Error('BUS_API_URL must be a valid HTTP or HTTPS URL.');
}

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const deviceKey = process.env.DEVICE_API_KEY || 'your-secret-device-key-here';
const apps = [
    { source: path.join(root, 'customer screen', 'index.html'), target: path.join(output, 'customer', 'index.html') },
    { source: path.join(root, 'driver screen', 'index.html'), target: path.join(output, 'driver', 'index.html') },
];
const configScript = `<script>window.BUS_API_URL=${JSON.stringify(apiUrl)};window.BUS_DEVICE_KEY=${JSON.stringify(deviceKey)};</script>`;

for (const app of apps) {
    let html = fs.readFileSync(app.source, 'utf8');
    if (!html.includes('<head>')) throw new Error(`Missing <head> in ${app.source}`);
    html = html.replace('<head>', `<head>\n    ${configScript}`);
    fs.mkdirSync(path.dirname(app.target), { recursive: true });
    fs.writeFileSync(app.target, html);
    for (const file of ['manifest.webmanifest', 'icon.svg', 'service-worker.js']) {
        fs.copyFileSync(path.join(path.dirname(app.source), file), path.join(path.dirname(app.target), file));
    }
}

console.log(`Prepared customer and driver pages for Vercel using ${apiUrl}`);

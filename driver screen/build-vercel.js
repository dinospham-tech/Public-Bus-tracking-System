const fs = require('node:fs');
const path = require('node:path');

const apiUrl = getApiUrl();
const deviceKey = process.env.DEVICE_API_KEY || 'your-secret-device-key-here';
const output = path.join(__dirname, 'dist');
fs.mkdirSync(output, { recursive: true });

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('<head>', `<head>\n<script>window.BUS_API_URL=${JSON.stringify(apiUrl)};window.BUS_DEVICE_KEY=${JSON.stringify(deviceKey)};</script>`);
fs.writeFileSync(path.join(output, 'index.html'), html);
for (const file of ['manifest.webmanifest', 'icon.svg', 'service-worker.js']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(output, file));
}

function getApiUrl() {
    if (!process.env.BUS_API_URL) throw new Error('Set BUS_API_URL to the Render API origin in Vercel project settings.');
    const url = new URL(process.env.BUS_API_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('BUS_API_URL must use HTTP or HTTPS.');
    return url.origin;
}

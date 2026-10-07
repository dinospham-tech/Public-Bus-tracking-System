require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { getAllRoutes, getRoute } = require('./route');
const { applyTelemetry, defaultLiveStatus, setSos } = require('./store');

const PORT = process.env.PORT || 8000;
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || 'your-secret-device-key-here';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// ------------------------------------------------------------------
// Auth: every request must carry X-Device-Key matching DEVICE_API_KEY,
// same as CONFIG.DEVICE_KEY in the frontend.
// ------------------------------------------------------------------
function requireDeviceKey(req, res, next) {
    const key = req.header('X-Device-Key');
    if (key !== DEVICE_API_KEY) {
        return res.status(401).json({ detail: 'Invalid or missing X-Device-Key' });
    }
    next();
}
app.use(requireDeviceKey);

// In-memory report log (swap for a DB in production).
const reports = [];

// ------------------------------------------------------------------
// GET /routes — list of routes with ordered stations
// ------------------------------------------------------------------
app.get('/routes', (req, res) => {
    res.json(getAllRoutes());
});

// ------------------------------------------------------------------
// GET /live/:busId — current known status of a bus
// ------------------------------------------------------------------
app.get('/live/:busId', (req, res) => {
    const { busId } = req.params;
    const routeId = req.query.route_id || 'demo';
    if (!getRoute(routeId)) {
        return res.status(404).json({ detail: `Unknown route_id: ${routeId}` });
    }
    res.json(defaultLiveStatus(busId, routeId));
});

// ------------------------------------------------------------------
// POST /telemetry — driver app pushes GPS/speed; we return updated live status
// and broadcast it to any connected WebSocket clients.
// ------------------------------------------------------------------
app.post('/telemetry', (req, res) => {
    const { bus_id, route_id, lat, lng, speed_kmh, timestamp, action } = req.body || {};

    if (typeof bus_id !== 'string' || !bus_id.trim() ||
        typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        typeof speed_kmh !== 'number' || !Number.isFinite(speed_kmh) || speed_kmh < 0 || speed_kmh > 150 ||
        !Number.isInteger(timestamp) || timestamp <= 0) {
        return res.status(400).json({ detail: 'bus_id, valid coordinates, speed_kmh (0–150), and a positive integer timestamp are required' });
    }
    if (route_id !== undefined && (typeof route_id !== 'string' || !route_id.trim())) {
        return res.status(400).json({ detail: 'route_id must be a non-empty string' });
    }
    if (action !== undefined && !['update', 'reached', 'skipped', 'emergency'].includes(action)) {
        return res.status(400).json({ detail: 'action must be update, reached, skipped, or emergency' });
    }
    if (!getRoute(route_id || 'demo')) {
        return res.status(404).json({ detail: `Unknown route_id: ${route_id}` });
    }

    const sos_active = action === 'emergency' ? true : undefined;

    const liveStatus = applyTelemetry({
        bus_id,
        route_id: route_id || 'demo',
        lat,
        lng,
        speed_kmh,
        timestamp,
        sos_active,
        action,
    });

    broadcastLiveStatus(liveStatus);
    res.json(liveStatus);
});

// ------------------------------------------------------------------
// POST /sos/:busId — explicit emergency toggle (used if you wire the SOS
// button to its own endpoint instead of piggybacking on /telemetry)
// ------------------------------------------------------------------
app.post('/sos/:busId', (req, res) => {
    const { busId } = req.params;
    const active = req.body?.active !== false; // default true
    const liveStatus = setSos(busId, active);
    if (!liveStatus) {
        return res.status(404).json({ detail: 'Unknown bus_id — send telemetry first' });
    }
    broadcastLiveStatus(liveStatus);
    res.json(liveStatus);
});

// ------------------------------------------------------------------
// POST /reports — driver incident/status reports
// ------------------------------------------------------------------
app.post('/reports', (req, res) => {
    const { bus_id, type, notes, location } = req.body || {};
    if (!type) {
        return res.status(400).json({ detail: 'type is required' });
    }
    const report = {
        id: reports.length + 1,
        bus_id: bus_id || null,
        type,
        notes: notes || '',
        location: location || '',
        created_at: new Date().toISOString(),
    };
    reports.push(report);
    res.status(201).json(report);
});

app.get('/reports', (req, res) => {
    const { bus_id } = req.query;
    const filtered = bus_id ? reports.filter((r) => r.bus_id === bus_id) : reports;
    res.json(filtered);
});

// ------------------------------------------------------------------
// HTTP + WebSocket server
// ------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/live' });

wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
        // Frontend sends a raw 'ping' string every 30s to keep the connection alive.
        if (msg.toString() === 'ping') return;
    });
});

function broadcastLiveStatus(liveStatus) {
    const payload = JSON.stringify({ type: 'live_status', data: liveStatus });
    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(payload);
        }
    });
}

server.listen(PORT, () => {
    console.log(`🚌 Bus tracker backend listening on http://localhost:${PORT}`);
    console.log(`📡 WebSocket live feed at ws://localhost:${PORT}/ws/live`);
    console.log(`🔑 Device key required: ${DEVICE_API_KEY === 'your-secret-device-key-here' ? '(default — change in .env!)' : 'set from .env'}`);
});

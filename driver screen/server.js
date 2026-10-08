require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const { getAllRoutes, getRoute } = require('./route');
const { applyTelemetry, defaultLiveStatus, listLiveStatuses, setSos, getBus } = require('./store');
const { distanceKm, etaMinutes } = require('./geo');

const PORT = process.env.PORT || 8000;
const DEVICE_API_KEY = process.env.DEVICE_API_KEY || 'your-secret-device-key-here';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const CORS_ORIGINS = CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);

const app = express();
app.use(cors({ origin: CORS_ORIGINS.includes('*') ? '*' : CORS_ORIGINS }));
app.use(express.json());

app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#102b4e"><title>CityBus · Live transit</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(145deg,#eaf2fb,#f8fafc);font:16px system-ui,sans-serif;color:#132b4a}.wrap{width:min(760px,100%)}.eyebrow{color:#3771ad;font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px}.title{font-size:clamp(36px,8vw,64px);line-height:1;margin:14px 0}.sub{color:#58708e;max-width:520px;line-height:1.6}.apps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:32px}.card{display:block;text-decoration:none;color:inherit;background:white;border:1px solid #dce6f1;border-radius:22px;padding:24px;box-shadow:0 14px 35px #19385b12;transition:transform .2s,box-shadow .2s}.card:hover{transform:translateY(-3px);box-shadow:0 20px 45px #19385b20}.icon{font-size:28px}.card h2{margin:16px 0 6px}.card p{color:#647b95;line-height:1.5;margin:0}.arrow{display:block;margin-top:22px;color:#1664ae;font-weight:700}</style></head><body><main class="wrap"><div class="eyebrow">CityBus · Live transit</div><h1 class="title">Your city,<br>in motion.</h1><p class="sub">Live bus tracking for passengers and a trip console for drivers. Choose an app to continue.</p><div class="apps"><a class="card" href="/customer"><div class="icon">🗺️</div><h2>Passenger app</h2><p>Plan a route, view bus arrivals, and follow service updates.</p><span class="arrow">Open passenger app →</span></a><a class="card" href="/driver"><div class="icon">🚌</div><h2>Driver app</h2><p>Share bus location, update stop progress, and send reports.</p><span class="arrow">Open driver app →</span></a></div></main></body></html>`);
});
app.get('/customer', (req, res) => res.sendFile(path.join(__dirname, '..', 'customer screen', 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Read-only passenger endpoints; write operations remain device-key protected.
app.get('/public/routes', (req, res) => {
    res.json(getAllRoutes());
});
app.get('/public/live/:busId', (req, res) => {
    const routeId = req.query.route_id || 'demo';
    if (!getRoute(routeId)) {
        return res.status(404).json({ detail: `Unknown route_id: ${routeId}` });
    }
    res.json(defaultLiveStatus(req.params.busId, routeId));
});
app.get('/public/buses/nearby', (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = req.query.radius_km === undefined ? 5 : Number(req.query.radius_km);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        !Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 25) {
        return res.status(400).json({ detail: 'Valid lat/lng and radius_km (0–25) are required' });
    }

    const now = Date.now();
    const nearby = listLiveStatuses()
        .filter((bus) => now - bus.last_update_ts <= 120000)
        .map((bus) => {
            const distance = distanceKm(lat, lng, bus.lat, bus.lng);
            const roadDistance = distance * 1.35;
            return {
                bus_id: bus.bus_id,
                route_id: bus.route_id,
                route_name: bus.route_name,
                distance_km: distance,
                eta_minutes: distance < 0.05 ? 1 : etaMinutes(roadDistance, bus.current_speed_kmh, 20),
                current_speed_kmh: bus.current_speed_kmh,
                delay_status: bus.delay_status,
                delay_minutes: bus.delay_minutes,
                sos_active: bus.sos_active,
                last_updated: new Date(bus.last_update_ts).toISOString(),
            };
        })
        .filter((bus) => bus.distance_km <= radiusKm)
        .sort((a, b) => a.eta_minutes - b.eta_minutes);

    res.json({
        radius_km: radiusKm,
        buses: nearby.map((bus) => ({ ...bus, distance_km: Number(bus.distance_km.toFixed(1)) })),
    });
});

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
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > 120) {
        return res.status(400).json({ detail: 'timestamp must be within 120 seconds of server time' });
    }
    const previousBus = getBus(bus_id);
    if (previousBus && timestamp <= Math.floor(previousBus.last_update_ts / 1000)) {
        return res.status(409).json({ detail: 'timestamp must be newer than the previous update' });
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚌 Bus tracker backend listening on http://localhost:${PORT}`);
    console.log(`📡 WebSocket live feed at ws://localhost:${PORT}/ws/live`);
    console.log(`🔑 Device key required: ${DEVICE_API_KEY === 'your-secret-device-key-here' ? '(default — change in .env!)' : 'set from .env'}`);
});

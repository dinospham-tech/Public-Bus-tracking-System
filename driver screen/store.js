const { distanceKm, etaMinutes } = require('./geo');
const { getRoute } = require('../data/routes');

// bus_id -> live state. Swap for Redis/DB if you need multi-process/persistence.
const buses = new Map();

const STOP_REACHED_THRESHOLD_KM = 0.25; // ~250m counts as "arrived"

function getOrCreateBus(busId, routeId) {
    if (!buses.has(busId)) {
        buses.set(busId, {
            bus_id: busId,
            route_id: routeId,
            lat: null,
            lng: null,
            speed_kmh: 0,
            current_stop_index: 0, // index into route.stations of the LAST reached stop
            sos_active: false,
            duty_start_ts: null,
            last_update_ts: null,
        });
    }
    return buses.get(busId);
}

function getBus(busId) {
    return buses.get(busId) || null;
}

/**
 * Apply a telemetry ping: update position, advance current_stop_index if the bus
 * has arrived at its next station, and return the computed live-status payload
 * shaped exactly how the frontend's updateUI() expects it.
 */
function applyTelemetry({ bus_id, route_id, lat, lng, speed_kmh, timestamp, sos_active }) {
    const route = getRoute(route_id) || getRoute('demo');
    const bus = getOrCreateBus(bus_id, route.route_id);

    bus.lat = lat;
    bus.lng = lng;
    bus.speed_kmh = speed_kmh || 0;
    bus.last_update_ts = timestamp ? timestamp * 1000 : Date.now();
    if (!bus.duty_start_ts) bus.duty_start_ts = bus.last_update_ts;
    if (typeof sos_active === 'boolean') bus.sos_active = sos_active;

    advanceStopIfArrived(bus, route);

    return buildLiveStatus(bus, route);
}

function advanceStopIfArrived(bus, route) {
    const stations = route.stations;
    const nextIndex = bus.current_stop_index + 1;
    if (nextIndex >= stations.length) return; // already at final stop

    const next = stations[nextIndex];
    if (bus.lat == null || bus.lng == null) return;

    const d = distanceKm(bus.lat, bus.lng, next.lat, next.lng);
    if (d <= STOP_REACHED_THRESHOLD_KM) {
        bus.current_stop_index = nextIndex;
    }
}

function setSos(busId, active) {
    const bus = buses.get(busId);
    if (!bus) return null;
    bus.sos_active = active;
    const route = getRoute(bus.route_id) || getRoute('demo');
    return buildLiveStatus(bus, route);
}

function classifyDelay(delayMinutes) {
    if (delayMinutes <= 1) return 'On Time';
    if (delayMinutes <= 5) return 'Slight Delay';
    return 'Delayed';
}

/** Builds the response shape consumed by the frontend's updateUI(). */
function buildLiveStatus(bus, route) {
    const stations = route.stations;
    const nextIndex = Math.min(bus.current_stop_index + 1, stations.length - 1);
    const nextStation = stations[nextIndex];
    const hasPosition = bus.lat != null && bus.lng != null;

    const distToNext = hasPosition
        ? distanceKm(bus.lat, bus.lng, nextStation.lat, nextStation.lng)
        : 0;
    const etaToNext = etaMinutes(distToNext, bus.speed_kmh);

    // Remaining stops after the next one, with cumulative ETA.
    const all_stops_eta = [];
    let cumulativeEta = etaToNext;
    let prevStation = nextStation;
    for (let i = nextIndex + 1; i < stations.length; i++) {
        const station = stations[i];
        const legDist = distanceKm(prevStation.lat, prevStation.lng, station.lat, station.lng);
        cumulativeEta += etaMinutes(legDist, bus.speed_kmh);
        all_stops_eta.push({
            station_id: station.station_id,
            station_name: station.station_name,
            eta_minutes: cumulativeEta,
        });
        prevStation = station;
    }

    // Delay = actual elapsed time since duty start vs. schedule for the last reached stop.
    let delay_minutes = 0;
    if (bus.duty_start_ts) {
        const elapsedMin = (Date.now() - bus.duty_start_ts) / 60000;
        const scheduledMin = stations[bus.current_stop_index].scheduled_offset_min;
        delay_minutes = Math.max(0, Math.round(elapsedMin - scheduledMin));
    }
    const delay_status = classifyDelay(delay_minutes);

    return {
        bus_id: bus.bus_id,
        route_id: route.route_id,
        route_name: route.route_name,
        lat: bus.lat,
        lng: bus.lng,
        current_speed_kmh: Math.round(bus.speed_kmh || 0),
        next_stop: {
            station_id: nextStation.station_id,
            station_name: nextStation.station_name,
            eta_minutes: etaToNext,
        },
        all_stops_eta,
        completed_stops: bus.current_stop_index,
        total_stops: stations.length,
        delay_status,
        delay_minutes,
        sos_active: bus.sos_active,
        last_update_ts: bus.last_update_ts,
    };
}

/** Default/idle status for a bus that hasn't sent telemetry yet (e.g. first /live/:busId call). */
function defaultLiveStatus(busId, routeId) {
    const route = getRoute(routeId) || getRoute('demo');
    const bus = getOrCreateBus(busId, route.route_id);
    if (bus.lat == null) {
        bus.lat = route.stations[0].lat;
        bus.lng = route.stations[0].lng;
    }
    return buildLiveStatus(bus, route);
}

module.exports = { applyTelemetry, getBus, setSos, defaultLiveStatus, buses };
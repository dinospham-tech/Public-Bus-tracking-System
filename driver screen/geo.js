const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
    return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in kilometers. */
function distanceKm(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_KM * c;
}

/** Minutes to cover a distance at a given speed. Falls back to a sane default speed if 0/unknown. */
function etaMinutes(distKm, speedKmh, fallbackSpeedKmh = 22) {
    const speed = speedKmh && speedKmh > 3 ? speedKmh : fallbackSpeedKmh;
    const minutes = (distKm / speed) * 60;
    return Math.max(1, Math.round(minutes));
}

module.exports = { distanceKm, etaMinutes, toRad };
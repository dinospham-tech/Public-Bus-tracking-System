const routes = {
    demo: {
        route_id: 'demo',
        route_name: 'Route 42A',
        stations: [
            { station_id: 'ST01', station_name: 'MG Road Junction', lat: 12.9716, lng: 77.5946, scheduled_offset_min: 0 },
            { station_id: 'ST02', station_name: 'Trinity Circle', lat: 12.9738, lng: 77.6069, scheduled_offset_min: 8 },
            { station_id: 'ST03', station_name: 'Ulsoor Lake Gate', lat: 12.9815, lng: 77.6205, scheduled_offset_min: 16 },
            { station_id: 'ST04', station_name: 'Indiranagar 100ft Rd', lat: 12.9719, lng: 77.6412, scheduled_offset_min: 26 },
            { station_id: 'ST05', station_name: 'Domlur Flyover', lat: 12.9611, lng: 77.6387, scheduled_offset_min: 34 },
            { station_id: 'ST06', station_name: 'Marathahalli Bridge', lat: 12.9569, lng: 77.7011, scheduled_offset_min: 48 },
        ],
    },
};

function getRoute(routeId) {
    return routes[routeId] || null;
}

function getAllRoutes() {
    return Object.values(routes);
}

module.exports = { getRoute, getAllRoutes };
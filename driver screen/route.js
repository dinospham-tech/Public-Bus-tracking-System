const routes = {
    demo: {
        route_id: 'demo',
        route_name: 'Route 42A · New Town',
        stations: [
            { station_id: 'ST01', station_name: 'UEM Kolkata', lat: 22.559973, lng: 88.490081, scheduled_offset_min: 0 },
            { station_id: 'ST02', station_name: 'Biswa Bangla Gate', lat: 22.56184, lng: 88.488748, scheduled_offset_min: 2 },
            { station_id: 'ST03', station_name: 'Eco Park Gate 1', lat: 22.59889, lng: 88.46694, scheduled_offset_min: 12 },
            { station_id: 'ST04', station_name: 'Chinar Park', lat: 22.6244, lng: 88.4388, scheduled_offset_min: 25 },
            { station_id: 'ST05', station_name: 'Kolkata Airport', lat: 22.65396, lng: 88.44672, scheduled_offset_min: 35 },
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

from __future__ import annotations
import asyncio
import json
import math
import os
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Annotated, Dict, List, Literal, Optional, Sequence

import redis.asyncio as aioredis
from redis.exceptions import LockError, RedisError
from fastapi import (
    BackgroundTasks,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Settings:
    device_api_key: str
    cors_origins: tuple[str, ...]
    redis_url: str
    eta_fallback_speed_kmh: float = 20.0
    max_telemetry_speed_kmh: float = 150.0
    telemetry_timestamp_tolerance_seconds: int = 120
    stale_bus_seconds: int = 120
    speed_history_len: int = 8
    bus_lock_timeout_seconds: int = 5


def load_settings() -> Settings:
    device_api_key = os.getenv("DEVICE_API_KEY")

    if not device_api_key:
        raise RuntimeError(
            "DEVICE_API_KEY environment variable is required."
        )

    raw_origins = os.getenv("CORS_ORIGINS", "")

    origins = tuple(
        origin.strip() for origin in raw_origins.split(",") if origin.strip()
    )

    if not origins:
        origins = ("*",)

    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")

    return Settings(
        device_api_key=device_api_key,
        cors_origins=origins,
        redis_url=redis_url,
    )


SETTINGS = load_settings()
EARTH_RADIUS_KM = 6371.0088

# Redis key namespaces
ROUTE_KEY = "route:{route_id}"
ROUTES_INDEX_KEY = "routes:index"
BUS_KEY = "bus:{bus_id}"
BUSES_INDEX_KEY = "buses:index"
BUS_LOCK_KEY = "lock:bus:{bus_id}"
LIVE_STATUS_CHANNEL = "live_status_channel"


# --------------------------------------------------------------------------
# Pure geometry helpers (unchanged - not memory-related, just math)
# --------------------------------------------------------------------------


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)

    delta_lat = math.radians(lat2 - lat1)
    delta_lng = math.radians(lng2 - lng1)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lng / 2) ** 2
    )

    return EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def _local_xy(lat: float, lng: float, reference_lat: float) -> tuple[float, float]:
    return (
        math.radians(lng) * math.cos(math.radians(reference_lat)),
        math.radians(lat),
    )


def _closest_point_fraction(
    point_lat: float,
    point_lng: float,
    start_lat: float,
    start_lng: float,
    end_lat: float,
    end_lng: float,
) -> tuple[float, float]:
    reference_lat = (point_lat + start_lat + end_lat) / 3.0

    px, py = _local_xy(point_lat, point_lng, reference_lat)
    ax, ay = _local_xy(start_lat, start_lng, reference_lat)
    bx, by = _local_xy(end_lat, end_lng, reference_lat)

    dx = bx - ax
    dy = by - ay
    denominator = dx * dx + dy * dy

    fraction = 0.0 if denominator == 0 else (((px - ax) * dx) + ((py - ay) * dy)) / denominator
    fraction = min(1.0, max(0.0, fraction))

    closest_x = ax + fraction * dx
    closest_y = ay + fraction * dy

    cross_track_km = math.hypot(px - closest_x, py - closest_y) * EARTH_RADIUS_KM

    return fraction, cross_track_km


def route_cumulative_distances(stations: Sequence["Station"]) -> list[float]:
    distances = [0.0]

    for previous, current in zip(stations, stations[1:]):
        distances.append(
            distances[-1] + haversine_km(previous.lat, previous.lng, current.lat, current.lng)
        )

    return distances


def route_progress_km(
    stations: Sequence["Station"], current_lat: float, current_lng: float
) -> tuple[float, list[float]]:
    cumulative = route_cumulative_distances(stations)

    if len(stations) < 2:
        return (cumulative[0] if cumulative else 0.0, cumulative)

    best_progress = 0.0
    best_cross_track = float("inf")

    for index, (start, end) in enumerate(zip(stations, stations[1:])):
        fraction, cross_track = _closest_point_fraction(
            current_lat, current_lng, start.lat, start.lng, end.lat, end.lng
        )

        segment_distance = cumulative[index + 1] - cumulative[index]
        progress = cumulative[index] + fraction * segment_distance

        if cross_track < best_cross_track:
            best_cross_track = cross_track
            best_progress = progress

    return best_progress, cumulative


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------


class StrictModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, str_strip_whitespace=True, allow_inf_nan=False
    )


class Station(StrictModel):
    station_id: Annotated[str, Field(min_length=1, max_length=64)]
    station_name: Annotated[str, Field(min_length=1, max_length=128)]
    lat: Annotated[float, Field(ge=-90, le=90)]
    lng: Annotated[float, Field(ge=-180, le=180)]
    sequence: Annotated[int, Field(ge=0)]


class TelemetryIn(StrictModel):
    bus_id: Annotated[str, Field(min_length=1, max_length=64)]
    route_id: Annotated[str, Field(min_length=1, max_length=64)]
    lat: Annotated[float, Field(ge=-90, le=90)]
    lng: Annotated[float, Field(ge=-180, le=180)]
    speed_kmh: Annotated[float, Field(ge=0, le=150)]
    timestamp: Annotated[int, Field(gt=0)]

    @field_validator("lat", "lng")
    @classmethod
    def validate_coordinates(cls, value: float) -> float:
        if value == 0:
            raise ValueError("GPS coordinates cannot be zero.")
        return value


class NextStop(StrictModel):
    station_id: str
    station_name: str
    eta_minutes: int
    distance_km: float


class LiveStatus(StrictModel):
    bus_id: str
    route_id: str
    route_name: str
    current_speed_kmh: float
    last_updated: datetime
    current_lat: float
    current_lng: float
    next_stop: Optional[NextStop]
    all_stops_eta: List[NextStop]
    crowd_level: str
    delay_status: str
    delay_minutes: int
    stale: bool
    sos_active: bool


class TelemetryAccepted(StrictModel):
    status: Literal["accepted"] = "accepted"
    bus_id: str
    route_id: str
    received_at: datetime
    next_stop: Optional[NextStop]
    distance_to_next_stop_km: Optional[float]
    eta_to_next_stop_minutes: Optional[int]


@dataclass(slots=True)
class RouteRecord:
    route_id: str
    route_name: str
    stations: List[Station]
    scheduled_eta_minutes: Dict[str, int] = field(default_factory=dict)


@dataclass(slots=True)
class BusRecord:
    telemetry: TelemetryIn
    received_at: datetime
    speed_history: deque = field(default_factory=lambda: deque(maxlen=SETTINGS.speed_history_len))
    crowd_level: str = "Moderate"
    sos_active: bool = False


# --------------------------------------------------------------------------
# Redis (de)serialization
# --------------------------------------------------------------------------


def serialize_route(route: RouteRecord) -> str:
    return json.dumps(
        {
            "route_id": route.route_id,
            "route_name": route.route_name,
            "stations": [s.model_dump() for s in route.stations],
            "scheduled_eta_minutes": route.scheduled_eta_minutes,
        }
    )


def deserialize_route(raw: str) -> RouteRecord:
    data = json.loads(raw)
    return RouteRecord(
        route_id=data["route_id"],
        route_name=data["route_name"],
        stations=[Station(**s) for s in data["stations"]],
        scheduled_eta_minutes=data["scheduled_eta_minutes"],
    )


def serialize_bus(record: BusRecord) -> str:
    return json.dumps(
        {
            "telemetry": record.telemetry.model_dump(),
            "received_at": record.received_at.isoformat(),
            "speed_history": list(record.speed_history),
            "crowd_level": record.crowd_level,
            "sos_active": record.sos_active,
        }
    )


def deserialize_bus(raw: str) -> BusRecord:
    data = json.loads(raw)
    return BusRecord(
        telemetry=TelemetryIn(**data["telemetry"]),
        received_at=datetime.fromisoformat(data["received_at"]),
        speed_history=deque(data["speed_history"], maxlen=SETTINGS.speed_history_len),
        crowd_level=data["crowd_level"],
        sos_active=data["sos_active"],
    )


# --------------------------------------------------------------------------
# ETA / delay computation (pure functions, unchanged logic)
# --------------------------------------------------------------------------


def _rolling_speed(record: BusRecord, settings: Settings) -> float:
    valid = [speed for speed in record.speed_history if speed > 0]

    if not valid:
        return settings.eta_fallback_speed_kmh

    return max(1.0, sum(valid) / len(valid))


def _eta_entries(route: RouteRecord, record: BusRecord, settings: Settings) -> List[NextStop]:
    progress, cumulative = route_progress_km(
        route.stations, record.telemetry.lat, record.telemetry.lng
    )

    speed = _rolling_speed(record, settings)
    entries: List[NextStop] = []

    for index, station in enumerate(route.stations):
        if index == 0:
            continue

        if cumulative[index] <= progress + 0.05:
            continue

        distance = max(0.0, cumulative[index] - progress)
        eta = max(1, math.ceil((distance / speed) * 60))

        entries.append(
            NextStop(
                station_id=station.station_id,
                station_name=station.station_name,
                eta_minutes=eta,
                distance_km=round(distance, 2),
            )
        )

    return entries


def _delay_status(
    route: RouteRecord, entries: List[NextStop]
) -> tuple[str, int]:
    if not entries:
        return "On Time", 0

    next_stop = entries[0]
    scheduled = route.scheduled_eta_minutes.get(next_stop.station_id)

    if scheduled is None:
        return "On Time", 0

    delay = next_stop.eta_minutes - scheduled

    if delay <= 1:
        return "On Time", 0

    if delay <= 5:
        return "Slight Delay", delay

    return "Delayed", delay


def build_live_status(
    route: RouteRecord, record: BusRecord, settings: Settings
) -> LiveStatus:
    entries = _eta_entries(route, record, settings)
    delay_status, delay_minutes = _delay_status(route, entries)

    age = (datetime.now(timezone.utc) - record.received_at).total_seconds()
    stale = age > settings.stale_bus_seconds

    return LiveStatus(
        bus_id=record.telemetry.bus_id,
        route_id=route.route_id,
        route_name=route.route_name,
        current_speed_kmh=round(record.telemetry.speed_kmh, 1),
        last_updated=record.received_at,
        current_lat=record.telemetry.lat,
        current_lng=record.telemetry.lng,
        next_stop=entries[0] if entries else None,
        all_stops_eta=entries,
        crowd_level=record.crowd_level,
        delay_status=delay_status,
        delay_minutes=delay_minutes,
        stale=stale,
        sos_active=record.sos_active,
    )


# --------------------------------------------------------------------------
# Redis-backed transit store
# --------------------------------------------------------------------------


class TransitStore:
    """
    All state lives in Redis instead of process memory, so:
      - data survives a restart/deploy (with Redis persistence enabled)
      - multiple API instances behind a load balancer share the same
        routes/bus positions instead of each holding its own copy
      - the per-bus lock is a distributed Redis lock, so concurrent
        telemetry updates for the same bus stay correct across instances
    """

    def __init__(self, settings: Settings, redis_client: aioredis.Redis) -> None:
        self.settings = settings
        self.redis = redis_client

    async def add_route(self, route: RouteRecord) -> None:
        if len(route.stations) < 2:
            raise ValueError("Route requires at least two stations.")

        route.stations.sort(key=lambda station: station.sequence)

        await self.redis.set(
            ROUTE_KEY.format(route_id=route.route_id), serialize_route(route)
        )
        await self.redis.sadd(ROUTES_INDEX_KEY, route.route_id)

    async def get_route(self, route_id: str) -> Optional[RouteRecord]:
        raw = await self.redis.get(ROUTE_KEY.format(route_id=route_id))
        return deserialize_route(raw) if raw is not None else None

    async def list_routes(self) -> List[RouteRecord]:
        route_ids = await self.redis.smembers(ROUTES_INDEX_KEY)

        if not route_ids:
            return []

        raw_values = await self.redis.mget(
            [ROUTE_KEY.format(route_id=rid) for rid in route_ids]
        )

        return [deserialize_route(raw) for raw in raw_values if raw is not None]

    async def get_bus_record(self, bus_id: str) -> Optional[BusRecord]:
        raw = await self.redis.get(BUS_KEY.format(bus_id=bus_id))
        return deserialize_bus(raw) if raw is not None else None

    async def live_status(self, bus_id: str) -> Optional[LiveStatus]:
        record = await self.get_bus_record(bus_id)

        if record is None:
            return None

        route = await self.get_route(record.telemetry.route_id)

        if route is None:
            return None

        return build_live_status(route, record, self.settings)

    async def all_live_statuses(self) -> List[LiveStatus]:
        bus_ids = await self.redis.smembers(BUSES_INDEX_KEY)
        statuses: List[LiveStatus] = []

        for bus_id in bus_ids:
            status = await self.live_status(bus_id)

            if status is not None:
                statuses.append(status)

        return statuses

    async def update_telemetry(
        self, telemetry: TelemetryIn
    ) -> tuple[TelemetryAccepted, LiveStatus]:
        route = await self.get_route(telemetry.route_id)

        if route is None:
            raise KeyError(f"Unknown route_id: {telemetry.route_id}")

        lock = self.redis.lock(
            BUS_LOCK_KEY.format(bus_id=telemetry.bus_id),
            timeout=self.settings.bus_lock_timeout_seconds,
        )

        acquired = await lock.acquire(
            blocking=True, blocking_timeout=self.settings.bus_lock_timeout_seconds
        )

        if not acquired:
            raise TimeoutError("Could not acquire lock for bus update.")

        try:
            now = datetime.now(timezone.utc)
            existing = await self.get_bus_record(telemetry.bus_id)

            if existing is not None:
                if telemetry.timestamp <= existing.telemetry.timestamp:
                    raise ValueError(
                        "Telemetry timestamp must be newer than the previous update."
                    )

                record = existing

                if existing.telemetry.route_id != telemetry.route_id:
                    record.speed_history.clear()
            else:
                record = BusRecord(telemetry=telemetry, received_at=now)

            record.telemetry = telemetry
            record.received_at = now

            speed = min(telemetry.speed_kmh, self.settings.max_telemetry_speed_kmh)
            record.speed_history.append(speed)

            live = build_live_status(route, record, self.settings)

            await self.redis.set(
                BUS_KEY.format(bus_id=telemetry.bus_id), serialize_bus(record)
            )
            await self.redis.sadd(BUSES_INDEX_KEY, telemetry.bus_id)

            next_stop = live.next_stop

            accepted = TelemetryAccepted(
                bus_id=telemetry.bus_id,
                route_id=telemetry.route_id,
                received_at=now,
                next_stop=next_stop,
                distance_to_next_stop_km=(next_stop.distance_km if next_stop else None),
                eta_to_next_stop_minutes=(next_stop.eta_minutes if next_stop else None),
            )

            envelope = json.dumps({"type": "live_status", "data": json.loads(live.model_dump_json())})
            await self.redis.publish(LIVE_STATUS_CHANNEL, envelope)

            return accepted, live
        finally:
            try:
                await lock.release()
            except LockError:
                # Lock already expired/released - safe to ignore.
                pass


# --------------------------------------------------------------------------
# App wiring
# --------------------------------------------------------------------------

REDIS_CLIENT: aioredis.Redis = aioredis.from_url(
    SETTINGS.redis_url, decode_responses=True
)
STORE = TransitStore(SETTINGS, REDIS_CLIENT)

WS_CLIENTS: set[WebSocket] = set()
WS_LOCK = asyncio.Lock()

_pubsub_task: Optional[asyncio.Task] = None


async def _forward_to_local_clients(message: str) -> None:
    async with WS_LOCK:
        clients = list(WS_CLIENTS)

    dead = []

    for ws in clients:
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)

    if dead:
        async with WS_LOCK:
            for ws in dead:
                WS_CLIENTS.discard(ws)


async def _pubsub_listener() -> None:
    """
    Runs for the lifetime of the app. If the Redis connection drops mid-stream,
    resubscribe with backoff instead of letting the task die silently — a dead
    listener means broadcasting stops with no visible error until a restart.
    """
    backoff_seconds = 1.0

    while True:
        pubsub = REDIS_CLIENT.pubsub()

        try:
            await pubsub.subscribe(LIVE_STATUS_CHANNEL)
            backoff_seconds = 1.0  # reset once a subscription succeeds

            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue

                await _forward_to_local_clients(message["data"])
        except asyncio.CancelledError:
            return
        except RedisError:
            await asyncio.sleep(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, 30.0)
        finally:
            try:
                await pubsub.unsubscribe(LIVE_STATUS_CHANNEL)
                await pubsub.close()
            except Exception:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pubsub_task

    # Seed a demo route only if none exist yet (keeps Redis as source of truth
    # across restarts instead of re-adding it in memory every boot).
    if not await REDIS_CLIENT.smembers(ROUTES_INDEX_KEY):
        stations = [
            Station(station_id="s1", station_name="Central", lat=12.9716, lng=77.5946, sequence=0),
            Station(station_id="s2", station_name="Mall", lat=12.9750, lng=77.5990, sequence=1),
            Station(station_id="s3", station_name="University", lat=12.9800, lng=77.6050, sequence=2),
        ]

        await STORE.add_route(
            RouteRecord(
                route_id="demo",
                route_name="Demo Route",
                stations=stations,
                scheduled_eta_minutes={"s2": 3, "s3": 7},
            )
        )

    _pubsub_task = asyncio.create_task(_pubsub_listener())

    yield

    if _pubsub_task is not None:
        _pubsub_task.cancel()
        try:
            await _pubsub_task
        except asyncio.CancelledError:
            pass

    await REDIS_CLIENT.aclose()


app = FastAPI(title="Where Is My Bus API", version="2.0.0", lifespan=lifespan)


if SETTINGS.cors_origins == ("*",):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(SETTINGS.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/health")
async def health():
    try:
        await REDIS_CLIENT.ping()
    except RedisError:
        raise HTTPException(status_code=503, detail="Redis unavailable.")

    routes_count = await REDIS_CLIENT.scard(ROUTES_INDEX_KEY)
    buses_count = await REDIS_CLIENT.scard(BUSES_INDEX_KEY)

    return {
        "status": "ok",
        "routes": routes_count,
        "buses": buses_count,
        "timestamp": datetime.now(timezone.utc),
    }


@app.get("/routes")
async def routes():
    return [
        {
            "route_id": route.route_id,
            "route_name": route.route_name,
            "stations": [station.model_dump() for station in route.stations],
        }
        for route in await STORE.list_routes()
    ]


@app.post("/telemetry", response_model=TelemetryAccepted)
async def telemetry(
    payload: TelemetryIn,
    x_device_key: Optional[str] = Header(None, alias="X-Device-Key"),
):
    if not x_device_key or x_device_key != SETTINGS.device_api_key:
        raise HTTPException(status_code=403, detail="Invalid device key.")

    now_timestamp = int(datetime.now(timezone.utc).timestamp())
    difference = abs(now_timestamp - payload.timestamp)

    if difference > SETTINGS.telemetry_timestamp_tolerance_seconds:
        raise HTTPException(
            status_code=400,
            detail="Telemetry timestamp is outside the allowed time window.",
        )

    try:
        accepted, _live = await STORE.update_telemetry(payload)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RedisError:
        raise HTTPException(status_code=503, detail="Storage unavailable.")

    return accepted


@app.get("/live", response_model=List[LiveStatus])
async def all_live():
    return await STORE.all_live_statuses()


@app.get("/live/{bus_id}", response_model=LiveStatus)
async def live(bus_id: str):
    status = await STORE.live_status(bus_id)

    if status is None:
        raise HTTPException(status_code=404, detail="Bus not found.")

    return status


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    await websocket.accept()

    async with WS_LOCK:
        WS_CLIENTS.add(websocket)

    try:
        for live_status in await STORE.all_live_statuses():
            await websocket.send_json(
                {"type": "live_status", "data": live_status.model_dump(mode="json")}
            )

        while True:
            message = await websocket.receive_text()

            if message == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        async with WS_LOCK:
            WS_CLIENTS.discard(websocket)


@app.get("/", response_class=HTMLResponse)
async def root():
    return """
    <!doctype html>
    <html>
    <head>
        <title>Where Is My Bus API</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; max-width: 760px; margin: 60px auto; padding: 20px; }
            code { background: #f2f2f2; padding: 3px 6px; border-radius: 4px; }
        </style>
    </head>
    <body>
        <h1>Where Is My Bus API</h1>
        <p>Backend is running (Redis-backed, horizontally scalable).</p>
        <p>API documentation: <a href="/docs">/docs</a></p>
        <p>Health: <a href="/health">/health</a></p>
    </body>
    </html>
    """


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=False)

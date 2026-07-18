#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');

if (process.argv.includes('--self-check')) {
  const route = buildRoute([
    [112.75, -7.25],
    [112.751, -7.251],
    [112.752, -7.252],
  ]);
  const point = positionAt(route, route.total / 2);
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || route.total <= 0) {
    throw new Error('Route interpolation self-check failed');
  }
  console.log('race-simulator self-check passed');
  process.exit(0);
}

if (process.env.CONFIRM_PRODUCTION_LOAD !== 'YES') {
  throw new Error('Set CONFIRM_PRODUCTION_LOAD=YES to confirm intentional load generation');
}

const apiUrl = process.env.API_URL || 'https://apiv2.dashlytrack.cloud';
const mqttUrl = process.env.MQTT_URL || 'mqtt://127.0.0.1:1884';
const eventId = positiveInteger('EVENT_ID');
const durationMs = parseDuration(process.env.DURATION || '5m');
const updateIntervalMs = positiveInteger('UPDATE_INTERVAL_MS', 1000);
const socketClients = nonNegativeInteger('SOCKET_CLIENTS', 2);
const participantLimit = positiveInteger('PARTICIPANT_LIMIT', 10);
const drainDurationMs = parseDuration(process.env.DRAIN_DURATION || '30s');
const maxE2eP95Ms = positiveInteger('MAX_E2E_P95_MS', 3000);
const staffToken = required('STAFF_ACCESS_TOKEN');
const participantsPath = process.env.PARTICIPANTS_FILE || 'k6/participants.json';
const participantData = JSON.parse(fs.readFileSync(participantsPath, 'utf8'));

if (!Array.isArray(participantData) || participantData.length === 0) {
  throw new Error(`${participantsPath} must contain [{"userId": 123}, ...]`);
}
for (const participant of participantData) {
  if (!Number.isInteger(participant.userId) || participant.userId <= 0) {
    throw new Error('Every participant must have a positive integer userId');
  }
}
if (participantLimit > participantData.length) {
  throw new Error(
    `PARTICIPANT_LIMIT=${participantLimit} exceeds ${participantData.length} prepared participants`,
  );
}
const participants = participantData.slice(0, participantLimit);

const runId = `${Date.now()}-${process.pid}`;
const metrics = {
  published: 0,
  locationPublished: 0,
  publishErrors: 0,
  syncPoints: 0,
  socketConnected: 0,
  socketErrors: 0,
  socketPositions: 0,
  latency: [],
};
const clients = [];
const timers = [];
const sockets = [];
const connectedSocketIndexes = new Set();
let stopping = false;

main().catch((error) => {
  console.error(error);
  void stop(1);
});

async function main() {
  const eventResponse = await fetch(`${apiUrl}/public-events/${eventId}`);
  if (!eventResponse.ok) throw new Error(`Event request failed: HTTP ${eventResponse.status}`);
  const eventBody = await eventResponse.json();
  const coordinates = extractCoordinates(eventBody?.data?.routeGeojson);
  const route = buildRoute(coordinates);

  console.log(
    `Starting manual race simulation: ${participants.length} participants, ${socketClients} operator sockets, ` +
      `${updateIntervalMs}ms GPS interval, ${Math.round(durationMs / 1000)}s load + ` +
      `${Math.round(drainDurationMs / 1000)}s drain`,
  );

  for (let index = 0; index < socketClients; index += 1) connectSocket(index);
  for (let index = 0; index < participants.length; index += 1) {
    const delay = Math.floor((index / participants.length) * Math.min(30_000, durationMs / 10));
    timers.push(setTimeout(() => connectParticipant(participants[index], index, route), delay));
  }

  timers.push(setInterval(printProgress, 10_000));
  timers.push(setTimeout(() => void stop(0), durationMs));
  process.once('SIGINT', () => void stop(130));
  process.once('SIGTERM', () => void stop(143));
}

function connectParticipant(participant, index, route) {
  if (stopping) return;

  const client = mqtt.connect(mqttUrl, {
    clientId: `dashly-k6-${runId}-${participant.userId}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
  });
  clients.push(client);

  const speed = 5 + deterministicFraction(participant.userId) * 7;
  const startDistance =
    route.total * 0.1 + deterministicFraction(participant.userId * 17) * route.total * 0.25;
  const state = { sequence: 0, elapsedSteps: 0, buffered: [], offlineUntil: 0, recovered: false };

  client.on('connect', () => {
    if (state.timer) return;
    state.timer = setInterval(
      () => tickParticipant(client, participant, index, route, speed, startDistance, state),
      updateIntervalMs,
    );
    timers.push(state.timer);
  });
  client.on('error', () => {
    metrics.publishErrors += 1;
  });
}

function tickParticipant(client, participant, index, route, speed, startDistance, state) {
  const now = Date.now();
  state.sequence += 1;
  state.elapsedSteps += 1;

  const distance = Math.min(
    route.total,
    startDistance + (speed * (state.elapsedSteps * updateIntervalMs)) / 1000,
  );
  const point = positionAt(route, distance);
  const payload = {
    msg_id: `k6-${runId}-${participant.userId}-${state.sequence}`,
    lat: point.lat,
    lng: point.lng,
    speed: Number(speed.toFixed(2)),
    battery: Math.max(20, 100 - Math.floor(state.elapsedSteps / 120)),
    captured_at: new Date(now).toISOString(),
    status: distance >= route.total ? 'finished' : 'moving',
  };

  const isOfflineParticipant = deterministicFraction(participant.userId * 31) < 0.03;
  if (isOfflineParticipant && !state.recovered && !state.offlineUntil && state.elapsedSteps > 45) {
    state.offlineUntil = now + 15_000;
  }
  if (state.offlineUntil > now) {
    state.buffered.push(payload);
    return;
  }
  if (state.offlineUntil && state.buffered.length) {
    publish(client, `dashly/events/${eventId}/p/${participant.userId}/sync`, state.buffered);
    metrics.syncPoints += state.buffered.length;
    state.buffered = [];
    state.offlineUntil = 0;
    state.recovered = true;
  }

  publish(client, `dashly/events/${eventId}/p/${participant.userId}/loc`, payload, true);

  if (index === 0 && state.sequence === 90) {
    publish(client, `dashly/events/${eventId}/p/${participant.userId}/sos`, payload);
  }
}

function publish(client, topic, payload, isLocation = false) {
  client.publish(topic, JSON.stringify(payload), { qos: 0 }, (error) => {
    if (error) {
      metrics.publishErrors += 1;
      return;
    }
    metrics.published += 1;
    if (isLocation) metrics.locationPublished += 1;
  });
}

function connectSocket(index) {
  const transports = (process.env.SOCKET_TRANSPORTS || 'polling,websocket')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const socket = io(apiUrl, {
    auth: { token: staffToken },
    transports,
    reconnection: true,
    reconnectionAttempts: 10,
    timeout: 10_000,
    withCredentials: true,
  });
  sockets.push(socket);

  socket.on('connect', () => {
    connectedSocketIndexes.add(index);
    metrics.socketConnected = connectedSocketIndexes.size;
    socket.emit('joinEventRoom', { eventId });
  });
  socket.on('connect_error', (error) => {
    metrics.socketErrors += 1;
    if (metrics.socketErrors <= 5) console.error(`Socket ${index} connect error: ${error.message}`);
  });
  socket.on('auth_error', (error) => {
    metrics.socketErrors += 1;
    console.error(`Socket ${index} auth error: ${JSON.stringify(error)}`);
  });
  socket.on('position_batch', (batch) => {
    for (const position of batch?.positions || []) {
      metrics.socketPositions += 1;
      const timestamp = Date.parse(position.timestamp || position.capturedAt || '');
      if (Number.isFinite(timestamp)) metrics.latency.push(Math.max(0, Date.now() - timestamp));
    }
  });
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);

  if (exitCode === 0 && drainDurationMs > 0) {
    console.log(`Load stopped; observing queue drain for ${drainDurationMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, drainDurationMs));
  }

  for (const socket of sockets) socket.disconnect();
  await Promise.all(clients.map((client) => new Promise((resolve) => client.end(true, resolve))));
  const passed = printSummary();
  process.exitCode = exitCode || (passed ? 0 : 1);
}

function printProgress() {
  const p95 = percentile(metrics.latency, 0.95);
  console.log(
    `published=${metrics.published} errors=${metrics.publishErrors} socketPositions=${metrics.socketPositions} ` +
      `e2eP95=${p95 == null ? '-' : `${p95}ms`}`,
  );
}

function printSummary() {
  const p95 = percentile(metrics.latency, 0.95);
  const expectedSocketPositions = metrics.locationPublished * socketClients;
  const deliveryRatio =
    expectedSocketPositions === 0 ? null : metrics.socketPositions / expectedSocketPositions;
  const passed =
    metrics.published > 0 &&
    metrics.publishErrors === 0 &&
    metrics.socketConnected === socketClients &&
    metrics.socketErrors === 0 &&
    (socketClients === 0 ||
      (metrics.socketPositions > 0 &&
        deliveryRatio !== null &&
        deliveryRatio >= 0.9 &&
        p95 !== null &&
        p95 < maxE2eP95Ms));
  const summary = {
    passed,
    thresholds: { maxE2eP95Ms, minDeliveryRatio: 0.9 },
    expectedSocketPositions,
    deliveryRatio,
    ...metrics,
    latency: undefined,
    e2eLatencyMs: {
      samples: metrics.latency.length,
      p50: percentile(metrics.latency, 0.5),
      p95: percentile(metrics.latency, 0.95),
      p99: percentile(metrics.latency, 0.99),
      max: metrics.latency.length ? Math.max(...metrics.latency) : null,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  return passed;
}

function extractCoordinates(geoJson) {
  const features = geoJson?.type === 'FeatureCollection' ? geoJson.features : [geoJson];
  for (const feature of features || []) {
    const geometry = feature?.type === 'Feature' ? feature.geometry : feature;
    if (geometry?.type === 'LineString' && geometry.coordinates?.length > 1)
      return geometry.coordinates;
    if (geometry?.type === 'MultiLineString' && geometry.coordinates?.[0]?.length > 1) {
      return geometry.coordinates.flat();
    }
  }
  throw new Error('Event has no usable LineString routeGeojson');
}

function buildRoute(coordinates) {
  const points = coordinates.map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }));
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversine(points[index - 1], points[index]));
  }
  return { points, cumulative, total: cumulative.at(-1) };
}

function positionAt(route, distance) {
  const target = Math.max(0, Math.min(route.total, distance));
  let high = route.cumulative.findIndex((value) => value >= target);
  if (high <= 0) high = 1;
  const low = high - 1;
  const segment = route.cumulative[high] - route.cumulative[low] || 1;
  const ratio = (target - route.cumulative[low]) / segment;
  return {
    lat: route.points[low].lat + (route.points[high].lat - route.points[low].lat) * ratio,
    lng: route.points[low].lng + (route.points[high].lng - route.points[low].lng) * ratio,
  };
}

function haversine(a, b) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function deterministicFraction(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function parseDuration(value) {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error('DURATION must use s, m, or h, for example 5m');
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

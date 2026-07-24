import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL || 'https://apiv2.dashlytrack.cloud';
const eventId = required('EVENT_ID');
const spectators = numberEnv('SPECTATORS', 50);
const operators = numberEnv('OPERATORS', 5);
const duration = __ENV.DURATION || '5m';
const staffToken = __ENV.STAFF_ACCESS_TOKEN;

const publicEventDuration = new Trend('public_event_duration', true);
const participantsDuration = new Trend('participants_duration', true);
const liveDuration = new Trend('live_positions_duration', true);
const historyDuration = new Trend('path_history_duration', true);
const operatorDuration = new Trend('operator_duration', true);

if (__ENV.CONFIRM_PRODUCTION_LOAD !== 'YES') {
  throw new Error('Set CONFIRM_PRODUCTION_LOAD=YES to confirm intentional load generation');
}
if (operators > 0 && !staffToken) {
  throw new Error('STAFF_ACCESS_TOKEN is required when OPERATORS > 0');
}

const scenarios = {};
if (spectators > 0) {
  scenarios.spectators = {
    executor: 'constant-vus',
    vus: spectators,
    duration,
    exec: 'spectator',
    gracefulStop: '10s',
  };
}
if (operators > 0) {
  scenarios.operators = {
    executor: 'constant-vus',
    vus: operators,
    duration,
    exec: 'operator',
    gracefulStop: '10s',
    startTime: '5s',
  };
}
if (Object.keys(scenarios).length === 0) throw new Error('At least one scenario must have users');

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    public_event_duration: ['p(95)<1000'],
    participants_duration: ['p(95)<1500'],
    live_positions_duration: ['p(95)<1000'],
    path_history_duration: ['p(95)<3000'],
    operator_duration: ['p(95)<1500'],
  },
};

export function spectator() {
  const event = get(`/public-events/${eventId}`, 'public-event', publicEventDuration);
  check(event, { 'public event 200': (r) => r.status === 200 && r.json('success') === true });

  sleep(randomBetween(1, 3));

  const participants = get(
    `/public-events/${eventId}/participants`,
    'public-participants',
    participantsDuration,
  );
  check(participants, { 'public participants 200': (r) => r.status === 200 });

  const live = get(`/public-events/${eventId}/live`, 'public-live', liveDuration);
  check(live, { 'public live 200': (r) => r.status === 200 });

  if (__ITER === 0) {
    const history = get(
      `/public-events/${eventId}/path-history`,
      'public-path-history',
      historyDuration,
      '30s',
    );
    check(history, { 'path history 200': (r) => r.status === 200 });
  }

  sleep(randomBetween(15, 30));
}

export function operator() {
  const params = {
    headers: { Authorization: `Bearer ${staffToken}` },
    tags: { persona: 'operator' },
    timeout: '15s',
  };

  const responses = http.batch([
    ['GET', `${baseUrl}/events/${eventId}`, null, endpointParams(params, 'operator-event')],
    [
      'GET',
      `${baseUrl}/events/${eventId}/participants`,
      null,
      endpointParams(params, 'operator-participants'),
    ],
    ['GET', `${baseUrl}/events/${eventId}/live`, null, endpointParams(params, 'operator-live')],
  ]);

  for (const response of responses) operatorDuration.add(response.timings.duration);
  check(responses, {
    'operator endpoints 200': (items) => items.every((response) => response.status === 200),
  });

  sleep(randomBetween(10, 20));
}

function get(path, endpoint, metric, timeout = '15s') {
  const response = http.get(`${baseUrl}${path}`, {
    tags: { endpoint, persona: 'spectator' },
    timeout,
  });
  metric.add(response.timings.duration);
  return response;
}

function endpointParams(params, endpoint) {
  return { ...params, headers: { ...params.headers }, tags: { ...params.tags, endpoint } };
}

function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

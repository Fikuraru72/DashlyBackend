import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const uploadDuration = new Trend('osrm_upload_gpx_duration');
const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const email = __ENV.ADMIN_EMAIL || 'admin@dashly.com';
const password = __ENV.ADMIN_PASSWORD || 'password123';
const expectOsrm = (__ENV.EXPECT_OSRM || 'true') === 'true';

export const options = {
  scenarios: {
    osrm_upload_gpx: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 5),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<3000'],
    osrm_upload_gpx_duration: ['p(95)<3000'],
  },
};

const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="dashly-k6">
  <trk><name>cycling-osrm-e2e</name><trkseg>
    <trkpt lat="-7.2575" lon="112.7521"></trkpt>
    <trkpt lat="-7.2600" lon="112.7550"></trkpt>
    <trkpt lat="-7.2650" lon="112.7600"></trkpt>
    <trkpt lat="-7.2700" lon="112.7650"></trkpt>
  </trkseg></trk>
</gpx>`;

export function setup() {
  const login = http.post(
    `${baseUrl}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  check(login, {
    'login 200/201': (res) => res.status === 200 || res.status === 201,
    'token exists': (res) => Boolean(res.json('data.accessToken') || res.json('accessToken')),
  });

  return {
    token: login.json('data.accessToken') || login.json('accessToken'),
  };
}

export default function (data) {
  const res = http.post(
    `${baseUrl}/events/upload-gpx`,
    { file: http.file(gpx, 'cycling-osrm-e2e.gpx', 'application/gpx+xml') },
    { headers: { Authorization: `Bearer ${data.token}` } },
  );

  uploadDuration.add(res.timings.duration);

  check(res, {
    'upload 200/201': (r) => r.status === 200 || r.status === 201,
    'has linestring': (r) => r.json('data.geoJson.geometry.type') === 'LineString',
    'has distance': (r) => Number(r.json('data.totalDistanceMeters')) > 0,
    'osrm source when expected': (r) =>
      !expectOsrm || r.json('data.geoJson.properties.source') === 'osrm',
  });

  sleep(1);
}

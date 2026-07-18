import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.OSRM_URL || 'http://127.0.0.1:5001';
const routes = [
  '112.7508,-7.2575;112.7525,-7.2590',
  '112.6304,-7.9666;112.6388,-7.9772',
  '114.3691,-8.2192;114.3748,-8.2115',
  '113.5682,-7.0498;113.5728,-7.0440',
];

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 600,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '45s', target: 50 },
        { duration: '45s', target: 100 },
        { duration: '45s', target: 200 },
        { duration: '45s', target: 350 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '20s' }],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const route = routes[(__VU + __ITER) % routes.length];
  const response = http.get(
    `${baseUrl}/route/v1/bicycle/${route}?overview=false&steps=false&alternatives=false`,
    { tags: { endpoint: 'osrm-route' }, timeout: '10s' },
  );

  check(response, {
    'route status 200': (r) => r.status === 200,
    'route code Ok': (r) => r.status === 200 && r.json('code') === 'Ok',
  });
  sleep(0.02);
}

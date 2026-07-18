# Manual race load test

Nothing here runs automatically. Use only with a dedicated `LIVE` test event and test participants.

## What it simulates

- `http-stress.js`: spectators browsing event/participants/live/path history, plus authenticated operators loading event/participants/live.
- `race-simulator.cjs`: one MQTT connection per participant, GPS points moving along the event route, 3% offline/recovery batches, one SOS, and authenticated Socket.IO operator clients measuring GPS-to-dashboard latency.
- `osrm-stress.js`: isolated OSRM capacity test; not part of the real-world race runner.

## Prepare automatically

Obtain a `SUPER_ADMIN` or authorized staff access token. Access tokens expire after 15 minutes, so obtain it immediately before preparation/test.

```bash
curl -sS https://apiv2.dashlytrack.cloud/auth/login \
  -H 'content-type: application/json' \
  --data '{"email":"staff@example.com","password":"..."}'
```

Do not store credentials or tokens in repository files.

Run preparation. It creates one dedicated East Java event, N participant accounts, registers them, sets the event `LIVE`, and writes ignored local files `k6/participants.json` and `k6/prepared.json`:

```bash
STAFF_ACCESS_TOKEN='...' PARTICIPANTS=100 node k6/prepare.cjs
```

Type `YES` when prompted. For non-interactive preparation, explicitly add `CONFIRM_PREPARATION=YES`.

Preparation intentionally does not delete existing accounts or events. Every run creates a uniquely named test dataset. Delete the event through the dashboard after testing.

## Run manually

Small smoke load:

```bash
STAFF_ACCESS_TOKEN='...' \
CONFIRM_PRODUCTION_LOAD=YES \
DURATION=2m PARTICIPANT_LIMIT=10 SPECTATORS=10 OPERATORS=2 SOCKET_CLIENTS=2 \
./k6/run-manual.sh all
```

Expected race load example:

```bash
STAFF_ACCESS_TOKEN='...' \
CONFIRM_PRODUCTION_LOAD=YES \
DURATION=30m PARTICIPANT_LIMIT=100 SPECTATORS=500 OPERATORS=20 SOCKET_CLIENTS=20 \
UPDATE_INTERVAL_MS=1000 DRAIN_DURATION=60s \
./k6/run-manual.sh all
```

Run components independently:

```bash
./k6/run-manual.sh http
./k6/run-manual.sh race
```

Every command still requires the environment variables shown above.

## Recommended sequence

1. `PARTICIPANT_LIMIT=10`, `10` spectators, `2` sockets, `2m`.
2. Repeat with `PARTICIPANT_LIMIT=25`, `50`, `75`, then `100` against the same prepared dataset.
3. Expected participant count, `30m`.
4. Stop if error rate exceeds 1%, queue lag keeps growing, containers restart, or host memory becomes unsafe.
4. Run expected load for the real race duration only after short stages recover cleanly.

## Read the results

HTTP pass targets:

- failures `< 1%`
- public event/live p95 `< 1s`
- participant/operator p95 `< 1.5s`
- path history p95 `< 3s`

Race summary fields:

- `published`: MQTT publishes acknowledged by the local client.
- `publishErrors`: local MQTT publish errors.
- `socketPositions`: position updates received by all simulated operator sockets.
- `e2eLatencyMs`: `captured_at` on the GPS payload to Socket.IO reception. Primary race metric; target p95 under 3 seconds.
- `syncPoints`: buffered points sent after the simulated offline window.
- `passed`: automatic race verdict; requires publishes, all requested sockets connected, zero MQTT/socket errors, at least 90% of expected socket deliveries, and E2E p95 below `MAX_E2E_P95_MS` (default 3000).
- `DRAIN_DURATION`: observation window after GPS publishing stops; confirms whether queued work catches up instead of hiding backlog at test shutdown.

`socketPositions` scales with socket client count. With 5 operator sockets, one backend position can produce 5 received samples.

## Important limitations

- `prepare.cjs` provisions users/events through public APIs but does not clean database rows.
- The race simulator models authenticated operator sockets. Anonymous public sockets use a separate public room and should be smoke-tested from `/live/:eventId`.
- MQTT is reached through a temporary loopback-only SSH tunnel; it is not exposed publicly.
- `qos: 0` matches the current simplest ingest path. Change only if the mobile client contract uses another QoS.
- Running from one laptop can become the bottleneck at high client counts. Watch laptop CPU/network alongside the VPS.

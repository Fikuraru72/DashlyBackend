#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const readline = require('node:readline/promises');

const apiUrl = process.env.API_URL || 'https://apiv2.dashlytrack.cloud';
const token = required('STAFF_ACCESS_TOKEN');
const participantCount = positiveInteger('PARTICIPANTS', 10);
const participantsPath = process.env.PARTICIPANTS_FILE || 'k6/participants.json';
const metadataPath = process.env.PREPARED_FILE || 'k6/prepared.json';

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  await confirm();

  const suffix = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const password = `Dashly-k6-${suffix}!`;
  const now = Date.now();
  const event = await request('/events', {
    method: 'POST',
    auth: true,
    body: {
      name: `K6 East Java Race ${suffix}`,
      description: 'Automated dedicated load-test event. Safe to delete after testing.',
      category: 'CYCLING',
      maxParticipants: participantCount,
      dateEvent: new Date(now).toISOString(),
      startTime: new Date(now - 5 * 60_000).toISOString(),
      endTime: new Date(now + 6 * 60 * 60_000).toISOString(),
      monitoringStartOffset: 60,
      monitoringEndOffset: 60,
      registrationOpen: new Date(now - 60 * 60_000).toISOString(),
      registrationClose: new Date(now + 60 * 60_000).toISOString(),
      locationName: 'Surabaya K6 Route',
      city: 'Surabaya',
      province: 'East Java',
      latitude: -7.2575,
      longitude: 112.7508,
      routeGeojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'K6 bicycle route' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [112.7508, -7.2575],
                [112.7525, -7.259],
                [112.7548, -7.261],
                [112.757, -7.263],
                [112.7592, -7.265],
              ],
            },
          },
        ],
      },
    },
  });

  const eventId = event?.data?.id;
  if (!Number.isInteger(eventId)) throw new Error('Create event response did not contain data.id');
  console.log(`Created event ${eventId}`);

  for (let index = 1; index <= participantCount; index += 1) {
    const email = `k6.${suffix}.${String(index).padStart(4, '0')}@example.invalid`;
    await request(`/public-events/${eventId}/register`, {
      method: 'POST',
      body: {
        name: `K6 Rider ${String(index).padStart(4, '0')}`,
        email,
        phone: `0800${String(index).padStart(7, '0')}`,
        password,
      },
    });
    process.stdout.write(`\rRegistered participants: ${index}/${participantCount}`);
  }
  process.stdout.write('\n');

  const participantResponse = await request(`/events/${eventId}/participants`, { auth: true });
  const generatedPrefix = `k6.${suffix}.`;
  const participants = (participantResponse?.data || [])
    .filter((participant) => participant.email?.startsWith(generatedPrefix))
    .map((participant) => ({ userId: participant.id }))
    .sort((a, b) => a.userId - b.userId);

  if (participants.length !== participantCount) {
    throw new Error(
      `Expected ${participantCount} participants, API returned ${participants.length}`,
    );
  }

  for (let index = 0; index < participants.length; index += 1) {
    await request(`/events/${eventId}/participants/${participants[index].userId}/state`, {
      method: 'PUT',
      auth: true,
      body: { state: 'TRACKING' },
    });
    process.stdout.write(`\rActivated participants: ${index + 1}/${participants.length}`);
  }
  process.stdout.write('\n');

  await request(`/events/${eventId}/status`, {
    method: 'PUT',
    auth: true,
    body: { status: 'LIVE' },
  });

  fs.mkdirSync(require('node:path').dirname(participantsPath), { recursive: true });
  fs.writeFileSync(participantsPath, `${JSON.stringify(participants, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        eventId,
        eventName: event.data.name,
        participantCount,
        createdAt: new Date().toISOString(),
        participantsFile: participantsPath,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  console.log(`Event ${eventId} is LIVE`);
  console.log(`Participants: ${participantsPath}`);
  console.log(`Metadata: ${metadataPath}`);
  console.log('\nRun manually:');
  console.log(`STAFF_ACCESS_TOKEN='...' CONFIRM_PRODUCTION_LOAD=YES ./k6/run-manual.sh all`);
}

async function request(path, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.body) headers['content-type'] = 'application/json';
  if (options.auth) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(
      `${options.method || 'GET'} ${path} failed: HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function confirm() {
  if (process.env.CONFIRM_PREPARATION === 'YES') return;
  if (!process.stdin.isTTY) {
    throw new Error('Set CONFIRM_PREPARATION=YES when running without an interactive terminal');
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(
    `Create one LIVE event and ${participantCount} participant accounts on ${apiUrl}? Type YES: `,
  );
  prompt.close();
  if (answer !== 'YES') throw new Error('Preparation cancelled');
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

/**
 * ═══════════════════════════════════════════════════════════════
 * Dashly Phase 7 — Standalone MQTT Broker (Aedes)
 * ═══════════════════════════════════════════════════════════════
 * TCP  → 0.0.0.0:1883  (Mobile app connects here via raw MQTT)
 * WS   → 0.0.0.0:8888  (Web dashboard connects here via WebSocket)
 *
 * Run:  node broker.js
 * ═══════════════════════════════════════════════════════════════
 */

const { Aedes } = require('aedes');
const net = require('net');
const http = require('http');
const ws = require('websocket-stream');

const MQTT_PORT = 1883;
const WS_PORT = 8888;

// ── Create Broker Instance (Node 20+ compatible) ────────────
const broker = new Aedes();

// ── 1. TCP Server — for Flutter Mobile (mqtt_client) ────────
const tcpServer = net.createServer(broker.handle);
tcpServer.listen(MQTT_PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  🟢 MQTT TCP  listening on 0.0.0.0:${MQTT_PORT}     ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
});

// ── 2. WebSocket Server — for Web Dashboard (mqtt.js) ───────
const httpServer = http.createServer();
ws.createServer({ server: httpServer }, broker.handle);
httpServer.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  🔵 MQTT WS   listening on 0.0.0.0:${WS_PORT}     ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
});

// ── 3. Event Logging ────────────────────────────────────────
broker.on('client', (client) => {
  console.log(`[Broker] ✅ Client Connected: ${client ? client.id : 'unknown'}`);
});

broker.on('clientDisconnect', (client) => {
  console.log(`[Broker] ❌ Client Disconnected: ${client ? client.id : 'unknown'}`);
});

broker.on('subscribe', (subscriptions, client) => {
  console.log(
    `[Broker] 📡 Client ${client ? client.id : 'unknown'} subscribed to:`,
    subscriptions.map((s) => s.topic)
  );
});

// ── 4. Intercept dashly/location messages ───────────────────
broker.on('publish', (packet, client) => {
  // Ignore internal / system topics ($SYS, etc.)
  if (!client) return;

  if (packet.topic === 'dashly/location') {
    try {
      const data = JSON.parse(packet.payload.toString());
      console.log(
        `[Broker] 📍 Location Received from ${client.id}:`,
        `lat=${data.lat}, lng=${data.lng}`
      );
    } catch {
      console.log(
        `[Broker] 📍 Raw payload on dashly/location:`,
        packet.payload.toString()
      );
    }
  } else {
    // Log any other topic for debugging
    console.log(
      `[Broker] 📩 Message on [${packet.topic}] from ${client.id}:`,
      packet.payload.toString().substring(0, 120)
    );
  }
});
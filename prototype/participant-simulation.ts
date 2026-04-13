import axios from 'axios';
import * as mqtt from 'mqtt';

const API_URL = 'http://localhost:3001';
const MQTT_URL = 'mqtt://localhost:1883'; // Configured in .env

// Mock Route -> User moving slightly
const MOCK_GPS_ROUTE = [
    { lat: -6.1744, lng: 106.8227 },
    { lat: -6.1746, lng: 106.8230 },
    { lat: -6.1748, lng: 106.8234 },
    { lat: -6.1750, lng: 106.8239 },
    { lat: -6.1753, lng: 106.8245 },
    { lat: -6.1757, lng: 106.8252 },
    { lat: -6.1762, lng: 106.8260 },
    // Anomaly test: Speed > 45km/h
    { lat: -6.1770, lng: 106.8270, speed: 50 },
];

// Helper sleep function to stagger logins
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function simulateRunner(runnerIndex: number, eventId: number) {
    const email = `runner${runnerIndex}@dashly.com`;
    console.log(`🏃 Starting simulation for ${email}...`);

    // 1. Login as PARTICIPANT
    let token = '';
    let userId = null;
    try {
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email,
            password: 'password123'
        });
        token = loginRes.data.accessToken;

        const payloadBase64 = token.split('.')[1];
        const payloadStr = Buffer.from(payloadBase64, 'base64').toString();
        const payloadObj = JSON.parse(payloadStr);
        userId = payloadObj.sub;

        console.log(`✅ ${email} logged in successfully. (ID: ${userId})`);
    } catch (error: any) {
        console.error(`❌ ${email} login failed:`, error.response?.data || error.message);
        return;
    }

    // 2. Connect to MQTT Broker
    const client = mqtt.connect(MQTT_URL);

    client.on('connect', () => {
        // 3. Start blasting mock locations
        const topic = `dashly/events/${eventId}/p/${userId}/loc`;
        console.log(`🚀 ${email} connected to MQTT. Publishing to: ${topic}`);

        let step = 0;

        // Add artificial jitter per runner so they don't jump simultaneously
        const intervalMs = 2500 + Math.random() * 1000;

        const interval = setInterval(() => {
            if (step >= MOCK_GPS_ROUTE.length) {
                console.log(`🛑 ${email} reached end of route.`);
                clearInterval(interval);
                client.end();
                return;
            }

            // slightly randomize the path points so they aren't completely on top of each other
            const basePoint = MOCK_GPS_ROUTE[step];
            const latOffset = (Math.random() - 0.5) * 0.0002;
            const lngOffset = (Math.random() - 0.5) * 0.0002;

            const payload = {
                lat: (basePoint.lat + latOffset).toString(),
                lng: (basePoint.lng + lngOffset).toString(),
                speed: (basePoint.speed || 12) + (Math.random() * 2 - 1),
                battery: 89 - step,
                isOffline: false,
                captured_at: new Date().toISOString()
            };

            client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
                if (err) {
                    console.error(`❌ ${email} Failed to publish:`, err);
                } else {
                    console.log(`📡 Ping [${email}] -> Lat ${payload.lat}, Lng ${payload.lng}`);
                }
            });

            step++;
        }, intervalMs);
    });

    client.on('error', (err) => {
        console.error(`❌ MQTT Error for ${email}:`, err);
    });
}


async function runParticipantSimulation() {
    console.log('🏃 Starting Multi-Participant Simulation (10 Runners)...');

    // For simplicity, just grab the event ID once as a generic anonymous request isn't allowed
    // and we know it's always ID 1 from the seeder, but let's fetch it via admin just to be sure.
    let eventId = 1;
    try {
        console.log('🔍 Locating Event ID...');
        const adminRes = await axios.post(`${API_URL}/auth/login`, { email: 'admin@dashly.com', password: 'password123' });
        const eventsRes = await axios.get(`${API_URL}/events`, { headers: { Authorization: `Bearer ${adminRes.data.accessToken}` } });
        const targetEvent = eventsRes.data.find((e: any) => e.name === 'Dashly MVP Beta Run');
        eventId = targetEvent.id;
        console.log(`🎯 Target Event ID: ${eventId}`);
    } catch (e) {
        console.warn('⚠️ Could not fetch event dynamically, defaulting to Event ID 1');
    }

    // Launch simulations for all 10 runners sequentially with a small delay
    for (let i = 1; i <= 10; i++) {
        simulateRunner(i, eventId);
        await sleep(500); // Stagger the logins so NestJS isn't slammed instantly
    }
}

async function runContinuousSimulation() {
    while (true) {
        await runParticipantSimulation();
        console.log('🏁 Simulation round finished. Restarting in 10 seconds...');
        await sleep(10000);
    }
}

runContinuousSimulation();

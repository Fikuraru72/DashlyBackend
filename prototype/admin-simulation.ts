import axios from 'axios';
import { io } from 'socket.io-client';

const API_URL = 'http://localhost:3001';
const MQTT_URL = 'mqtt://localhost:1883'; // Based on docker-compose running on port 3000. 
// Socket.io often binds to the same port.
const SOCKET_URL = 'http://localhost:3000';

async function runAdminSimulation() {
    console.log('🔄 Starting Admin Simulation (Dashboard MVP)...');

    // 1. Login as SUPER_ADMIN
    let token = '';
    try {
        const loginRes = await axios.post(`${API_URL}/auth/login`, {
            email: 'admin@dashly.com',
            password: 'password123'
        });
        token = loginRes.data.accessToken;
        console.log('✅ Logged in as Admin successfully.');
    } catch (error: any) {
        console.error('❌ Admin login failed:', error.response?.data || error.message);
        process.exit(1);
    }

    // 2. Fetch the "Dashly MVP Beta Run" Event
    let eventId = null;
    try {
        const eventsRes = await axios.get(`${API_URL}/events`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const events = eventsRes.data;
        const targetEvent = events.find((e: any) => e.name === 'Dashly MVP Beta Run');

        if (!targetEvent) {
            console.error('❌ Dashly MVP Beta Run event not found. Did you run the prototype seeder?');
            process.exit(1);
        }
        eventId = targetEvent.id;
        console.log(`✅ Found Target Event ID: ${eventId} (${targetEvent.name})`);
    } catch (error: any) {
        console.error('❌ Failed to fetch events:', error.response?.data || error.message);
        process.exit(1);
    }

    // 3. Connect to WebSocket
    console.log('🔌 Connecting to WebSocket Server...');
    const socket = io(SOCKET_URL);

    socket.on('connect', () => {
        console.log(`✅ Connected to WebSocket (ID: ${socket.id})`);

        // 4. Join Event Room
        socket.emit('joinEventRoom', { eventId });
        console.log(`🚪 Joining WebSocket room for Event ${eventId}...`);
    });

    // 5. Listen for Live Location Updates
    socket.on('position_update', (data) => {
        console.log(`📍 [LIVE UPDATE] User ${data.userId}: Lat ${data.lat}, Lng ${data.lng} | Speed: ${data.speed}km/h | Volts: ${data.battery}%`);
    });

    // Listen for anomalies
    socket.on('anomalyDetected', (data) => {
        console.log(`⚠️ [ANOMALY] User ${data.userId} -> ${data.type}: ${data.reason}`);
    });

    socket.on('joinedRoom', (data) => {
        console.log(`✅ Server confirmed joined room: ${data}`);
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnected from WebSocket');
    });

    socket.on('connect_error', (err) => {
        console.log(`❌ Connection Error: ${err.message}`);
    });

    // Keep process alive indefinitely
    console.log('⏳ Admin listener is active. Waiting for participants to publish data...\n');
    setInterval(() => { }, 1000 * 60 * 60); // 1 hour
}

runAdminSimulation();

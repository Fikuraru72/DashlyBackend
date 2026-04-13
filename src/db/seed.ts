import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';
dotenv.config();

// Utility for generating tokens
const generateToken = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Valid GeoJSON LineString for mock
const getMockRoute = () => ({
  type: "LineString",
  coordinates: [
    [106.8227, -6.1744],
    [106.8247, -6.1764],
    [106.8267, -6.1784],
    [106.8287, -6.1804]
  ]
});

async function seed() {
    console.log('Seeding Database with Hybrid Professional Race Management Data...');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });
    const db = drizzle(pool, { schema });

    try {
        // --- 1. ROLES ---
        console.log('--- Seeding Roles ---');
        const rolesToSeed = ['SUPER_ADMIN', 'STAFF', 'PARTICIPANT'];
        const roleMap: Record<string, number> = {};

        for (const roleName of rolesToSeed) {
            let role = await db.query.roles.findFirst({
                where: eq(schema.roles.name, roleName),
            });

            if (!role) {
                const [insertedRole] = await db.insert(schema.roles).values({ name: roleName, permissions: [] }).returning();
                role = insertedRole;
                console.log(`Created role: ${roleName}`);
            }
            roleMap[roleName] = role.id;
        }

        // --- 2. USERS ---
        console.log('--- Seeding Users ---');
        const passwordHash = await bcrypt.hash('password123', 10);
        
        const usersToSeed = [
            { email: 'admin@dashly.com', name: 'Super Admin User', roleName: 'SUPER_ADMIN' },
            { email: 'participant1@dashly.com', name: 'Runner One', roleName: 'PARTICIPANT' },
            { email: 'participant2@dashly.com', name: 'Runner Two', roleName: 'PARTICIPANT' },
            { email: 'participant3@dashly.com', name: 'Runner Three', roleName: 'PARTICIPANT' },
            { email: 'participant4@dashly.com', name: 'Runner Four', roleName: 'PARTICIPANT' },
            { email: 'participant5@dashly.com', name: 'Runner Five', roleName: 'PARTICIPANT' },
        ];

        const userMap: Record<string, number> = {};
        for (const userData of usersToSeed) {
            let user = await db.query.users.findFirst({
                where: eq(schema.users.email, userData.email),
            });

            if (!user) {
                const [insertedUser] = await db.insert(schema.users).values({
                    email: userData.email,
                    password: passwordHash,
                    name: userData.name,
                    roleId: roleMap[userData.roleName],
                }).returning();
                user = insertedUser;
                console.log(`Created user: ${userData.email}`);
            }
            userMap[userData.email] = user.id;
        }

        // --- 3. EVENTS (Double-Lock Scenarios) ---
        console.log('--- Seeding Events ---');
        const now = new Date();

        // Event A: Upcoming Running (IDLE) - startTime 2 hours from now
        const eventAStartTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
        const eventAEndTime = new Date(eventAStartTime.getTime() + 4 * 60 * 60 * 1000);
        
        // Event B: Live Cycling (START) - startTime 30 mins ago, endTime 2 hours from now
        const eventBStartTime = new Date(now.getTime() - 30 * 60 * 1000);
        const eventBEndTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);

        // Event C: Finished Running (FINISHED) - startTime yesterday
        const eventCStartTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const eventCEndTime = new Date(eventCStartTime.getTime() + 4 * 60 * 60 * 1000);

        const eventsToSeed = [
            {
                name: 'Dashly City Run (Upcoming)',
                description: 'A future running event testing the countdown UI.',
                category: 'RUNNING' as const,
                status: 'IDLE' as const,
                token: 'UPRN26',
                maxParticipants: 100,
                routeGeojson: getMockRoute(),
                startTime: eventAStartTime,
                endTime: eventAEndTime,
                monitoringStartOffset: 60,
                monitoringEndOffset: 240,
                currentCount: 0,
            },
            {
                name: 'Dashly Pro Cycling (Live)',
                description: 'An ongoing cycling event testing real-time ingestion.',
                category: 'CYCLING' as const,
                status: 'START' as const,
                token: 'LVCY26',
                maxParticipants: 50,
                routeGeojson: getMockRoute(),
                startTime: eventBStartTime,
                endTime: eventBEndTime,
                monitoringStartOffset: 60,
                monitoringEndOffset: 240,
                currentCount: 0,
            },
            {
                name: 'Dashly Classic Run (Finished)',
                description: 'A completed running event for history logs.',
                category: 'RUNNING' as const,
                status: 'FINISHED' as const,
                token: 'FNRN25',
                maxParticipants: 200,
                routeGeojson: getMockRoute(),
                startTime: eventCStartTime,
                endTime: eventCEndTime,
                monitoringStartOffset: 60,
                monitoringEndOffset: 240,
                currentCount: 0,
            }
        ];

        const eventMap: Record<string, number> = {};

        for (const evtData of eventsToSeed) {
            let event = await db.query.events.findFirst({
                where: eq(schema.events.name, evtData.name),
            });

            if (!event) {
                const [insertedEvent] = await db.insert(schema.events).values(evtData).returning();
                event = insertedEvent;
                console.log(`Created event: ${evtData.name}`);
            }
            eventMap[evtData.name] = event.id;
        }

        // --- 4. TOKENS & PARTICIPANTS ---
        console.log('--- Seeding Tokens & Participants ---');
        const participantEmails = usersToSeed.filter(u => u.roleName === 'PARTICIPANT').map(u => u.email);

        for (const evtData of eventsToSeed) {
            const eventId = eventMap[evtData.name];
            
            let usedCount = 0;
            // Generate 5 tokens for each event
            for (let i = 0; i < 5; i++) {
                const tokenCode = generateToken();
                // Link first 2 tokens to participants
                if (i < 2) {
                    const userId = userMap[participantEmails[i]];
                    await db.insert(schema.tokens).values({
                        code: tokenCode,
                        eventId: eventId,
                        userId: userId,
                        status: 'USED',
                    });

                    // Add to event_participants if they don't exist
                    const existingParticipant = await db.query.eventParticipants.findFirst({
                        where: (ep, { and, eq }) => and(eq(ep.eventId, eventId), eq(ep.userId, userId))
                    });

                    if (!existingParticipant) {
                        await db.insert(schema.eventParticipants).values({
                            eventId: eventId,
                            userId: userId,
                        });
                        usedCount++;
                    }
                } else {
                    await db.insert(schema.tokens).values({
                        code: tokenCode,
                        eventId: eventId,
                        status: 'AVAILABLE',
                    });
                }
            }
            
            // Update current participant count
            if (usedCount > 0) {
                await db.update(schema.events)
                    .set({ currentCount: usedCount })
                    .where(eq(schema.events.id, eventId));
            }
            
            console.log(`Generated 5 tokens for ${evtData.name}`);
        }

        // --- 5. LOCATION LOGS (For Live Cycling Event) ---
        const liveEventName = 'Dashly Pro Cycling (Live)';
        const liveEventId = eventMap[liveEventName];
        const activeUserId = userMap['participant1@dashly.com'];

        // Check if logs already exist for this user in this event
        const existingLogs = await db.query.locationLogs.findMany({
            where: (ll, { and, eq }) => and(eq(ll.eventId, liveEventId), eq(ll.userId, activeUserId)),
            limit: 1
        });

        if (existingLogs.length === 0) {
            console.log(`--- Seeding Location Logs for ${liveEventName} ---`);
            let lat = -6.1744;
            let lng = 106.8227;
            const mockLogs = Array.from({ length: 15 }).map((_, i) => {
                lat -= 0.0002;
                lng += 0.0002;
                return {
                    userId: activeUserId,
                    eventId: liveEventId,
                    latitude: lat,
                    longitude: lng,
                    speed: 25.5 + (Math.random() * 5),
                    isOffline: false,
                    timestamp: new Date(Date.now() - (15 - i) * 2000)
                };
            });

            await db.insert(schema.locationLogs).values(mockLogs);
            console.log(`Created 15 mock location logs for user ${activeUserId} in event ${liveEventId}`);
        } else {
            console.log('Location logs already exist, skipping...');
        }

        console.log('Seeding completed successfully! 🚀');
    } catch (error) {
        console.error('Seeding failed:', error);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

seed();

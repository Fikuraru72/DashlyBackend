import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import * as dotenv from 'dotenv';
dotenv.config();

// Utility for generating tokens
const generateToken = () =>
  Math.random().toString(36).substring(2, 8).toUpperCase();

// Valid GeoJSON LineString for mock
const getMockRoute = () => ({
  type: 'LineString',
  coordinates: [
    [106.8227, -6.1744],
    [106.8247, -6.1764],
    [106.8267, -6.1784],
    [106.8287, -6.1804],
  ],
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
    const rolesToSeed = [
      { name: 'SUPER_ADMIN', permissions: ['manage_users', 'view_stats'] },
      { name: 'STAFF', permissions: ['manage_users', 'view_stats'] },
      { name: 'PARTICIPANT', permissions: [] },
    ];
    const roleMap: Record<string, number> = {};

    for (const roleData of rolesToSeed) {
      let role = await db.query.roles.findFirst({
        where: eq(schema.roles.name, roleData.name),
      });

      if (!role) {
        const [insertedRole] = await db
          .insert(schema.roles)
          .values({ name: roleData.name, permissions: roleData.permissions })
          .returning();
        role = insertedRole;
        console.log(`Created role: ${roleData.name}`);
      }
      roleMap[roleData.name] = role.id;
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
        const [insertedUser] = await db
          .insert(schema.users)
          .values({
            email: userData.email,
            password: passwordHash,
            name: userData.name,
            roleId: roleMap[userData.roleName],
          })
          .returning();
        user = insertedUser;
        console.log(`Created user: ${userData.email}`);
      }
      userMap[userData.email] = user.id;
    }

    // --- 3. EVENTS (Double-Lock Scenarios) ---
    console.log('--- Seeding Events ---');
    const now = new Date();

    const eventAStartTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const eventAEndTime = new Date(eventAStartTime.getTime() + 4 * 60 * 60 * 1000);

    const eventBStartTime = new Date(now.getTime() - 30 * 60 * 1000);
    const eventBEndTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);

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
        registrationOpen: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        registrationClose: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000), // 1 day from now
        locationName: 'Gelora Bung Karno',
        city: 'Jakarta Pusat',
        province: 'DKI Jakarta',
        latitude: -6.2185,
        longitude: 106.8021,
        bannerImage: 'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?w=800&q=80',
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
        registrationOpen: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        registrationClose: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
        locationName: 'Monumen Nasional',
        city: 'Jakarta',
        province: 'DKI Jakarta',
        latitude: -6.1754,
        longitude: 106.8272,
        bannerImage: 'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=800&q=80',
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
        registrationOpen: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
        registrationClose: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
        locationName: 'Taman Mini Indonesia Indah',
        city: 'Jakarta Timur',
        province: 'DKI Jakarta',
        latitude: -6.3024,
        longitude: 106.8951,
        bannerImage: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&q=80',
        monitoringStartOffset: 60,
        monitoringEndOffset: 240,
        currentCount: 0,
      },
      {
        name: 'Dashly Marathon Open',
        description: 'Registration is currently open! Join the marathon today.',
        category: 'RUNNING' as const,
        status: 'REGISTRATION_OPEN' as const,
        token: 'MTHN26',
        maxParticipants: 500,
        routeGeojson: getMockRoute(),
        startTime: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
        endTime: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000),
        registrationOpen: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        registrationClose: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000), // 5 days left
        locationName: 'Bundaran HI',
        city: 'Jakarta',
        province: 'DKI Jakarta',
        latitude: -6.1950,
        longitude: 106.8230,
        bannerImage: 'https://images.unsplash.com/photo-1541252874136-1e96e70a241e?w=800&q=80',
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
        const [insertedEvent] = await db
          .insert(schema.events)
          .values(evtData)
          .returning();
        event = insertedEvent;
        console.log(`Created event: ${evtData.name}`);
      }
      eventMap[evtData.name] = event.id;
    }

    // --- 4. TOKENS & PARTICIPANTS ---
    console.log('--- Seeding Tokens & Participants ---');
    const participantEmails = usersToSeed
      .filter((u) => u.roleName === 'PARTICIPANT')
      .map((u) => u.email);

    for (const evtData of eventsToSeed) {
      const eventId = eventMap[evtData.name];

      let usedCount = 0;
      for (let i = 0; i < 5; i++) {
        const tokenCode = generateToken();
        if (i < 2) {
          const userId = userMap[participantEmails[i]];
          await db.insert(schema.tokens).values({
            code: tokenCode,
            eventId: eventId,
            userId: userId,
            status: 'USED',
          });

          const existingParticipant = await db.query.eventParticipants.findFirst({
            where: (ep, { and, eq }) =>
              and(eq(ep.eventId, eventId), eq(ep.userId, userId)),
          });

          if (!existingParticipant) {
            const bibNumber = String(usedCount + 1).padStart(4, '0');
            const participantNumber = `PN-${eventId}-${userId}`;

            await db.insert(schema.eventParticipants).values({
              eventId: eventId,
              userId: userId,
              bibNumber: bibNumber,
              participantNumber: participantNumber,
              participantState: evtData.status === 'IDLE' ? 'CONFIRMED' : 'REGISTERED',
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

      if (usedCount > 0) {
        await db
          .update(schema.events)
          .set({ currentCount: usedCount })
          .where(eq(schema.events.id, eventId));
      }

      console.log(`Generated 5 tokens for ${evtData.name}`);
    }

    // --- 5. LOCATION LOGS (For Live Cycling Event) ---
    const liveEventName = 'Dashly Pro Cycling (Live)';
    const liveEventId = eventMap[liveEventName];
    const activeUserId = userMap['participant1@dashly.com'];

    const existingLogs = await db.query.locationLogs.findMany({
      where: (ll, { and, eq }) =>
        and(eq(ll.eventId, liveEventId), eq(ll.userId, activeUserId)),
      limit: 1,
    });

    if (existingLogs.length === 0) {
      console.log(`--- Seeding Location Logs for ${liveEventName} ---`);
      let lat = -6.1744;
      let lng = 106.8227;
      const mockLogs = Array.from({ length: 15 }).map((_, i) => {
        lat -= 0.0002;
        lng += 0.0002;
        return {
          messageId: ulid(),
          userId: activeUserId,
          eventId: liveEventId,
          latitude: lat,
          longitude: lng,
          speed: 25.5 + Math.random() * 5,
          distanceDelta: 0,
          speedCalculated: 25.5,
          isAnomaly: false,
          isOffline: false,
          capturedAt: new Date(Date.now() - (15 - i) * 2000),
        };
      });

      await db.insert(schema.locationLogs).values(mockLogs);
      console.log(
        `Created 15 mock location logs for user ${activeUserId} in event ${liveEventId}`,
      );
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

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';
dotenv.config();

async function seed() {
    console.log('Seeding MVP Prototype Data...');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });
    const db = drizzle(pool, { schema });

    const rolesToSeed = ['SUPER_ADMIN', 'STAFF', 'PARTICIPANT'];
    const roleMap: Record<string, number> = {};

    // 1. Seed Roles
    for (const roleName of rolesToSeed) {
        let role = await db.query.roles.findFirst({
            where: eq(schema.roles.name, roleName),
        });

        if (!role) {
            console.log(`Creating ${roleName} role...`);
            const [insertedRole] = await db.insert(schema.roles).values({ name: roleName, permissions: [] }).returning();
            role = insertedRole;
        } else {
            console.log(`${roleName} role already exists.`);
        }
        roleMap[roleName] = role.id;
    }
    // 2. Seed Users
    const usersToSeed = [
        { email: 'admin@dashly.com', name: 'Super Admin User', roleName: 'SUPER_ADMIN', password: 'password123' },
        { email: 'staff@dashly.com', name: 'Staff User', roleName: 'STAFF', password: 'password123' },
        { email: 'participant@dashly.com', name: 'Participant User', roleName: 'PARTICIPANT', password: 'password123' },
        // Add 10 participants for prototype
        ...Array.from({ length: 10 }).map((_, i) => ({
            email: `runner${i + 1}@dashly.com`,
            name: `Runner ${i + 1}`,
            roleName: 'PARTICIPANT',
            password: 'password123'
        }))
    ];

    const userMap: Record<string, number> = {};

    for (const userData of usersToSeed) {
        let user = await db.query.users.findFirst({
            where: eq(schema.users.email, userData.email),
        });

        if (!user) {
            console.log(`Creating user: ${userData.email} (${userData.roleName})...`);
            const hashedPassword = await bcrypt.hash(userData.password, 10);
            const [insertedUser] = await db.insert(schema.users).values({
                email: userData.email,
                password: hashedPassword,
                name: userData.name,
                roleId: roleMap[userData.roleName],
            }).returning();
            user = insertedUser;
            console.log(`Created user ${userData.email} with password: ${userData.password}`);
        } else {
            console.log(`User already exists: ${userData.email}`);
            // Ensure the user has the correct role just in case
            const expectedRoleId = roleMap[userData.roleName];
            if (user.roleId !== expectedRoleId) {
                await db.update(schema.users).set({ roleId: expectedRoleId }).where(eq(schema.users.email, userData.email));
                console.log(`Updated ${userData.email} to role ${userData.roleName}`);
            }
        }
        userMap[userData.email] = user.id;
    }

    // 3. Seed Mock Event
    const eventName = 'Dashly MVP Beta Run';
    let event = await db.query.events.findFirst({
        where: eq(schema.events.name, eventName),
    });

    if (!event) {
        console.log('Creating MVP Beta Run Event...');
        // A simple route linestring (around a park for example)
        const mockRoute = {
            type: "LineString",
            coordinates: [
                [106.8227, -6.1744], // Monas start
                [106.8247, -6.1764],
                [106.8267, -6.1784],
            ]
        };

        const [insertedEvent] = await db.insert(schema.events).values({
            name: eventName,
            description: 'A simulation run for testing the Dashly MVP backend tracking pipeline.',
            status: 'ACTIVE',
            token: 'beta_run_xyz_123',
            maxParticipants: 100,
            routeGeojson: mockRoute
        }).returning();
        event = insertedEvent;
    } else {
        console.log(`Event '${eventName}' already exists.`);
    }

    // 4. Join Participants to Event
    const participantsToJoin = [
        'participant@dashly.com',
        ...Array.from({ length: 10 }).map((_, i) => `runner${i + 1}@dashly.com`)
    ];

    for (const email of participantsToJoin) {
        const userId = userMap[email];
        const existingJoin = await db.query.eventParticipants.findFirst({
            where: (ep, { and, eq }) => and(eq(ep.eventId, event!.id), eq(ep.userId, userId))
        });

        if (!existingJoin) {
            await db.insert(schema.eventParticipants).values({
                eventId: event.id,
                userId: userId,
            });
            console.log(`Participant ${email} joined event ${event.id}`);

            // increment concurrent count (simplified logic for seeder)
            await db.update(schema.events).set({ currentCount: (event.currentCount || 0) + 1 }).where(eq(schema.events.id, event.id));
        } else {
            console.log(`Participant ${email} already joined event ${event.id}`);
        }
    }

    console.log('Seeding for MVP Prototype completed successfully.');
    process.exit(0);
}

seed().catch(err => {
    console.error('Seeding MVP Prototype failed:', err);
    process.exit(1);
});

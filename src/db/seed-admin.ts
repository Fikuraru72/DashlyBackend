import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';
dotenv.config();

async function seed() {
    console.log('Seeding Database...');
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
    ];

    for (const userData of usersToSeed) {
        let user = await db.query.users.findFirst({
            where: eq(schema.users.email, userData.email),
        });

        if (!user) {
            console.log(`Creating user: ${userData.email} (${userData.roleName})...`);
            const hashedPassword = await bcrypt.hash(userData.password, 10);
            await db.insert(schema.users).values({
                email: userData.email,
                password: hashedPassword,
                name: userData.name,
                roleId: roleMap[userData.roleName],
            });
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
    }

    console.log('Seeding completed successfully.');
    process.exit(0);
}

seed().catch(err => {
    console.error('Seeding failed:', err);
    process.exit(1);
});

import { pgTable, serial, varchar, timestamp, text, integer, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const roles = pgTable('roles', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 50 }).notNull().unique(),
    permissions: text('permissions').array(),
});

export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    password: varchar('password', { length: 255 }),
    googleId: varchar('google_id', { length: 255 }).unique(),
    name: varchar('name', { length: 255 }).notNull(),
    roleId: serial('role_id').references(() => roles.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const events = pgTable('events', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: varchar('status', { length: 50 }).default('IDLE').notNull(),
    token: varchar('token', { length: 255 }).notNull().unique(),
    currentCount: integer('current_count').default(0).notNull(),
    maxParticipants: integer('max_participants').notNull(),
    routeGeojson: jsonb('route_geojson'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const locationLogs = pgTable('location_logs', {
    id: serial('id').primaryKey(),
    userId: serial('user_id').references(() => users.id),
    latitude: varchar('latitude', { length: 50 }).notNull(),
    longitude: varchar('longitude', { length: 50 }).notNull(),
    speed: varchar('speed', { length: 50 }),
    isOffline: boolean('is_offline').default(false).notNull(),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export const eventStaff = pgTable('event_staff', {
    id: serial('id').primaryKey(),
    eventId: serial('event_id').references(() => events.id),
    userId: serial('user_id').references(() => users.id),
    assignedAt: timestamp('assigned_at').defaultNow().notNull(),
});

export const eventParticipants = pgTable('event_participants', {
    id: serial('id').primaryKey(),
    eventId: serial('event_id').references(() => events.id),
    userId: serial('user_id').references(() => users.id),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (t) => ({
    unq: uniqueIndex('event_participant_unique').on(t.eventId, t.userId),
}));

export const anomalies = pgTable('anomalies', {
    id: serial('id').primaryKey(),
    eventId: serial('event_id').references(() => events.id),
    userId: serial('user_id').references(() => users.id),
    type: varchar('type', { length: 50 }).notNull(),
    latitude: varchar('latitude', { length: 50 }).notNull(),
    longitude: varchar('longitude', { length: 50 }).notNull(),
    reason: text('reason').notNull(),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one }) => ({
    role: one(roles, {
        fields: [users.roleId],
        references: [roles.id],
    }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
    users: many(users),
}));

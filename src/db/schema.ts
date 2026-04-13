import { pgTable, serial, varchar, timestamp, text, integer, uniqueIndex, jsonb, boolean, pgEnum, doublePrecision } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const tokenStatusEnum = pgEnum('token_status', ['AVAILABLE', 'USED']);
export const eventCategoryEnum = pgEnum('event_category', ['RUNNING', 'CYCLING']);
export const eventStatusEnum = pgEnum('event_status', ['IDLE', 'START', 'FINISHED']);

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
    avatar: text('avatar'),
    phone: varchar('phone', { length: 20 }),
    healthInfo: jsonb('health_info'),
    roleId: integer('role_id').references(() => roles.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const events = pgTable('events', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    category: eventCategoryEnum('category').default('RUNNING').notNull(),
    status: eventStatusEnum('status').default('IDLE').notNull(),
    // Legacy singular token field left intact to avoid breaking old features safely
    token: varchar('token', { length: 255 }).notNull().unique(),
    currentCount: integer('current_count').default(0).notNull(),
    maxParticipants: integer('max_participants').notNull(),
    dateEvent: timestamp('date_event').defaultNow().notNull(),
    routeGeojson: jsonb('route_geojson'),
    startTime: timestamp('start_time'),
    endTime: timestamp('end_time'),
    // Monitoring window offsets (in minutes)
    monitoringStartOffset: integer('monitoring_start_offset').default(60).notNull(),
    monitoringEndOffset: integer('monitoring_end_offset').default(240).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
});

export const tokens = pgTable('tokens', {
    code: varchar('code', { length: 50 }).primaryKey(),
    eventId: integer('event_id').references(() => events.id).notNull(),
    userId: integer('user_id').references(() => users.id), // Nullable until redeemed
    status: tokenStatusEnum('status').default('AVAILABLE').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const locationLogs = pgTable('location_logs', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    eventId: integer('event_id').references(() => events.id),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    speed: doublePrecision('speed'),
    isOffline: boolean('is_offline').default(false).notNull(),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export const eventStaff = pgTable('event_staff', {
    id: serial('id').primaryKey(),
    eventId: integer('event_id').references(() => events.id),
    userId: integer('user_id').references(() => users.id),
    assignedAt: timestamp('assigned_at').defaultNow().notNull(),
});

export const eventParticipants = pgTable('event_participants', {
    id: serial('id').primaryKey(),
    eventId: integer('event_id').references(() => events.id),
    userId: integer('user_id').references(() => users.id),
    distanceCovered: integer('distance_covered').default(0).notNull(),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (t) => ({
    unq: uniqueIndex('event_participant_unique').on(t.eventId, t.userId),
}));

export const anomalies = pgTable('anomalies', {
    id: serial('id').primaryKey(),
    eventId: integer('event_id').references(() => events.id),
    userId: integer('user_id').references(() => users.id),
    type: varchar('type', { length: 50 }).notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    reason: text('reason').notNull(),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
    role: one(roles, {
        fields: [users.roleId],
        references: [roles.id],
    }),
    locationLogs: many(locationLogs),
    tokens: many(tokens),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
    users: many(users),
}));

export const eventsRelations = relations(events, ({ many }) => ({
    locationLogs: many(locationLogs),
    tokens: many(tokens),
}));

export const tokensRelations = relations(tokens, ({ one }) => ({
    event: one(events, {
        fields: [tokens.eventId],
        references: [events.id],
    }),
    user: one(users, {
        fields: [tokens.userId],
        references: [users.id],
    }),
}));

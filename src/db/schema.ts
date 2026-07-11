import {
  pgTable,
  serial,
  varchar,
  timestamp,
  text,
  integer,
  uniqueIndex,
  index,
  jsonb,
  boolean,
  pgEnum,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const tokenStatusEnum = pgEnum('token_status', ['AVAILABLE', 'USED']);
export const eventCategoryEnum = pgEnum('event_category', [
  'RUNNING',
  'CYCLING',
]);
export const eventStatusEnum = pgEnum('event_status', [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'READY',
  'LIVE',
  'FINISHED',
  'CANCELLED',
  'IDLE',
  'START',
]);
export const participantStateEnum = pgEnum('participant_state', [
  'REGISTERED',
  'CONFIRMED',
  'TRACKING',
  'FROZEN',
  'FINISHED',
]);

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
  gpxRouteUrl: varchar('gpx_route_url', { length: 500 }), // S3 URL for the source-of-truth GPX
  eventLocation: jsonb('event_location'), // Geo metadata for the event listing
  startPoint: jsonb('start_point'), // Derived from GPX
  finishPoint: jsonb('finish_point'), // Derived from GPX
  bannerImage: text('banner_image'), // S3 URL for event banner
  startTime: timestamp('start_time'),
  endTime: timestamp('end_time'),
  registrationOpen: timestamp('registration_open'),
  registrationClose: timestamp('registration_close'),
  locationName: varchar('location_name', { length: 255 }),
  city: varchar('city', { length: 100 }),
  province: varchar('province', { length: 100 }),
  latitude: doublePrecision('latitude'),
  longitude: doublePrecision('longitude'),
  // Monitoring window offsets (in minutes)
  monitoringStartOffset: integer('monitoring_start_offset')
    .default(60)
    .notNull(),
  monitoringEndOffset: integer('monitoring_end_offset').default(240).notNull(),
  totalDistanceMeters: integer('total_distance_meters'),
  totalElevationMeters: integer('total_elevation_meters'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
});

export const tokens = pgTable('tokens', {
  code: varchar('code', { length: 50 }).primaryKey(),
  eventId: integer('event_id')
    .references(() => events.id)
    .notNull(),
  userId: integer('user_id').references(() => users.id), // Nullable until redeemed
  status: tokenStatusEnum('status').default('AVAILABLE').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const locationLogs = pgTable(
  'location_logs',
  {
    messageId: varchar('message_id', { length: 26 }).primaryKey(), // ULID
    userId: integer('user_id')
      .references(() => users.id)
      .notNull(), // Backward compatibility
    participantId: integer('participant_id').references(
      () => eventParticipants.id,
    ), // Event context identity
    eventId: integer('event_id')
      .references(() => events.id)
      .notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    speed: doublePrecision('speed'),
    distanceDelta: doublePrecision('distance_delta'), // meters from last point
    speedCalculated: doublePrecision('speed_calculated'), // m/s from haversine
    isOffline: boolean('is_offline').default(false).notNull(),
    isAnomaly: boolean('is_anomaly').default(false).notNull(),
    capturedAt: timestamp('captured_at').notNull(),
    serverReceivedAt: timestamp('server_received_at').defaultNow().notNull(),
  },
  (t) => ({
    timeIdx: index('location_logs_time_idx').on(t.eventId, t.capturedAt.desc()),
  }),
);

export const eventStaff = pgTable('event_staff', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').references(() => events.id),
  userId: integer('user_id').references(() => users.id),
  assignedAt: timestamp('assigned_at').defaultNow().notNull(),
});

export const eventParticipants = pgTable(
  'event_participants',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id').references(() => events.id),
    userId: integer('user_id').references(() => users.id),
    participantNumber: varchar('participant_number', { length: 50 }),
    bibNumber: varchar('bib_number', { length: 50 }),
    participantState: participantStateEnum('participant_state')
      .default('REGISTERED')
      .notNull(),
    distanceCovered: integer('distance_covered').default(0).notNull(),
    estimatedFinishTime: timestamp('estimated_finish_time'),
    joinedAt: timestamp('joined_at').defaultNow().notNull(),
  },
  (t) => ({
    unq: uniqueIndex('event_participant_unique').on(t.eventId, t.userId),
  }),
);

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

export const rankings = pgTable('rankings',{
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .references(() => events.id)
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id)
      .notNull(),
    participantId: integer('participant_id')
      .references(() => eventParticipants.id)
      .notNull(),
    progressPercentage: doublePrecision('progress_percentage')
      .default(0)
      .notNull(),
    checkpointsCompleted: integer('checkpoints_completed').default(0).notNull(),
    timeEfficiency: doublePrecision('time_efficiency').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    unq: uniqueIndex('ranking_unique').on(t.eventId, t.participantId),
  }),
);

export const usersRelations = relations(users, ({ one, many }) => ({
  role: one(roles, {
    fields: [users.roleId],
    references: [roles.id],
  }),
  locationLogs: many(locationLogs),
  tokens: many(tokens),
  rankings: many(rankings),
  anomalies: many(anomalies),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  users: many(users),
}));

export const eventsRelations = relations(events, ({ many }) => ({
  locationLogs: many(locationLogs),
  tokens: many(tokens),
  rankings: many(rankings),
  anomalies: many(anomalies),
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

export const anomaliesRelations = relations(anomalies, ({ one }) => ({
  event: one(events, {
    fields: [anomalies.eventId],
    references: [events.id],
  }),
  user: one(users, {
    fields: [anomalies.userId],
    references: [users.id],
  }),
}));

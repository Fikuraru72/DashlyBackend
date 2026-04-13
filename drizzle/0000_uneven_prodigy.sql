CREATE TABLE "anomalies" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer,
	"user_id" integer,
	"type" varchar(50) NOT NULL,
	"latitude" varchar(50) NOT NULL,
	"longitude" varchar(50) NOT NULL,
	"reason" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer,
	"user_id" integer,
	"distance_covered" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer,
	"user_id" integer,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(50) DEFAULT 'IDLE' NOT NULL,
	"token" varchar(255) NOT NULL,
	"current_count" integer DEFAULT 0 NOT NULL,
	"max_participants" integer NOT NULL,
	"date_event" timestamp DEFAULT now() NOT NULL,
	"route_geojson" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "events_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "location_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"event_id" integer,
	"latitude" varchar(50) NOT NULL,
	"longitude" varchar(50) NOT NULL,
	"speed" varchar(50),
	"is_offline" boolean DEFAULT false NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"permissions" text[],
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" varchar(255),
	"google_id" varchar(255),
	"name" varchar(255) NOT NULL,
	"phone" varchar(20),
	"health_info" jsonb,
	"role_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomalies" ADD CONSTRAINT "anomalies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_staff" ADD CONSTRAINT "event_staff_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_staff" ADD CONSTRAINT "event_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_logs" ADD CONSTRAINT "location_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_logs" ADD CONSTRAINT "location_logs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_participant_unique" ON "event_participants" USING btree ("event_id","user_id");
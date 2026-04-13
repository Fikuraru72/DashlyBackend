CREATE TYPE "public"."event_category" AS ENUM('RUNNING', 'CYCLING');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('IDLE', 'START', 'FINISHED');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('AVAILABLE', 'USED');--> statement-breakpoint
CREATE TABLE "tokens" (
	"code" varchar(50) PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" integer,
	"status" "token_status" DEFAULT 'AVAILABLE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anomalies" ALTER COLUMN "latitude" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "anomalies" ALTER COLUMN "longitude" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "status" SET DEFAULT 'IDLE'::"public"."event_status";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "status" SET DATA TYPE "public"."event_status" USING "status"::"public"."event_status";--> statement-breakpoint
ALTER TABLE "location_logs" ALTER COLUMN "latitude" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "location_logs" ALTER COLUMN "longitude" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "location_logs" ALTER COLUMN "speed" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "category" "event_category" DEFAULT 'RUNNING' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "start_time" timestamp;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "end_time" timestamp;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "monitoring_start_offset" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "monitoring_end_offset" integer DEFAULT 240 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
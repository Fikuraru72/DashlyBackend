ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "altitude_profile" jsonb;
--> statement-breakpoint
ALTER TABLE "location_logs" ADD COLUMN IF NOT EXISTS "altitude" double precision;

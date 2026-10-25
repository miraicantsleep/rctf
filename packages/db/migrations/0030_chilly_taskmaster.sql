CREATE TABLE "user_divisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userid" text NOT NULL,
	"division" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "users_frozen_division_leaderboard_idx";--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "frozen_division" text;--> statement-breakpoint
ALTER TABLE "user_divisions" ADD CONSTRAINT "user_divisions_userid_users_id_fk" FOREIGN KEY ("userid") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "user_divisions_history_idx" ON "user_divisions" USING btree ("userid","changed_at","id");--> statement-breakpoint
CREATE INDEX "users_frozen_division_leaderboard_idx" ON "users" USING btree (frozen_division, frozen_division_rank ASC) WHERE frozen_division_rank IS NOT NULL;
--> statement-breakpoint
-- Existing installations have no recoverable division history. Use the current
-- division as a baseline for their earlier participation.
INSERT INTO user_divisions (userid, division, changed_at)
SELECT id, division, created_at FROM users;
--> statement-breakpoint
CREATE FUNCTION record_user_division() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.division IS DISTINCT FROM OLD.division THEN
    INSERT INTO user_divisions (userid, division, changed_at)
    VALUES (NEW.id, NEW.division, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_record_division AFTER INSERT OR UPDATE OF division ON users
FOR EACH ROW EXECUTE FUNCTION record_user_division();

ALTER TABLE "challenges" ADD COLUMN "frozen_score" integer;--> statement-breakpoint
ALTER TABLE "challenges" ADD COLUMN "frozen_solve_count" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "frozen_score" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "frozen_global_rank" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "frozen_division_rank" integer;--> statement-breakpoint
CREATE INDEX "users_frozen_global_leaderboard_idx" ON "users" USING btree (frozen_global_rank ASC) WHERE frozen_global_rank IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_frozen_division_leaderboard_idx" ON "users" USING btree (division, frozen_division_rank ASC) WHERE frozen_division_rank IS NOT NULL;
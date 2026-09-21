ALTER TABLE "users" ALTER COLUMN "access_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "access_status" SET DATA TYPE text USING "access_status"::text;--> statement-breakpoint
UPDATE "users" SET "access_status" = 'active' WHERE "access_status" IN ('pending', 'approved');--> statement-breakpoint
DROP TYPE "public"."access_status";--> statement-breakpoint
CREATE TYPE "public"."access_status" AS ENUM('active', 'suspended');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "access_status" SET DATA TYPE "public"."access_status" USING "access_status"::"public"."access_status";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "access_status" SET DEFAULT 'active'::"public"."access_status";

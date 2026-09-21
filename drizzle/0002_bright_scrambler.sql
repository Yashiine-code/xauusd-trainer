CREATE TYPE "public"."access_status" AS ENUM('pending', 'approved', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."product_session_mode" AS ENUM('RISK_TRAINING', 'CHALLENGE');--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_mode" "product_session_mode" NOT NULL,
	"phase" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"starting_balance" numeric(18, 6) NOT NULL,
	"balance" numeric(18, 6) NOT NULL,
	"risk_percent" numeric(12, 8),
	"statistics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" jsonb,
	"account" jsonb,
	"current_training_session_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" DROP CONSTRAINT "trades_session_id_training_sessions_session_id_fk";
--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "training_session_id" uuid;--> statement-breakpoint
UPDATE "trades" SET "training_session_id" = "session_id", "session_id" = NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "lot_size" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "entry_price" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "exit_price" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "stop_loss" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "take_profit" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "exit_reason" varchar(24);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "pnl" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "mfe_r" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "mae_r" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "product_session_id" uuid;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "session_type" "product_session_mode";--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "runtime_mode" varchar(24);--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "hidden_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "future_available_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "delivered_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "public_offset_seconds" integer;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "dataset_ended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "plan" jsonb;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "hidden_result" jsonb;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "hidden_exit_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "replay_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_status" "access_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_status_updated_idx" ON "sessions" USING btree ("user_id","status","updated_at");--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_training_session_id_training_sessions_session_id_fk" FOREIGN KEY ("training_session_id") REFERENCES "public"."training_sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_product_session_id_sessions_session_id_fk" FOREIGN KEY ("product_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_sessions_product_idx" ON "training_sessions" USING btree ("product_session_id");--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_operation_id_unique" UNIQUE("operation_id");
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "training_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trades" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "users", "sessions", "training_sessions", "trades" FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_current_training_session_fk" FOREIGN KEY ("current_training_session_id") REFERENCES "training_sessions"("session_id");

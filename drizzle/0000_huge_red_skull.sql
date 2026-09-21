CREATE TYPE "public"."question_status" AS ENUM('active', 'disabled', 'review');--> statement-breakpoint
CREATE TYPE "public"."training_session_mode" AS ENUM('QUESTION', 'REPLAY', 'RESULT', 'REVIEW');--> statement-breakpoint
CREATE TYPE "public"."market_timeframe" AS ENUM('1m', '3m', '5m', '15m', '1H');--> statement-breakpoint
CREATE TABLE "market_candles" (
	"symbol" varchar(16) NOT NULL,
	"timeframe" "market_timeframe" NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"open" numeric(18, 6) NOT NULL,
	"high" numeric(18, 6) NOT NULL,
	"low" numeric(18, 6) NOT NULL,
	"close" numeric(18, 6) NOT NULL,
	"volume" numeric(24, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "market_candles_symbol_timeframe_timestamp_pk" PRIMARY KEY("symbol","timeframe","timestamp")
);
--> statement-breakpoint
CREATE TABLE "question_pool" (
	"question_id" uuid PRIMARY KEY NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"hidden_timestamp" timestamp with time zone NOT NULL,
	"future_available_until" timestamp with time zone NOT NULL,
	"status" "question_status" DEFAULT 'active' NOT NULL,
	"quality_flag" text DEFAULT 'verified' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"trade_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"direction" varchar(8) NOT NULL,
	"result_r" numeric(12, 6),
	"holding_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"question_id" uuid NOT NULL,
	"current_time" timestamp with time zone NOT NULL,
	"mode" "training_session_mode" DEFAULT 'QUESTION' NOT NULL,
	"reveal_authorized_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_session_id_training_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."training_sessions"("session_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_question_id_question_pool_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_pool"("question_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_candles_symbol_timeframe_timestamp_idx" ON "market_candles" USING btree ("symbol","timeframe","timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "question_pool_symbol_hidden_timestamp_uidx" ON "question_pool" USING btree ("symbol","hidden_timestamp");--> statement-breakpoint
CREATE INDEX "question_pool_allocation_idx" ON "question_pool" USING btree ("symbol","status","hidden_timestamp");--> statement-breakpoint
CREATE INDEX "trades_session_idx" ON "trades" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "training_sessions_question_idx" ON "training_sessions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "training_sessions_expiry_idx" ON "training_sessions" USING btree ("expires_at");
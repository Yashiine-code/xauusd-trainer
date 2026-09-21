CREATE TABLE "wrong_book_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"product_session_id" uuid NOT NULL,
	"training_session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"trade_id" uuid NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"timeframe" "market_timeframe" NOT NULL,
	"direction" varchar(8) NOT NULL,
	"entry" numeric(18, 6) NOT NULL,
	"stop_loss" numeric(18, 6) NOT NULL,
	"take_profit" numeric(18, 6) NOT NULL,
	"exit_price" numeric(18, 6) NOT NULL,
	"result_r" numeric(12, 6) NOT NULL,
	"result_pnl" numeric(18, 6) NOT NULL,
	"exit_reason" varchar(24) NOT NULL,
	"reveal_start_time" timestamp with time zone NOT NULL,
	"reveal_end_time" timestamp with time zone NOT NULL,
	"screenshot_path" text,
	"thumbnail_path" text,
	"storage_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wrong_book_entries" ADD CONSTRAINT "wrong_book_entries_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_book_entries" ADD CONSTRAINT "wrong_book_entries_product_session_id_sessions_session_id_fk" FOREIGN KEY ("product_session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_book_entries" ADD CONSTRAINT "wrong_book_entries_training_session_id_training_sessions_session_id_fk" FOREIGN KEY ("training_session_id") REFERENCES "public"."training_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_book_entries" ADD CONSTRAINT "wrong_book_entries_question_id_question_pool_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question_pool"("question_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrong_book_entries" ADD CONSTRAINT "wrong_book_entries_trade_id_trades_trade_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("trade_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wrong_book_user_training_trade_uidx" ON "wrong_book_entries" USING btree ("user_id","training_session_id","trade_id");--> statement-breakpoint
CREATE INDEX "wrong_book_user_created_idx" ON "wrong_book_entries" USING btree ("user_id","created_at");
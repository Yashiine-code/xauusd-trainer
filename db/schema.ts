import {
  index,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const timeframeEnum = pgEnum("market_timeframe", ["1m", "3m", "5m", "15m", "1H"]);
export const questionStatusEnum = pgEnum("question_status", ["active", "disabled", "review"]);
export const sessionModeEnum = pgEnum("training_session_mode", ["QUESTION", "REPLAY", "RESULT", "REVIEW"]);
export const productModeEnum = pgEnum("product_session_mode", ["RISK_TRAINING", "CHALLENGE"]);
export const accessStatusEnum = pgEnum("access_status", ["active", "suspended"]);

export const marketCandles = pgTable(
  "market_candles",
  {
    symbol: varchar("symbol", { length: 16 }).notNull(),
    timeframe: timeframeEnum("timeframe").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "date" }).notNull(),
    open: numeric("open", { precision: 18, scale: 6 }).notNull(),
    high: numeric("high", { precision: 18, scale: 6 }).notNull(),
    low: numeric("low", { precision: 18, scale: 6 }).notNull(),
    close: numeric("close", { precision: 18, scale: 6 }).notNull(),
    volume: numeric("volume", { precision: 24, scale: 6 }).notNull().default("0"),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.timeframe, table.timestamp] }),
  ],
);

export const questionPool = pgTable(
  "question_pool",
  {
    questionId: uuid("question_id").primaryKey(),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    hiddenTimestamp: timestamp("hidden_timestamp", { withTimezone: true, mode: "date" }).notNull(),
    futureAvailableUntil: timestamp("future_available_until", { withTimezone: true, mode: "date" }).notNull(),
    status: questionStatusEnum("status").notNull().default("active"),
    qualityFlag: text("quality_flag").notNull().default("verified"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("question_pool_symbol_hidden_timestamp_uidx").on(table.symbol, table.hiddenTimestamp),
    index("question_pool_allocation_idx").on(table.symbol, table.status, table.hiddenTimestamp),
  ],
);

export const users = pgTable("users", {
  userId: uuid("user_id").primaryKey(),
  accessStatus: accessStatusEnum("access_status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
});

// One row represents a complete product run, potentially spanning many questions.
export const sessions = pgTable("sessions", {
  sessionId: uuid("session_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.userId),
  sessionMode: productModeEnum("session_mode").notNull(),
  phase: varchar("phase", { length: 24 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  startingBalance: numeric("starting_balance", { precision: 18, scale: 6 }).notNull(),
  balance: numeric("balance", { precision: 18, scale: 6 }).notNull(),
  riskPercent: numeric("risk_percent", { precision: 12, scale: 8 }),
  statistics: jsonb("statistics").notNull().default({}),
  snapshot: jsonb("snapshot").notNull().default({}),
  position: jsonb("position"),
  account: jsonb("account"),
  currentTrainingSessionId: uuid("current_training_session_id"),
  version: integer("version").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [index("sessions_user_status_updated_idx").on(table.userId, table.status, table.updatedAt)]);

export const trainingSessions = pgTable(
  "training_sessions",
  {
    sessionId: uuid("session_id").primaryKey(),
    productSessionId: uuid("product_session_id").references(() => sessions.sessionId),
    questionId: uuid("question_id").notNull().references(() => questionPool.questionId),
    sessionType: productModeEnum("session_type"),
    runtimeMode: varchar("runtime_mode", { length: 24 }),
    currentTime: timestamp("current_time", { withTimezone: true, mode: "date" }).notNull(),
    hiddenTimestamp: timestamp("hidden_timestamp", { withTimezone: true, mode: "date" }),
    futureAvailableUntil: timestamp("future_available_until", { withTimezone: true, mode: "date" }),
    deliveredThrough: timestamp("delivered_through", { withTimezone: true, mode: "date" }),
    publicOffsetSeconds: integer("public_offset_seconds"),
    datasetEnded: boolean("dataset_ended").notNull().default(false),
    plan: jsonb("plan"),
    hiddenResult: jsonb("hidden_result"),
    hiddenExitTimestamp: timestamp("hidden_exit_timestamp", { withTimezone: true, mode: "date" }),
    replayStartedAt: timestamp("replay_started_at", { withTimezone: true, mode: "date" }),
    version: integer("version").notNull().default(0),
    mode: sessionModeEnum("mode").notNull().default("QUESTION"),
    revealAuthorizedAt: timestamp("reveal_authorized_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("training_sessions_question_idx").on(table.questionId),
    index("training_sessions_expiry_idx").on(table.expiresAt),
    index("training_sessions_product_idx").on(table.productSessionId),
  ],
);

export const trades = pgTable(
  "trades",
  {
    tradeId: uuid("trade_id").primaryKey(),
    trainingSessionId: uuid("training_session_id").references(() => trainingSessions.sessionId),
    sessionId: uuid("session_id").references(() => sessions.sessionId),
    operationId: uuid("operation_id").unique(),
    direction: varchar("direction", { length: 8 }).notNull(),
    lotSize: numeric("lot_size", { precision: 12, scale: 4 }),
    entryPrice: numeric("entry_price", { precision: 18, scale: 6 }),
    exitPrice: numeric("exit_price", { precision: 18, scale: 6 }),
    stopLoss: numeric("stop_loss", { precision: 18, scale: 6 }),
    takeProfit: numeric("take_profit", { precision: 18, scale: 6 }),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    exitReason: varchar("exit_reason", { length: 24 }),
    pnl: numeric("pnl", { precision: 18, scale: 6 }),
    resultR: numeric("result_r", { precision: 12, scale: 6 }),
    mfeR: numeric("mfe_r", { precision: 12, scale: 6 }),
    maeR: numeric("mae_r", { precision: 12, scale: 6 }),
    holdingMinutes: integer("holding_minutes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [index("trades_session_idx").on(table.sessionId)],
);

export const wrongBookEntries = pgTable(
  "wrong_book_entries",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
    productSessionId: uuid("product_session_id").notNull().references(() => sessions.sessionId, { onDelete: "cascade" }),
    trainingSessionId: uuid("training_session_id").notNull().references(() => trainingSessions.sessionId, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull().references(() => questionPool.questionId),
    tradeId: uuid("trade_id").notNull().references(() => trades.tradeId, { onDelete: "cascade" }),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    timeframe: timeframeEnum("timeframe").notNull(),
    direction: varchar("direction", { length: 8 }).notNull(),
    entry: numeric("entry", { precision: 18, scale: 6 }).notNull(),
    stopLoss: numeric("stop_loss", { precision: 18, scale: 6 }).notNull(),
    takeProfit: numeric("take_profit", { precision: 18, scale: 6 }).notNull(),
    exitPrice: numeric("exit_price", { precision: 18, scale: 6 }).notNull(),
    resultR: numeric("result_r", { precision: 12, scale: 6 }).notNull(),
    resultPnl: numeric("result_pnl", { precision: 18, scale: 6 }).notNull(),
    exitReason: varchar("exit_reason", { length: 24 }).notNull(),
    revealStartTime: timestamp("reveal_start_time", { withTimezone: true, mode: "date" }).notNull(),
    revealEndTime: timestamp("reveal_end_time", { withTimezone: true, mode: "date" }).notNull(),
    screenshotPath: text("screenshot_path"),
    thumbnailPath: text("thumbnail_path"),
    storageMetadata: jsonb("storage_metadata").notNull().default({}),
    note: text("note").notNull().default(""),
    tags: jsonb("tags").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wrong_book_user_training_trade_uidx").on(table.userId, table.trainingSessionId, table.tradeId),
    index("wrong_book_user_created_idx").on(table.userId, table.createdAt),
  ],
);

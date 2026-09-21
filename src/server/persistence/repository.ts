import { persistenceSql as getSql, recordTiming, timedPhase } from "./request-scope.ts";
import type { ServerMarketSession } from "../market-data/session-store.ts";
import type { ChallengeSession, RiskTrainingSession, SessionMode } from "../../types/product-modes.ts";

export type ProductSnapshot = RiskTrainingSession | ChallengeSession;
export type TradeRecordInput = {
  direction: "LONG" | "SHORT";
  lotSize: number;
  entryPrice: number | null;
  exitPrice: number | null;
  openedAt: number;
  closedAt: number;
  exitReason: string;
  pnl: number;
  resultR: number | null;
  mfeR: number | null;
  maeR: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

export type ProductRow = {
  session_id: string;
  user_id: string;
  session_mode: SessionMode;
  phase: string;
  status: string;
  balance: string;
  starting_balance: string;
  risk_percent: string | null;
  statistics: ProductSnapshot["stats"];
  snapshot: ProductSnapshot;
  position: ChallengeSession["activePosition"] | null;
  account: ChallengeSession["account"] | null;
  current_training_session_id: string | null;
  version: number;
};

const date = (seconds: number) => new Date(seconds * 1000);

function isTransientConnectionFailure(cause: unknown): boolean {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return false;
  return ["CONNECT_TIMEOUT", "08P01", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(String(cause.code));
}

async function readWithConnectionRetry<T>(label: string, read: () => Promise<T>): Promise<T> {
  try { return await timedPhase(`SQL_${label}_ATTEMPT_1_CLIENT_WALL`, read); }
  catch (cause) {
    if (!isTransientConnectionFailure(cause)) throw cause;
    console.warn("PERSISTENCE_READ_RETRY", JSON.stringify({ operation: label, code: String((cause as { code: unknown }).code) }));
    return timedPhase(`SQL_${label}_ATTEMPT_2_CLIENT_WALL`, read);
  }
}

export async function createProductSession(userId: string, snapshot: ProductSnapshot): Promise<string> {
  const sql = getSql();
  const sessionId = crypto.randomUUID();
  const startingBalance = snapshot.startingBalance;
  const balance = snapshot.sessionMode === "CHALLENGE" ? snapshot.account.balance : snapshot.balance;
  const riskPercent = snapshot.sessionMode === "RISK_TRAINING" ? snapshot.riskPercent : null;
  const position = snapshot.sessionMode === "CHALLENGE" ? snapshot.activePosition : null;
  const account = snapshot.sessionMode === "CHALLENGE" ? snapshot.account : null;
  await sql`
    insert into sessions (session_id, user_id, session_mode, phase, starting_balance, balance, risk_percent, statistics, snapshot, position, account)
    values (${sessionId}::uuid, ${userId}::uuid, ${snapshot.sessionMode}::product_session_mode,
      ${snapshot.phase}, ${startingBalance}, ${balance}, ${riskPercent},
      ${sql.json(snapshot.stats)}, ${sql.json(snapshot)}, ${sql.json(position)}, ${sql.json(account)})
  `;
  return sessionId;
}

export async function getProductSession(userId: string, sessionId: string): Promise<ProductRow | null> {
  if (process.env.PHASE2_AUTH_DIAGNOSTICS === "true") console.info("PRODUCT_SESSION_READ", JSON.stringify({ count: 1 }));
  const [row] = await readWithConnectionRetry("getProductSession", () => getSql()<ProductRow[]>`
    select * from sessions where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid
  `);
  return row ?? null;
}

export async function getResumeState(userId: string, sessionId: string): Promise<{ product: ProductRow; market: ServerMarketSession } | null> {
  const [row] = await readWithConnectionRetry("getResumeState", () => getSql()<(ProductRow & {
    training_state: Record<string, unknown>;
    market_symbol: string;
  })[]>`
    select s.*, to_jsonb(ts) as training_state, qp.symbol as market_symbol
    from sessions s
    join training_sessions ts on ts.session_id = s.current_training_session_id and ts.product_session_id = s.session_id
    join question_pool qp on qp.question_id = ts.question_id
    where s.session_id = ${sessionId}::uuid and s.user_id = ${userId}::uuid
  `);
  if (!row) return null;
  const { training_state, market_symbol, ...product } = row;
  const market = trainingSessionFromRow({ ...training_state, symbol: market_symbol });
  return market ? { product, market } : null;
}

export async function listProductSessions(userId: string): Promise<ProductRow[]> {
  return readWithConnectionRetry("listProductSessions", () => getSql()<ProductRow[]>`
    select * from sessions where user_id = ${userId}::uuid order by updated_at desc limit 50
  `);
}

export async function findTradeOperation(userId: string, sessionId: string, operationId: string): Promise<boolean> {
  const [row] = await getSql()<{ trade_id: string }[]>`
    select t.trade_id from trades t join sessions s on s.session_id = t.session_id
    where t.operation_id = ${operationId}::uuid and s.session_id = ${sessionId}::uuid and s.user_id = ${userId}::uuid
  `;
  return Boolean(row);
}

export async function saveTrainingSession(productSessionId: string, state: ServerMarketSession, makeCurrent = true, expectedProductVersion?: number): Promise<number | null> {
  if (process.env.PHASE2_AUTH_DIAGNOSTICS === "true") console.info("TRAINING_SESSION_WRITE", JSON.stringify({ count: 1, event: makeCurrent ? "new_question" : "checkpoint_or_boundary" }));
  const sql = getSql();
  return sql.begin(async (tx) => {
    await tx`
      insert into training_sessions (
        session_id, product_session_id, question_id, session_type, runtime_mode, "current_time",
        hidden_timestamp, future_available_until, delivered_through, public_offset_seconds,
        dataset_ended, plan, hidden_result, hidden_exit_timestamp, replay_started_at,
        mode, reveal_authorized_at, expires_at
      ) values (
        ${state.token}::uuid, ${productSessionId}::uuid, ${state.questionId}::uuid,
        ${state.sessionType}::product_session_mode, ${state.mode}, ${date(state.currentTime)},
        ${date(state.hiddenTimestamp)}, ${date(state.futureAvailableUntil)}, ${date(state.deliveredThrough)},
        ${state.publicOffset}, ${state.datasetEnded}, ${sql.json(state.plan ?? null)},
        ${sql.json(state.hiddenResult ?? null)}, ${state.hiddenExitTimestamp ? date(state.hiddenExitTimestamp) : null},
        ${state.replayStartedAt ? date(state.replayStartedAt) : null},
        ${state.mode === "QUESTION" || state.mode === "REPLAY" || state.mode === "RESULT" || state.mode === "REVIEW" ? state.mode : "QUESTION"}::training_session_mode,
        ${state.revealAuthorized ? new Date() : null}, ${date(state.expiresAt)}
      ) on conflict (session_id) do update set
        runtime_mode = excluded.runtime_mode, "current_time" = excluded."current_time",
        delivered_through = excluded.delivered_through, dataset_ended = excluded.dataset_ended,
        plan = excluded.plan, hidden_result = excluded.hidden_result,
        hidden_exit_timestamp = excluded.hidden_exit_timestamp, replay_started_at = excluded.replay_started_at,
        mode = excluded.mode, reveal_authorized_at = excluded.reveal_authorized_at,
        version = training_sessions.version + 1, updated_at = now()
    `;
    if (makeCurrent) {
      const [row] = await tx<{ version: number }[]>`
      update sessions set current_training_session_id = ${state.token}::uuid,
        updated_at = now(), version = version + 1
      where session_id = ${productSessionId}::uuid and version = ${expectedProductVersion ?? -1}
      returning version
      `;
      if (!row) throw new Error("Session version conflict.");
      return row.version;
    }
    return null;
  });
}

export async function saveTrainingCheckpoint(productSessionId: string, trainingSessionId: string, currentTime: number): Promise<number | null> {
  const [row] = await getSql()<{ version: number }[]>`
    update training_sessions set "current_time" = ${date(currentTime)},
      version = version + 1, updated_at = now()
    where session_id = ${trainingSessionId}::uuid and product_session_id = ${productSessionId}::uuid
      and runtime_mode in ('QUESTION', 'REPLAY', 'ACTIVE', 'POSITION_OPEN')
      and "current_time" < ${date(currentTime)} and delivered_through >= ${date(currentTime)}
      and exists (select 1 from sessions where session_id = ${productSessionId}::uuid
        and current_training_session_id = ${trainingSessionId}::uuid and status = 'active')
    returning version
  `;
  return row?.version ?? null;
}

export async function activateTrainingSession(userId: string, productSessionId: string, trainingSessionId: string, expectedVersion: number): Promise<number> {
  const [row] = await getSql()<{ version: number }[]>`
    update sessions set current_training_session_id = ${trainingSessionId}::uuid,
      updated_at = now(), version = version + 1
    where session_id = ${productSessionId}::uuid and user_id = ${userId}::uuid and status = 'active' and version = ${expectedVersion}
      and exists (select 1 from training_sessions where session_id = ${trainingSessionId}::uuid and product_session_id = ${productSessionId}::uuid and runtime_mode = 'QUESTION')
    returning version
  `;
  if (!row) throw new Error("Session version conflict.");
  return row.version;
}

export async function getTrainingOwner(trainingSessionId: string): Promise<{ userId: string; productSessionId: string } | null> {
  const [row] = await getSql()<{ user_id: string; product_session_id: string }[]>`
    select s.user_id, s.session_id as product_session_id from training_sessions ts
    join sessions s on s.session_id = ts.product_session_id
    where ts.session_id = ${trainingSessionId}::uuid
  `;
  return row ? { userId: row.user_id, productSessionId: row.product_session_id } : null;
}

export async function loadTrainingSession(sessionId: string): Promise<ServerMarketSession | null> {
  const [row] = await readWithConnectionRetry("loadTrainingSession", () => getSql() < Record<string, unknown>[] >`
    select ts.*, qp.symbol from training_sessions ts
    join question_pool qp on qp.question_id = ts.question_id
    where ts.session_id = ${sessionId}::uuid
  `);
  return row ? trainingSessionFromRow(row) : null;
}

function trainingSessionFromRow(row: Record<string, unknown>): ServerMarketSession | null {
  if (!row || !row.hidden_timestamp || !row.delivered_through || !row.session_type) return null;
  const seconds = (value: unknown) => Math.floor(new Date(value as Date | string).getTime() / 1000);
  return {
    token: row.session_id as string,
    sessionType: row.session_type as SessionMode,
    questionId: row.question_id as string,
    symbol: row.symbol as string,
    hiddenTimestamp: seconds(row.hidden_timestamp),
    futureAvailableUntil: seconds(row.future_available_until),
    currentTime: seconds(row.current_time),
    publicOffset: Number(row.public_offset_seconds),
    mode: row.runtime_mode as ServerMarketSession["mode"],
    revealAuthorized: Boolean(row.reveal_authorized_at),
    replayCandles: [],
    plan: (row.plan ?? undefined) as ServerMarketSession["plan"],
    hiddenResult: (row.hidden_result ?? undefined) as ServerMarketSession["hiddenResult"],
    hiddenExitTimestamp: row.hidden_exit_timestamp ? seconds(row.hidden_exit_timestamp) : undefined,
    replayStartedAt: row.replay_started_at ? seconds(row.replay_started_at) : undefined,
    deliveredThrough: seconds(row.delivered_through),
    datasetEnded: Boolean(row.dataset_ended),
    expiresAt: seconds(row.expires_at),
  };
}

export async function updateProductSnapshot(userId: string, sessionId: string, expectedVersion: number, snapshot: ProductSnapshot): Promise<number> {
  const sql = getSql();
  const balance = snapshot.sessionMode === "CHALLENGE" ? snapshot.account.balance : snapshot.balance;
  const position = snapshot.sessionMode === "CHALLENGE" ? snapshot.activePosition : null;
  const account = snapshot.sessionMode === "CHALLENGE" ? snapshot.account : null;
  const [row] = await sql<{ version: number }[]>`
    update sessions set phase = ${snapshot.phase}, balance = ${balance},
      statistics = ${sql.json(snapshot.stats)}, snapshot = ${sql.json(snapshot)}, position = ${sql.json(position)}, account = ${sql.json(account)},
      status = ${snapshot.phase === "ENDED" || snapshot.phase === "BLOWN" ? "ended" : "active"},
      ended_at = ${snapshot.phase === "ENDED" || snapshot.phase === "BLOWN" ? new Date() : null},
      version = version + 1, updated_at = now()
    where session_id = ${sessionId}::uuid and user_id = ${userId}::uuid and version = ${expectedVersion}
    returning version
  `;
  if (!row) throw new Error("Session version conflict.");
  return row.version;
}

export async function settleTrade(input: {
  userId: string;
  sessionId: string;
  trainingSessionId: string;
  expectedVersion: number;
  operationId: string;
  snapshot: ProductSnapshot;
  trade: TradeRecordInput;
}): Promise<number> {
  const sql = getSql();
  const transactionStarted = performance.now();
  let callbackFinished = transactionStarted;
  try {
  const result = await sql.begin(async (tx) => {
    recordTiming("TRANSACTION_BEGIN_CLIENT_WALL", performance.now() - transactionStarted);
    try {
    const [existing] = await timedPhase("TRADE_READ_CLIENT_WALL", () => tx<{ session_id: string }[]>`
      select session_id from trades where operation_id = ${input.operationId}::uuid
    `);
    if (existing) {
      if (existing.session_id !== input.sessionId) throw new Error("Trade operation collision.");
      const [current] = await timedPhase("SESSION_READ_CLIENT_WALL", () => tx<{ version: number }[]>`select version from sessions where session_id = ${input.sessionId}::uuid and user_id = ${input.userId}::uuid`);
      if (!current) throw new Error("Session not found.");
      return current.version;
    }
    const [locked] = await timedPhase("SESSION_LOCK_CLIENT_WALL", () => tx<{ version: number }[]>`
      select version from sessions where session_id = ${input.sessionId}::uuid and user_id = ${input.userId}::uuid for update
    `);
    if (!locked || locked.version !== input.expectedVersion) throw new Error("Session version conflict.");
    const [child] = await timedPhase("TRAINING_SESSION_LOCK_CLIENT_WALL", () => tx<{ session_id: string }[]>`
      select session_id from training_sessions where session_id = ${input.trainingSessionId}::uuid
        and product_session_id = ${input.sessionId}::uuid for update
    `);
    if (!child) throw new Error("Training session mismatch.");
    const trade = input.trade;
    await timedPhase("TRADE_WRITE_CLIENT_WALL", () => tx`
      insert into trades (trade_id, session_id, training_session_id, operation_id, direction,
        lot_size, entry_price, exit_price, stop_loss, take_profit, opened_at, closed_at, exit_reason, pnl,
        result_r, mfe_r, mae_r, holding_minutes)
      values (${crypto.randomUUID()}::uuid, ${input.sessionId}::uuid, ${input.trainingSessionId}::uuid,
        ${input.operationId}::uuid, ${trade.direction}, ${trade.lotSize}, ${trade.entryPrice},
        ${trade.exitPrice}, ${trade.stopLoss ?? null}, ${trade.takeProfit ?? null},
        ${date(trade.openedAt)}, ${date(trade.closedAt)}, ${trade.exitReason},
        ${trade.pnl}, ${trade.resultR}, ${trade.mfeR}, ${trade.maeR},
        ${Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60))})
    `);
    const snapshot = input.snapshot;
    const balance = snapshot.sessionMode === "CHALLENGE" ? snapshot.account.balance : snapshot.balance;
    const position = snapshot.sessionMode === "CHALLENGE" ? snapshot.activePosition : null;
    const account = snapshot.sessionMode === "CHALLENGE" ? snapshot.account : null;
    const [updated] = await timedPhase("SESSION_WRITE_CLIENT_WALL", () => tx<{ version: number }[]>`
      update sessions set phase = ${snapshot.phase}, balance = ${balance},
        statistics = ${sql.json(snapshot.stats)}, snapshot = ${sql.json(snapshot)}, position = ${sql.json(position)}, account = ${sql.json(account)},
        status = ${snapshot.phase === "ENDED" || snapshot.phase === "BLOWN" ? "ended" : "active"},
        ended_at = ${snapshot.phase === "ENDED" || snapshot.phase === "BLOWN" ? new Date() : null},
        version = version + 1, updated_at = now()
      where session_id = ${input.sessionId}::uuid and user_id = ${input.userId}::uuid
      returning version
    `);
    await timedPhase("TRAINING_SESSION_WRITE_CLIENT_WALL", () => tx`
      update training_sessions set runtime_mode = ${snapshot.sessionMode === "CHALLENGE" ? snapshot.phase : "RESULT"},
        "current_time" = ${date(trade.closedAt)}, version = version + 1, updated_at = now()
      where session_id = ${input.trainingSessionId}::uuid
    `);
    return updated.version;
    } finally { callbackFinished = performance.now(); }
  });
  recordTiming("TRANSACTION_COMMIT_CLIENT_WALL", performance.now() - callbackFinished);
  return result;
  } catch (cause) {
    recordTiming("TRANSACTION_END_AFTER_ERROR_CLIENT_WALL", performance.now() - callbackFinished, "error");
    throw cause;
  }
}

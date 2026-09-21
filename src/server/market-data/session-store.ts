import type { Candle, TradePlan, TradeResult } from "../../types/market";
import type { SessionMode } from "../../types/product-modes";

export type ServerMarketSession = {
  token: string;
  userId?: string;
  productSessionId?: string;
  sessionType: SessionMode;
  questionId: string;
  symbol: string;
  hiddenTimestamp: number;
  futureAvailableUntil: number;
  currentTime: number;
  publicOffset: number;
  mode: "QUESTION" | "REPLAY" | "RESULT" | "REVIEW" | "ACTIVE" | "POSITION_OPEN" | "ENDED" | "BLOWN";
  revealAuthorized: boolean;
  replayCandles: Candle[];
  plan?: TradePlan;
  hiddenResult?: TradeResult;
  hiddenExitTimestamp?: number;
  replayStartedAt?: number;
  deliveredThrough: number;
  datasetEnded: boolean;
  expiresAt: number;
  lastCheckpointAt?: number;
};

const MAX_SESSIONS = 500;
const SESSION_TTL_SECONDS = 6 * 60 * 60;
const PUBLIC_HIDDEN_TIMESTAMP = Date.UTC(2024, 0, 15, 12, 0, 0) / 1000;

const globalSessions = globalThis as typeof globalThis & {
  __marketQuizSessions?: Map<string, ServerMarketSession>;
};
const sessions = globalSessions.__marketQuizSessions ??= new Map<string, ServerMarketSession>();

function pruneSessions(now = Date.now() / 1000) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

export function createServerSession(input: {
  questionId: string;
  symbol: string;
  hiddenTimestamp: number;
  futureAvailableUntil: number;
  sessionType?: SessionMode;
  userId?: string;
  productSessionId?: string;
  durable?: boolean;
}): ServerMarketSession {
  pruneSessions();
  const token = crypto.randomUUID();
  const session: ServerMarketSession = {
    token,
    ...input,
    sessionType: input.sessionType ?? "RISK_TRAINING",
    currentTime: input.hiddenTimestamp,
    publicOffset: input.hiddenTimestamp - PUBLIC_HIDDEN_TIMESTAMP,
    mode: input.sessionType === "CHALLENGE" ? "ACTIVE" : "QUESTION",
    revealAuthorized: false,
    replayCandles: [],
    deliveredThrough: input.hiddenTimestamp,
    datasetEnded: false,
    expiresAt: Math.floor(Date.now() / 1000) + (input.durable ? 365 * 24 * 60 * 60 : SESSION_TTL_SECONDS),
  };
  sessions.set(token, session);
  return session;
}

export function restoreServerSession(session: ServerMarketSession): ServerMarketSession {
  pruneSessions();
  sessions.set(session.token, session);
  return session;
}

export function getServerSession(token: string): ServerMarketSession | undefined {
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now() / 1000) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function toPublicTimestamp(session: ServerMarketSession, timestamp: number): number {
  return timestamp - session.publicOffset;
}

export function toActualTimestamp(session: ServerMarketSession, timestamp: number): number {
  return timestamp + session.publicOffset;
}

export function toPublicCandles(session: ServerMarketSession, candles: Candle[]): Candle[] {
  return candles.map((candle) => ({
    ...candle,
    timestamp: toPublicTimestamp(session, candle.timestamp),
  }));
}

export function getReplayReachedTimestamp(session: ServerMarketSession, elapsedMinutes: number): number {
  return (session.replayStartedAt ?? session.hiddenTimestamp) + elapsedMinutes * 60;
}

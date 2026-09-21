import type { Candle, MarketAdvancePayload, MarketSessionPayload, Timeframe, TradePlan, TradeResult } from "../types/market";
import type { SessionMode } from "../types/product-modes";
import type { ChallengeSession, RiskTrainingSession } from "../types/product-modes";
import { zhCN } from "../i18n/zh-CN";

function logMarketRequest(operation: string, response: Response | undefined, started: number, errorCount: number): void {
  console.info("MARKET REQUEST", JSON.stringify({
    operation,
    apiCount: 1,
    httpAdapterRequestCount: Number(response?.headers.get("X-HTTP-Adapter-Request-Count") ?? 0),
    postgresTcpClientCount: Number(response?.headers.get("X-Database-Client-Creations") ?? 0),
    browserLatencyMs: Number((performance.now() - started).toFixed(2)),
    errorCount,
    adapter: response?.headers.get("X-Market-Data-Adapter") ?? "UNKNOWN",
    serverTiming: response?.headers.get("Server-Timing") ?? "",
  }));
}

async function requestMarket<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const started = performance.now();
  let response: Response | undefined;
  try {
    response = await fetch("/api/market", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? zhCN.errors.unableToLoad);
    logMarketRequest(String(body.action ?? "unknown"), response, started, 0);
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    logMarketRequest(String(body.action ?? "unknown"), response, started, 1);
    throw error;
  }
}

export function createMarketSession(sessionMode: SessionMode = "RISK_TRAINING", productSessionId?: string, signal?: AbortSignal, expectedVersion?: number): Promise<MarketSessionPayload> {
  return requestMarket({ action: "new", sessionMode, productSessionId, expectedVersion }, signal);
}

export function prefetchMarketSession(sessionMode: SessionMode = "RISK_TRAINING", productSessionId?: string): Promise<MarketSessionPayload> {
  return requestMarket({ action: "prefetch", sessionMode, productSessionId });
}

export function activateMarketSession(token: string, expectedVersion: number): Promise<{ accepted: true; productVersion: number }> {
  return requestMarket({ action: "activate", token, expectedVersion });
}

export async function recordProductEvent(sessionId: string, expectedVersion: number, event: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
  const response = await fetch("/api/sessions/events", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, expectedVersion, event }),
    signal,
  });
  const result = await response.json() as { version?: number; error?: string; code?: string };
  if (result.code === "SESSION_CONFLICT") throw new Error("会话状态发生冲突，请刷新恢复。");
  if (!response.ok || result.version === undefined) throw new Error(result.error ?? "保存会话失败。");
  return result.version;
}

export async function settleProductTrade(input: {
  sessionId: string;
  trainingSessionId: string;
  expectedVersion: number;
  operationId: string;
  closedAt?: number;
  exitReason?: string;
}): Promise<{ version: number; snapshot: unknown }> {
  const response = await fetch("/api/sessions/settle", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const result = await response.json() as { version: number; snapshot: unknown; error?: string; code?: string };
  if (result.code === "SESSION_CONFLICT") throw new Error("会话状态发生冲突，请刷新恢复。");
  if (!response.ok) throw new Error(result.error ?? "交易结算失败。");
  return result;
}

export type ResumePayload = {
  sessionId: string;
  version: number;
  product: RiskTrainingSession | ChallengeSession;
  market: MarketSessionPayload & {
    authorizedThrough: number;
    replayCandles: Candle[];
    positionCandles: Candle[];
    runtimeMode: "QUESTION" | "REPLAY" | "RESULT" | "REVIEW" | "ACTIVE" | "POSITION_OPEN" | "ENDED" | "BLOWN";
    plan: TradePlan | null;
    result: TradeResult | null;
    exitTimestamp: number | null;
  };
};

export async function listProductSessions(): Promise<{ sessionId: string; sessionMode: SessionMode; phase: string; balance: number; status: string }[]> {
  const response = await fetch("/api/sessions", { cache: "no-store" });
  const result = await response.json() as { sessions?: { sessionId: string; sessionMode: SessionMode; phase: string; balance: number; status: string }[]; error?: string };
  if (!response.ok) throw new Error(result.error ?? "读取会话失败。");
  return result.sessions ?? [];
}

export async function resumeProductSession(sessionId: string): Promise<ResumePayload> {
  const response = await fetch("/api/sessions/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) });
  const result = await response.json() as ResumePayload & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "恢复会话失败。");
  return result;
}

export async function checkpointMarketSession(sessionId: string, token: string, currentTime: number): Promise<{ saved: boolean; version?: number }> {
  const response = await fetch("/api/sessions/checkpoint", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, token, currentTime }) });
  if (!response.ok) {
    const result = await response.json() as { error?: string };
    throw new Error(result.error ?? "保存进度失败。");
  }
  const result = await response.json() as { saved?: boolean; version?: number };
  return { saved: result.saved === true, version: result.version };
}

export async function createProductSession(input: { sessionMode: SessionMode; startingBalance: number; riskPercent?: number }, signal?: AbortSignal): Promise<{ sessionId: string; version: number }> {
  const response = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
  const result = await response.json() as { sessionId: string; version: number; error?: string };
  if (!response.ok) throw new Error(result.error ?? "创建训练会话失败。");
  return result;
}

export function submitMarketTrade(token: string, plan: TradePlan, currentTime: number): Promise<{ accepted: true }> {
  return requestMarket({ action: "submit", token, plan, currentTime });
}

export function fetchReplayBuffer(token: string, minutes: number, signal?: AbortSignal): Promise<{
  candles: Candle[];
  authorizedThrough: number;
  noMoreData: boolean;
}> {
  return requestMarket({ action: "buffer", token, minutes }, signal);
}

export function fetchResumeBuffer(token: string, signal?: AbortSignal): Promise<{
  candles: Candle[];
  authorizedThrough: number;
  noMoreData: boolean;
}> {
  return requestMarket({ action: "resume-buffer", token }, signal);
}

export function revealReplayResult(token: string, currentTime: number, tradeResult: TradeResult): Promise<{
  revealed: boolean;
  tradeResult?: TradeResult;
}> {
  return requestMarket({ action: "reveal-result", token, currentTime, tradeResult });
}

export function revealMarketFuture(token: string, start: number): Promise<MarketAdvancePayload> {
  return requestMarket({ action: "reveal", token, start });
}

export function updateChallengePosition(
  token: string,
  action: "challenge-open" | "challenge-close" | "challenge-end",
  currentTime: number,
): Promise<{ accepted: true }> {
  return requestMarket({ action, token, currentTime });
}

export async function fetchQuestionCandles(input: {
  token: string;
  questionId: string;
  timeframe: Timeframe;
  start: number;
  end: number;
  contextLimit?: number;
  signal?: AbortSignal;
}): Promise<Candle[]> {
  const started = performance.now();
  let response: Response | undefined;
  try {
    response = await fetch("/api/candles", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: input.token,
        questionId: input.questionId,
        timeframe: input.timeframe,
        start: input.start,
        end: input.end,
        contextLimit: input.contextLimit,
      }),
      signal: input.signal,
    });
    const payload = (await response.json()) as { candles?: Candle[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? zhCN.api.candleQueryFailed);
    logMarketRequest(`candles:${input.timeframe}`, response, started, 0);
    return payload.candles ?? [];
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    logMarketRequest(`candles:${input.timeframe}`, response, started, 1);
    throw error;
  }
}

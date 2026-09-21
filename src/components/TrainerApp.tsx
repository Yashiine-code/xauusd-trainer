"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext client Link navigation currently throws at runtime. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleMinus, CirclePause, CirclePlay, CirclePlus, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MIN_LOT } from "../config/trading";
import { directionLabel, modeLabel, phaseLabel, statusLabel, visibleError, zhCN } from "../i18n/zh-CN";
import { aggregateCandles, TIMEFRAME_MINUTES } from "../lib/candles";
import {
  createMarketSession,
  createProductSession,
  activateMarketSession,
  recordProductEvent,
  settleProductTrade,
  listProductSessions,
  resumeProductSession,
  checkpointMarketSession,
  fetchQuestionCandles,
  fetchReplayBuffer,
  fetchResumeBuffer,
  prefetchMarketSession,
  revealMarketFuture,
  revealReplayResult,
  submitMarketTrade,
  updateChallengePosition,
} from "../lib/data";
import { executePositionCandle, calculatePositionExcursions, calculatePositionRiskR, closePositionPnl } from "../lib/execution-engine";
import { mutateFastForwardMetrics, resetFastForwardMetrics, snapshotFastForwardMetrics } from "../lib/fast-forward-metrics";
import { appendOneMinuteCandles } from "../lib/incremental-timeframe";
import { MarketBuffer, INITIAL_AHEAD_BUFFER_MINUTES, MARKET_BUFFER_LOW_WATER_MINUTES, MARKET_BUFFER_REFILL_MINUTES } from "../lib/market-buffer";
import { MarketClock } from "../lib/market-clock";
import { calculateRequiredMarginForLot, createAccountState, hasSufficientMargin, markAccountToMarket } from "../lib/margin-engine";
import { calculateFixedRiskAutoLot, floorLotToStep, validateManualLot, type FixedRiskSizingResult } from "../lib/position-sizing";
import { resolveReplayStep } from "../lib/replay";
import { enqueueWrongBookSave } from "../lib/wrong-book";
import { createChallengeSession, reduceChallengeSession } from "../lib/sessions/challenge-session";
import { createRiskTrainingSession, reduceRiskTrainingSession } from "../lib/sessions/risk-training-session";
import { calculatePlanFinancials, calculateRiskReward, calculateXauPnl, createDefaultTradePlan, evaluateTrade, validateTrade } from "../lib/trading";
import type { AppMode, Candle, Direction, Timeframe, TradePlan, TradeResult } from "../types/market";
import type { ActivePosition, ChallengeSession, ClosedTrade, RiskTrainingSession, SessionMode } from "../types/product-modes";
import { MarketChart, type MarketChartHandle } from "./MarketChart";
import { ModeSelection } from "./ModeSelection";
import { ChallengeSummary, RiskTrainingSummary } from "./SessionSummary";

const TIMEFRAMES: Timeframe[] = ["1H", "15m", "5m", "3m", "1m"];
const VISIBLE_BARS: Record<Timeframe, number> = { "1H": 120, "15m": 170, "5m": 200, "3m": 220, "1m": 260 };
const CONTEXT_BARS: Record<Timeframe, number> = { "1H": 240, "15m": 400, "5m": 800, "3m": 1_000, "1m": 1_500 };
const MAX_INCREMENTAL_CHART_EXTRA_BARS = 10_000;
const LOCAL_1M_HISTORY_SECONDS = 14 * 24 * 60 * 60;
const LOCAL_1M_HISTORY_CANDLES = 6_000;
const REVEAL_FUTURE_SECONDS = 4 * 60 * 60;
const SPEEDS = [0.5, 1, 2, 5, 10] as const;
type PlaybackSpeed = (typeof SPEEDS)[number];
const SPEED_INTERVAL: Record<PlaybackSpeed, number> = { 0.5: 1000, 1: 500, 2: 250, 5: 100, 10: 50 };
const EMPTY_PLAN: TradePlan = { direction: "PASS", lotSize: MIN_LOT };

export function TrainerApp({ persistenceEnabled = false }: { persistenceEnabled?: boolean }) {
  mutateFastForwardMetrics((metrics) => { metrics.trainerRenderCount += 1; });
  const [candleCache, setCandleCache] = useState<Partial<Record<Timeframe, Candle[]>>>({});
  const [sessionToken, setSessionToken] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [isMock, setIsMock] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionSaveState, setSessionSaveState] = useState<"ready" | "saving" | "failed">("ready");
  const [mode, setMode] = useState<AppMode>("QUESTION");
  const [questionNumber, setQuestionNumber] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [timeframe, setTimeframe] = useState<Timeframe>("1H");
  const [draftPlan, setDraftPlan] = useState<TradePlan>(EMPTY_PLAN);
  const [plan, setPlan] = useState<TradePlan | null>(null);
  const [planStartTime, setPlanStartTime] = useState(0);
  const [replayCandles, setReplayCandles] = useState<Candle[]>([]);
  const replayCandlesRef = useRef<Candle[]>([]);
  const [replayStartTime, setReplayStartTime] = useState(0);
  const [result, setResult] = useState<TradeResult | null>(null);
  const [exitTimestamp, setExitTimestamp] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [noMoreData, setNoMoreData] = useState(false);
  const [resumeBufferReady, setResumeBufferReady] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [marketNotice, setMarketNotice] = useState<string | null>(null);
  const [wrongBookNotice, setWrongBookNotice] = useState<string | null>(null);
  const [wrongBookRetry, setWrongBookRetry] = useState<(() => void) | null>(null);
  const [switchingTimeframe, setSwitchingTimeframe] = useState<Timeframe | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [preparingReplay, setPreparingReplay] = useState(false);
  const [resultBalanceBefore, setResultBalanceBefore] = useState(1_000);
  const [riskSession, setRiskSession] = useState(() => reduceRiskTrainingSession(createRiskTrainingSession(0.02), { type: "START" }));
  const [productMode, setProductMode] = useState<SessionMode>("RISK_TRAINING");
  const productModeRef = useRef<SessionMode>("RISK_TRAINING");
  const [challengeSession, setChallengeSession] = useState(() => createChallengeSession(1_000));
  const challengeSessionRef = useRef(challengeSession);
  const [challengeLot, setChallengeLot] = useState(MIN_LOT);
  const challengeLotRef = useRef(MIN_LOT);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [screen, setScreen] = useState<"SELECT" | "SESSION" | "SUMMARY">("SELECT");
  const [savedSessions, setSavedSessions] = useState<Awaited<ReturnType<typeof listProductSessions>>>([]);
  const [resuming, setResuming] = useState(false);
  const [summaryMode, setSummaryMode] = useState<SessionMode>("RISK_TRAINING");
  const riskBalanceRef = useRef(1_000);
  const riskPercentRef = useRef(0.02);
  const advanceInFlight = useRef(false);
  const hasLoadedRef = useRef(false);
  const questionLoadInFlightRef = useRef(false);
  const nextQuestionInFlightRef = useRef(false);
  const nextQuestionRef = useRef<Promise<Awaited<ReturnType<typeof createMarketSession>> | null> | null>(null);
  const activeTokenRef = useRef("");
  const productSessionIdRef = useRef("");
  const productVersionRef = useRef(0);
  const trainingVersionRef = useRef(0);
  const sessionSaveReadyRef = useRef(true);
  const checkpointRef = useRef({ token: "", savedTime: 0, inFlight: false });
  const productEventQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settlementIdsRef = useRef(new Map<string, string>());
  const chartRef = useRef<MarketChartHandle>(null);
  const wrongBookScheduledRef = useRef(new Set<string>());

  const enqueueProductWrite = useCallback(<T,>(write: () => Promise<T>): Promise<T> => {
    const task = productEventQueueRef.current.then(write);
    productEventQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, []);

  const persistProductEvent = useCallback((event: Record<string, unknown>, signal?: AbortSignal): Promise<void> => {
    if (!persistenceEnabled || !productSessionIdRef.current) return Promise.resolve();
    return enqueueProductWrite(async () => {
      productVersionRef.current = await recordProductEvent(productSessionIdRef.current, productVersionRef.current, event, signal);
    });
  }, [enqueueProductWrite, persistenceEnabled]);

  const persistSettlement = useCallback(async (token: string, key: string, closedAt?: number, exitReason?: string): Promise<void> => {
    if (!persistenceEnabled || !productSessionIdRef.current) return;
    await enqueueProductWrite(async () => {
      let operationId = settlementIdsRef.current.get(key);
      if (!operationId) {
        operationId = crypto.randomUUID();
        settlementIdsRef.current.set(key, operationId);
      }
      const result = await settleProductTrade({
        sessionId: productSessionIdRef.current, trainingSessionId: token,
        expectedVersion: productVersionRef.current, operationId, closedAt, exitReason,
      });
      productVersionRef.current = result.version;
      const snapshot = result.snapshot as RiskTrainingSession | ChallengeSession;
      if (snapshot.sessionMode === "RISK_TRAINING") {
        riskBalanceRef.current = snapshot.balance;
        setRiskSession(snapshot);
      } else {
        challengeSessionRef.current = snapshot;
        setChallengeSession(snapshot);
      }
    });
  }, [enqueueProductWrite, persistenceEnabled]);
  const marketClockRef = useRef(new MarketClock(0));
  const marketBufferRef = useRef(new MarketBuffer(0));
  const marketBufferRequestRef = useRef<Promise<void> | null>(null);
  const marketBufferAbortRef = useRef<AbortController | null>(null);
  const resumeBufferAbortRef = useRef<AbortController | null>(null);
  const resumeBufferReadyRef = useRef(true);
  const marketRefillScheduledRef = useRef(false);
  const tradeSubmitRequestRef = useRef<Promise<unknown> | null>(null);
  const marketFlushFrameRef = useRef<number | null>(null);
  const firstPendingAtRef = useRef(0);
  const flushMarketRef = useRef<() => void>(() => undefined);
  const refillMarketBufferRef = useRef<(token: string, minutes?: number) => Promise<void> | null>(() => null);
  const currentTimeRef = useRef(0);
  const timeframeRef = useRef<Timeframe>("1H");
  const modeRef = useRef<AppMode>("QUESTION");
  const planRef = useRef<TradePlan | null>(null);
  const playingRef = useRef(false);
  const replayStartTimeRef = useRef(0);
  const mountedRef = useRef(false);
  const candleCacheRef = useRef<Partial<Record<Timeframe, Candle[]>>>({});
  const candleCacheTimeRef = useRef<Partial<Record<Timeframe, number>>>({});
  const inFlightRequestsRef = useRef(new Map<string, Promise<Candle[]>>());
  const prefetchControllersRef = useRef(new Map<string, AbortController>());
  const idleCallbacksRef = useRef(new Set<number>());
  const timeframeSwitchGenerationRef = useRef(0);

  useEffect(() => {
    if (!persistenceEnabled || screen !== "SELECT") return;
    void listProductSessions().then((rows) => setSavedSessions(rows.filter((row) => row.status === "active"))).catch(() => setSavedSessions([]));
  }, [persistenceEnabled, screen]);

  useEffect(() => {
    if (!persistenceEnabled || screen !== "SESSION") return;
    const timer = window.setInterval(() => {
      const productId = productSessionIdRef.current;
      const token = activeTokenRef.current;
      const currentTime = currentTimeRef.current;
      const checkpoint = checkpointRef.current;
      if (!productId || !token || !currentTime || checkpoint.token !== token ||
          !sessionSaveReadyRef.current || checkpoint.inFlight || currentTime <= checkpoint.savedTime) return;
      checkpoint.inFlight = true;
      void checkpointMarketSession(productId, token, currentTime)
        .then(({ saved, version }) => {
          if (saved && checkpoint.token === token) {
            checkpoint.savedTime = Math.max(checkpoint.savedTime, currentTime);
            if (version !== undefined) trainingVersionRef.current = version;
          }
        })
        .catch((cause: unknown) => {
          setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, "保存进度失败。"));
        })
        .finally(() => { checkpoint.inFlight = false; });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [persistenceEnabled, screen]);

  const buildLocalTimeframeCaches = useCallback((end: number) => {
    const source = marketBufferRef.current.releasedSnapshot(end);
    if (!source.length) return false;
    const nextCache = { ...candleCacheRef.current };
    const nextTimes = { ...candleCacheTimeRef.current };
    for (const target of TIMEFRAMES) {
      if (target === "1H" && nextCache[target]?.length) continue;
      const built = aggregateCandles(source, target, end).slice(-CONTEXT_BARS[target]);
      if (!built.length) continue;
      nextCache[target] = built;
      nextTimes[target] = end;
    }
    candleCacheRef.current = nextCache;
    candleCacheTimeRef.current = nextTimes;
    setCandleCache(nextCache);
    return true;
  }, []);

  const abortTimeframeRequests = useCallback(() => {
    for (const controller of prefetchControllersRef.current.values()) controller.abort();
    prefetchControllersRef.current.clear();
    inFlightRequestsRef.current.clear();
    for (const callback of idleCallbacksRef.current) {
      if (window.cancelIdleCallback) window.cancelIdleCallback(callback);
      else window.clearTimeout(callback);
    }
    idleCallbacksRef.current.clear();
    marketBufferAbortRef.current?.abort();
    marketBufferAbortRef.current = null;
    resumeBufferAbortRef.current?.abort();
    resumeBufferAbortRef.current = null;
    resumeBufferReadyRef.current = true;
    setResumeBufferReady(true);
    marketBufferRequestRef.current = null;
    marketRefillScheduledRef.current = false;
    tradeSubmitRequestRef.current = null;
    marketBufferRef.current.reset(0);
    marketClockRef.current.reset(0);
    timeframeSwitchGenerationRef.current += 1;
    firstPendingAtRef.current = 0;
    if (marketFlushFrameRef.current !== null) window.cancelAnimationFrame(marketFlushFrameRef.current);
    marketFlushFrameRef.current = null;
  }, []);

  const loadTimeframe = useCallback(async (
    target: Timeframe,
    token: string,
    id: string,
    end: number,
  ) => {
    if (!token || !id) return [];
    const key = `${id}:1m-source:${end}`;
    if (candleCacheTimeRef.current[target] === end) {
      return candleCacheRef.current[target] ?? [];
    }
    if (buildLocalTimeframeCaches(end) && candleCacheTimeRef.current[target] === end) {
      return candleCacheRef.current[target] ?? [];
    }
    const existing = inFlightRequestsRef.current.get(key);
    if (existing) {
      await existing;
      return candleCacheRef.current[target] ?? [];
    }

    const start = end - LOCAL_1M_HISTORY_SECONDS;
    const controller = new AbortController();
    prefetchControllersRef.current.set(key, controller);
    console.info("TIMEFRAME CACHE", JSON.stringify({
      phase: "request",
      questionId: id,
      selectedTimeframe: target,
      currentTime: end,
      requestedStartTime: start,
      requestedEndTime: end,
      rollingBufferStart: marketBufferRef.current.releasedSnapshot(end).at(0)?.timestamp ?? null,
      rollingBufferEnd: marketBufferRef.current.authorizedThrough,
      cacheExists: Boolean(candleCacheRef.current[target]?.length),
      inFlightExists: false,
      apiCalled: true,
    }));
    const request = fetchQuestionCandles({
      token,
      questionId: id,
      timeframe: "1m",
      start,
      end,
      contextLimit: LOCAL_1M_HISTORY_CANDLES,
      signal: controller.signal,
    }).then((rows) => {
      if (mountedRef.current && activeTokenRef.current === token && currentTimeRef.current === end) {
        marketBufferRef.current.seedReleased(rows);
        buildLocalTimeframeCaches(end);
      }
      console.info("TIMEFRAME CACHE", JSON.stringify({
        phase: "complete",
        questionId: id,
        selectedTimeframe: target,
        currentTime: end,
        requestedStartTime: start,
        requestedEndTime: end,
        apiCandleCount: rows.length,
        aborted: controller.signal.aborted,
        raceDiscarded: activeTokenRef.current !== token || currentTimeRef.current !== end,
      }));
      return rows;
    }).catch((cause: unknown) => {
      if (!(cause instanceof DOMException && cause.name === "AbortError") && activeTokenRef.current === token) {
        setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.timeframeLoad));
      }
      console.info("TIMEFRAME CACHE", JSON.stringify({
        phase: "failed",
        questionId: id,
        selectedTimeframe: target,
        currentTime: end,
        requestedStartTime: start,
        requestedEndTime: end,
        apiCandleCount: 0,
        aborted: controller.signal.aborted,
      }));
      return [];
    }).finally(() => {
      if (inFlightRequestsRef.current.get(key) === request) inFlightRequestsRef.current.delete(key);
      if (prefetchControllersRef.current.get(key) === controller) prefetchControllersRef.current.delete(key);
    });
    inFlightRequestsRef.current.set(key, request);
    await request;
    return candleCacheRef.current[target] ?? [];
  }, [buildLocalTimeframeCaches]);

  const switchTimeframe = useCallback(async (next: Timeframe) => {
    const generation = timeframeSwitchGenerationRef.current + 1;
    timeframeSwitchGenerationRef.current = generation;
    const token = activeTokenRef.current;
    const id = questionId;
    const end = currentTimeRef.current;
    if (!token || !id) return;
    if (candleCacheTimeRef.current[next] === end && candleCacheRef.current[next]?.length) {
      timeframeRef.current = next;
      setTimeframe(next);
      setSwitchingTimeframe(null);
      setMarketNotice(null);
      console.info("TIMEFRAME SWITCH", JSON.stringify({
        timeframe: next,
        source: "LOCAL_1M_CACHE",
        apiCount: 0,
        ...snapshotFastForwardMetrics(),
      }));
      return;
    }
    setSwitchingTimeframe(next);
    setMarketNotice(`${zhCN.workspace.preparing} ${next}，正在读取本地 1m 行情缓冲…`);
    const rows = await loadTimeframe(next, token, id, end);
    if (generation !== timeframeSwitchGenerationRef.current || activeTokenRef.current !== token) return;
    setSwitchingTimeframe(null);
    if (!rows.length || candleCacheTimeRef.current[next] !== end) {
      setMarketNotice(`${next} ${zhCN.errors.timeframeNotReady}`);
      return;
    }
    timeframeRef.current = next;
    setTimeframe(next);
    setMarketNotice(null);
    console.info("TIMEFRAME SWITCH", JSON.stringify({
      timeframe: next,
      source: "LOCAL_1M_BUFFER_BUILD",
      apiCount: 0,
      ...snapshotFastForwardMetrics(),
    }));
  }, [loadTimeframe, questionId]);

  const startNewQuestion = useCallback(async (sessionModeOverride?: SessionMode) => {
    if (questionLoadInFlightRef.current) return;
    if (persistenceEnabled && hasLoadedRef.current && !sessionSaveReadyRef.current) return;
    const requestedMode = sessionModeOverride ?? productModeRef.current;
    const initialLoad = !hasLoadedRef.current;
    const initialLoadSignal = initialLoad ? AbortSignal.timeout(20_000) : undefined;
    questionLoadInFlightRef.current = true;
    abortTimeframeRequests();
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      await productEventQueueRef.current;
      initialLoadSignal?.throwIfAborted();
      const prefetched = requestedMode === "RISK_TRAINING" && hasLoadedRef.current && nextQuestionRef.current
        ? await nextQuestionRef.current
        : null;
      const market = persistenceEnabled
        ? await enqueueProductWrite(async () => {
            const created = prefetched ?? await createMarketSession(requestedMode, productSessionIdRef.current || undefined, initialLoadSignal, productVersionRef.current);
            const version = prefetched ? (await activateMarketSession(created.token, productVersionRef.current)).productVersion : created.productVersion;
            if (version !== null && version !== undefined) productVersionRef.current = version;
            return created;
          })
        : prefetched ?? await createMarketSession(requestedMode, undefined, initialLoadSignal);
      productModeRef.current = requestedMode;
      setProductMode(requestedMode);
      nextQuestionRef.current = null;
      const history1h = market.candles.slice(-120);
      if (!history1h.length) throw new Error(zhCN.errors.noCandles);
      candleCacheRef.current = { "1H": market.candles };
      candleCacheTimeRef.current = { "1H": market.currentTime };
      setCandleCache(candleCacheRef.current);
      setSessionToken(market.token);
      activeTokenRef.current = market.token;
      checkpointRef.current = { token: market.token, savedTime: market.currentTime, inFlight: false };
      setQuestionId(market.questionId);
      setIsMock(market.isMock);
      setQuestionNumber(market.questionNumber);
      setCurrentTime(market.currentTime);
      currentTimeRef.current = market.currentTime;
      marketClockRef.current.reset(market.currentTime);
      marketBufferRef.current.reset(market.currentTime);
      const initialMode: AppMode = requestedMode === "CHALLENGE" ? "CHALLENGE" : "QUESTION";
      setMode(initialMode);
      modeRef.current = initialMode;
      setTimeframe("1H");
      timeframeRef.current = "1H";
      const initialPlan = createDefaultTradePlan(history1h, "LONG", requestedMode === "CHALLENGE" ? challengeLotRef.current : MIN_LOT);
      setDraftPlan(requestedMode === "CHALLENGE"
        ? { ...initialPlan, entry: history1h.at(-1)!.close, lotSize: challengeLotRef.current }
        : applyRiskSizing(initialPlan, riskBalanceRef.current, riskPercentRef.current).plan);
      setPlan(null);
      planRef.current = null;
      setPlanStartTime(market.currentTime);
      setReplayCandles([]);
      replayCandlesRef.current = [];
      setReplayStartTime(0);
      setResult(null);
      setExitTimestamp(undefined);
      setPlaying(false);
      playingRef.current = false;
      setPlaybackSpeed(1);
      setNoMoreData(market.noMoreData);
      setFormError(null);
      setMarketNotice(null);
      setSwitchingTimeframe(null);
      setRevealing(false);
      setPreparingReplay(false);
      let initialEvent: Record<string, unknown>;
      if (requestedMode === "RISK_TRAINING") {
        setRiskSession((current) => reduceRiskTrainingSession(current, { type: "QUESTION_READY" }));
        initialEvent = { type: "QUESTION_READY" };
      } else {
        const started = reduceChallengeSession(challengeSessionRef.current, { type: "START", timestamp: market.currentTime });
        challengeSessionRef.current = started;
        setChallengeSession(started);
        initialEvent = { type: "START", timestamp: market.currentTime };
      }
      hasLoadedRef.current = true;
      sessionSaveReadyRef.current = !persistenceEnabled;
      setSessionSaveState(persistenceEnabled ? "saving" : "ready");
      if (persistenceEnabled) {
        void persistProductEvent(initialEvent, AbortSignal.timeout(15_000))
          .then(() => {
            if (activeTokenRef.current !== market.token) return;
            sessionSaveReadyRef.current = true;
            setSessionSaveState("ready");
            if (requestedMode === "RISK_TRAINING") {
              nextQuestionRef.current = prefetchMarketSession("RISK_TRAINING", productSessionIdRef.current || undefined).catch(() => null);
            }
          })
          .catch(() => {
            if (activeTokenRef.current !== market.token) return;
            setSessionSaveState("failed");
          });
      }
      window.requestAnimationFrame(() => {
        if (activeTokenRef.current === market.token) {
          void refillMarketBufferRef.current(market.token, INITIAL_AHEAD_BUFFER_MINUTES);
        }
      });
      nextQuestionRef.current = !persistenceEnabled && requestedMode === "RISK_TRAINING"
        ? prefetchMarketSession("RISK_TRAINING").catch(() => null)
        : null;
      const idle = window.requestIdleCallback ?? ((callback: IdleRequestCallback) => window.setTimeout(callback, 1));
      const idleId = idle(() => {
        idleCallbacksRef.current.delete(idleId);
        void loadTimeframe("1m", market.token, market.questionId, market.currentTime);
      });
      idleCallbacksRef.current.add(idleId);
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "TimeoutError"
        ? "初始化超时，请重试。"
        : visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.createQuestion));
    } finally {
      questionLoadInFlightRef.current = false;
      setLoading(false);
    }
  }, [abortTimeframeRequests, enqueueProductWrite, loadTimeframe, persistenceEnabled, persistProductEvent]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortTimeframeRequests();
    };
  }, [abortTimeframeRequests, startNewQuestion]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
    timeframeRef.current = timeframe;
    modeRef.current = mode;
    planRef.current = plan;
    playingRef.current = playing;
    replayStartTimeRef.current = replayStartTime;
  }, [currentTime, mode, plan, playing, replayStartTime, timeframe]);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    const supported = PerformanceObserver.supportedEntryTypes;
    if (!supported.includes("longtask")) return;
    const observer = new PerformanceObserver((list) => {
      mutateFastForwardMetrics((metrics) => { metrics.longTaskCount += list.getEntries().length; });
    });
    observer.observe({ entryTypes: ["longtask"] });
    return () => observer.disconnect();
  }, []);

  const chartCandles = candleCache[timeframe] ?? [];
  const rr = calculateRiskReward(draftPlan);
  const riskSizing = useMemo(
    () => draftPlan.direction === "PASS" ? null : calculateFixedRiskAutoLot({
      balance: riskSession.balance,
      riskPercent: riskSession.riskPercent,
      entryPrice: draftPlan.entry ?? 0,
      stopLoss: draftPlan.stopLoss ?? 0,
      freeMargin: riskSession.balance,
    }),
    [draftPlan, riskSession.balance, riskSession.riskPercent],
  );
  const rawValidationError = validateTrade(draftPlan) ?? riskSizing?.error ?? null;
  const validationError = rawValidationError ? visibleError(rawValidationError, "交易计划无效，请检查价格设置。") : null;
  const financials = calculatePlanFinancials(draftPlan);
  const liveEvaluation = useMemo(() => plan && replayCandles.length ? evaluateTrade(replayCandles, plan, replayCandles.length, false) : null, [plan, replayCandles]);
  const finishWith = useCallback((tradeResult: TradeResult, terminalTime: number) => {
    const completedPlan = planRef.current;
    if (completedPlan && completedPlan.direction !== "PASS" && completedPlan.entry !== undefined && tradeResult.exitPrice !== null) {
      const pnl = calculateXauPnl(completedPlan.direction, completedPlan.entry, tradeResult.exitPrice, completedPlan.lotSize);
      setResultBalanceBefore(riskBalanceRef.current);
      setRiskSession((current) => {
        const next = reduceRiskTrainingSession(current, { type: "TRADE_RESULT", result: tradeResult, pnl });
        riskBalanceRef.current = next.balance;
        return next;
      });
    }
    setResult(tradeResult);
    setExitTimestamp(terminalTime);
    setPlaying(false);
    playingRef.current = false;
    setMode("RESULT");
    modeRef.current = "RESULT";
  }, []);

  const scheduleMarketFlush = useCallback(() => {
    if (marketFlushFrameRef.current !== null) return;
    marketFlushFrameRef.current = window.requestAnimationFrame(() => {
      marketFlushFrameRef.current = null;
      flushMarketRef.current();
    });
  }, []);

  const refillMarketBuffer = useCallback((token: string, minutes = MARKET_BUFFER_REFILL_MINUTES) => {
    const marketBuffer = marketBufferRef.current;
    if (!token || marketBuffer.datasetEnded) return marketBufferRequestRef.current;
    if (marketBufferRequestRef.current) return marketBufferRequestRef.current;
    const controller = new AbortController();
    marketBufferAbortRef.current = controller;
    mutateFastForwardMetrics((metrics) => { metrics.bufferRefillCount += 1; });
    const request = fetchReplayBuffer(token, minutes, controller.signal)
      .then((chunk) => {
        if (controller.signal.aborted || activeTokenRef.current !== token) return;
        marketBuffer.append(chunk.candles, chunk.authorizedThrough, chunk.noMoreData);
        if (marketClockRef.current.pendingSteps > 0 || playingRef.current) scheduleMarketFlush();
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        if (!marketBuffer.size) {
          setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.refill));
        }
      })
      .finally(() => {
        if (marketBufferRequestRef.current === request) marketBufferRequestRef.current = null;
        if (marketBufferAbortRef.current === controller) marketBufferAbortRef.current = null;
      });
    marketBufferRequestRef.current = request;
    return request;
  }, [scheduleMarketFlush]);

  useEffect(() => {
    refillMarketBufferRef.current = refillMarketBuffer;
  }, [refillMarketBuffer]);

  const scheduleMarketRefill = useCallback((token: string) => {
    if (marketRefillScheduledRef.current || marketBufferRequestRef.current || marketBufferRef.current.datasetEnded) return;
    marketRefillScheduledRef.current = true;
    const refill = () => {
      idleCallbacksRef.current.delete(idleId);
      marketRefillScheduledRef.current = false;
      if (activeTokenRef.current === token) void refillMarketBuffer(token);
    };
    const idleId = window.requestIdleCallback
      ? window.requestIdleCallback(refill, { timeout: 1_000 })
      : window.setTimeout(refill, 1);
    idleCallbacksRef.current.add(idleId);
  }, [refillMarketBuffer]);

  const appendReleasedCandles = useCallback((candles: Candle[], releasedThrough: number) => {
    if (!candles.length) return;
    const nextCache = { ...candleCacheRef.current };
    const nextTimes = { ...candleCacheTimeRef.current };
    for (const target of TIMEFRAMES) {
      const existing = nextCache[target];
      if (!existing) continue;
      nextCache[target] = appendOneMinuteCandles(
        existing,
        candles,
        target,
        CONTEXT_BARS[target] + MAX_INCREMENTAL_CHART_EXTRA_BARS,
      );
      nextTimes[target] = releasedThrough;
    }
    candleCacheRef.current = nextCache;
    candleCacheTimeRef.current = nextTimes;
    setCandleCache(nextCache);
  }, []);

  const flushMarketAdvances = useCallback(() => {
    const token = activeTokenRef.current;
    const activeMode = modeRef.current;
    const marketClock = marketClockRef.current;
    const marketBuffer = marketBufferRef.current;
    if (!token || (activeMode !== "QUESTION" && activeMode !== "REPLAY" && activeMode !== "CHALLENGE") || marketClock.pendingSteps < 1) return;
    const advance = marketClock.preview(
      TIMEFRAME_MINUTES[timeframeRef.current],
      marketBuffer.authorizedThrough,
      marketBuffer.datasetEnded,
    );
    if (!advance) {
      if (!marketBufferRequestRef.current && !marketBuffer.datasetEnded) void refillMarketBuffer(token);
      if (!marketBuffer.size) setMarketNotice(zhCN.errors.buffering);
      return;
    }

    const feedbackLatency = firstPendingAtRef.current ? performance.now() - firstPendingAtRef.current : 0;
    const stepCandles = marketBuffer.peekThrough(advance.targetTime);
    let releasedCandles = stepCandles;
    let exactTime = advance.targetTime;
    let terminalResult: TradeResult | null = null;
    let challengePositionClosed = false;

    if (activeMode === "REPLAY" && planRef.current) {
      const resolved = resolveReplayStep(
        replayCandlesRef.current,
        stepCandles,
        planRef.current,
        advance.reachedDatasetEnd,
      );
      releasedCandles = resolved.releasedCandles;
      replayCandlesRef.current = resolved.replayCandles;
      setReplayCandles(resolved.replayCandles);
      if (resolved.terminal) {
        terminalResult = resolved.evaluation;
        exactTime = releasedCandles.at(-1)?.timestamp ?? advance.targetTime;
      }
    }

    if (activeMode === "CHALLENGE") {
      let nextChallenge = challengeSessionRef.current;
      const activePosition = nextChallenge.activePosition;
      if (activePosition) {
        let workingPosition = activePosition;
        let workingAccount = nextChallenge.account;
        for (let index = 0; index < stepCandles.length; index += 1) {
          const candle = stepCandles[index];
          const execution = executePositionCandle(workingPosition, workingAccount, candle);
          workingPosition = execution.position;
          workingAccount = execution.account;
          if (!execution.exitReason || execution.exitPrice === null) continue;
          const excursions = calculatePositionExcursions(workingPosition);
          const trade: ClosedTrade = {
            direction: workingPosition.direction,
            lotSize: workingPosition.lotSize,
            entryPrice: workingPosition.entryPrice,
            exitPrice: execution.exitPrice,
            openedAt: workingPosition.openedAt,
            closedAt: candle.timestamp,
            pnl: closePositionPnl(workingPosition, execution.exitPrice),
            resultR: calculatePositionRiskR(workingPosition, execution.exitPrice),
            mfeR: excursions.mfeR,
            maeR: excursions.maeR,
            exitReason: execution.exitReason,
          };
          nextChallenge = reduceChallengeSession(
            { ...nextChallenge, account: workingAccount, activePosition: workingPosition },
            { type: "CLOSE_POSITION", trade },
          );
          releasedCandles = stepCandles.slice(0, index + 1);
          exactTime = candle.timestamp;
          challengePositionClosed = true;
          break;
        }
        if (!challengePositionClosed) {
          nextChallenge = {
            ...nextChallenge,
            account: workingAccount,
            activePosition: workingPosition,
            currentTime: advance.targetTime,
          };
        }
      } else {
        nextChallenge = { ...nextChallenge, currentTime: advance.targetTime };
      }

      if (advance.reachedDatasetEnd && !challengePositionClosed) {
        const finalCandle = releasedCandles.at(-1);
        const positionAtEnd = nextChallenge.activePosition;
        if (finalCandle && positionAtEnd) {
          const excursions = calculatePositionExcursions(positionAtEnd);
          const trade: ClosedTrade = {
            direction: positionAtEnd.direction,
            lotSize: positionAtEnd.lotSize,
            entryPrice: positionAtEnd.entryPrice,
            exitPrice: finalCandle.close,
            openedAt: positionAtEnd.openedAt,
            closedAt: finalCandle.timestamp,
            pnl: closePositionPnl(positionAtEnd, finalCandle.close),
            resultR: calculatePositionRiskR(positionAtEnd, finalCandle.close),
            mfeR: excursions.mfeR,
            maeR: excursions.maeR,
            exitReason: "DATASET_END",
          };
          nextChallenge = reduceChallengeSession(nextChallenge, { type: "CLOSE_POSITION", trade });
        }
        nextChallenge = reduceChallengeSession(nextChallenge, { type: "END", reason: "DATASET_END" });
      }
      challengeSessionRef.current = nextChallenge;
      setChallengeSession(nextChallenge);
      if (nextChallenge.phase === "ENDED" || nextChallenge.phase === "BLOWN") {
        setSummaryMode("CHALLENGE");
        setScreen("SUMMARY");
      }
    }

    marketBuffer.discardThrough(exactTime);
    marketClock.commit(advance, exactTime);
    if (terminalResult || challengePositionClosed) marketClock.clearPending();
    firstPendingAtRef.current = marketClock.pendingSteps ? performance.now() : 0;
    currentTimeRef.current = exactTime;
    appendReleasedCandles(releasedCandles, exactTime);
    setCurrentTime(exactTime);
    setMarketNotice(null);
    mutateFastForwardMetrics((metrics) => {
      metrics.flushCount += 1;
      metrics.consumedStepCount += advance.consumedSteps;
      metrics.maxFeedbackLatencyMs = Math.max(metrics.maxFeedbackLatencyMs, feedbackLatency);
    });

    if (marketBuffer.shouldRefill(MARKET_BUFFER_LOW_WATER_MINUTES)) {
      scheduleMarketRefill(token);
    }

    console.info("MARKET CLOCK", JSON.stringify({
      mode: activeMode,
      timeframe: timeframeRef.current,
      consumedSteps: advance.consumedSteps,
      pendingSteps: marketClock.pendingSteps,
      feedbackLatencyMs: Number(feedbackLatency.toFixed(2)),
      bufferedMinutes: marketBuffer.size,
      ...snapshotFastForwardMetrics(),
    }));

    if (terminalResult) {
      finishWith(terminalResult, exactTime);
      tradeSubmitRequestRef.current = (tradeSubmitRequestRef.current ?? Promise.resolve()).then(
        async () => {
          await revealReplayResult(token, exactTime, terminalResult);
          await persistSettlement(token, `risk:${token}`);
        },
      ).catch((cause: unknown) => {
        setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.recordReplay));
      });
      return;
    }
    if (challengePositionClosed) {
      const trade = challengeSessionRef.current.trades.at(-1);
      const request = persistenceEnabled && trade
        ? persistSettlement(token, `challenge:${token}:${trade.openedAt}:${trade.closedAt}`, trade.closedAt, trade.exitReason)
        : updateChallengePosition(token, "challenge-close", exactTime).then(() => undefined);
      void request.catch((cause: unknown) => {
        setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.recordClose));
      });
      return;
    }
    if (advance.reachedDatasetEnd) {
      marketClock.clearPending();
      setNoMoreData(true);
      setMarketNotice(zhCN.errors.datasetEnd);
      return;
    }
    if (marketClock.pendingSteps > 0) scheduleMarketFlush();
  }, [appendReleasedCandles, finishWith, persistenceEnabled, persistSettlement, refillMarketBuffer, scheduleMarketFlush, scheduleMarketRefill]);

  useEffect(() => {
    flushMarketRef.current = flushMarketAdvances;
  }, [flushMarketAdvances]);

  const enqueueMarketSteps = useCallback((steps: number) => {
    if (!resumeBufferReadyRef.current) return;
    const activeMode = modeRef.current;
    if (activeMode !== "QUESTION" && activeMode !== "REPLAY" && activeMode !== "CHALLENGE") return;
    if (!marketClockRef.current.pendingSteps) firstPendingAtRef.current = performance.now();
    marketClockRef.current.enqueue(steps);
    scheduleMarketFlush();
  }, [scheduleMarketFlush]);

  const enqueueMarketAdvance = useCallback(() => enqueueMarketSteps(1), [enqueueMarketSteps]);

  useEffect(() => {
    if (!playing || mode !== "REPLAY") return;
    const timer = window.setTimeout(enqueueMarketAdvance, SPEED_INTERVAL[playbackSpeed]);
    return () => window.clearTimeout(timer);
  }, [currentTime, enqueueMarketAdvance, mode, playbackSpeed, playing]);

  function selectDirection(direction: Direction) {
    setFormError(null);
    setPlanStartTime(currentTime);
    if (direction === "PASS") return setDraftPlan({ direction: "PASS", lotSize: MIN_LOT });
    setDraftPlan(applyRiskSizing(createDefaultTradePlan(chartCandles, direction, MIN_LOT), riskBalanceRef.current, riskPercentRef.current).plan);
  }
  function updateRiskPlan(nextPlan: TradePlan) {
    setDraftPlan(applyRiskSizing(nextPlan, riskBalanceRef.current, riskPercentRef.current).plan);
  }
  function submitTrade() {
    if (!sessionSaveReadyRef.current) return setFormError("会话正在保存，暂不能提交交易。");
    const issue = validateTrade(draftPlan) ?? riskSizing?.error;
    if (issue) return setFormError(visibleError(issue, "交易计划无效，请检查价格设置。"));
    setFormError(null);
    setPlan({ ...draftPlan });
    planRef.current = { ...draftPlan };
    setReplayStartTime(currentTime);
    replayStartTimeRef.current = currentTime;
    marketClockRef.current.clearPending();
    if (draftPlan.direction === "PASS") {
      setRiskSession((current) => reduceRiskTrainingSession(current, { type: "PASS" }));
      tradeSubmitRequestRef.current = submitMarketTrade(sessionToken, draftPlan, currentTime)
        .then(async () => { await persistProductEvent({ type: "PASS" }); await startNewQuestion(); })
        .catch((cause: unknown) => setFormError(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.submitDecision)));
      return;
    }

    resetFastForwardMetrics();
    replayCandlesRef.current = [];
    setReplayCandles([]);
    setMode("REPLAY");
    modeRef.current = "REPLAY";
    setPreparingReplay(true);
    setPlaying(false);
    playingRef.current = false;
    setMarketNotice(zhCN.errors.preparingReplay);
    setRiskSession((current) => reduceRiskTrainingSession(current, { type: "SUBMIT_TRADE", plan: draftPlan }));
    if (marketBufferRef.current.shouldRefill(MARKET_BUFFER_LOW_WATER_MINUTES)) {
      void refillMarketBuffer(sessionToken);
    }
    tradeSubmitRequestRef.current = submitMarketTrade(sessionToken, draftPlan, currentTime)
      .then(async () => {
        await persistProductEvent({ type: "SUBMIT_TRADE", plan: draftPlan });
        setPreparingReplay(false);
        setMarketNotice(null);
        setPlaying(true);
        playingRef.current = true;
        setRiskSession((current) => reduceRiskTrainingSession(current, { type: "REPLAY_READY" }));
        await persistProductEvent({ type: "REPLAY_READY" });
      })
      .catch((cause: unknown) => {
        setPreparingReplay(false);
        setPlaying(false);
        playingRef.current = false;
        setMode("QUESTION");
        modeRef.current = "QUESTION";
        setPlan(null);
        planRef.current = null;
        setFormError(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.submitTrade));
      });
  }

  function selectChallengeDirection(direction: Exclude<Direction, "PASS">) {
    const currentPrice = chartCandles.at(-1)?.close;
    if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) return;
    const next = createDefaultTradePlan(chartCandles, direction, challengeLotRef.current);
    setDraftPlan({ ...next, entry: currentPrice, lotSize: challengeLotRef.current });
    setChallengeError(null);
  }

  function updateChallengeLot(value: number) {
    const lot = Math.max(MIN_LOT, floorLotToStep(value) || MIN_LOT);
    challengeLotRef.current = lot;
    setChallengeLot(lot);
    setDraftPlan((current) => ({ ...current, lotSize: lot }));
    setChallengeError(null);
  }

  function updateChallengePlan(nextPlan: TradePlan) {
    const currentPrice = chartCandles.at(-1)?.close;
    if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) return;
    setDraftPlan({ ...nextPlan, entry: currentPrice, lotSize: challengeLotRef.current });
    setChallengeError(null);
  }

  function openChallengePosition() {
    if (!sessionSaveReadyRef.current) return setChallengeError("会话正在保存，暂不能开仓。");
    if (challengeSession.activePosition) return setChallengeError(zhCN.errors.activePositionOnly);
    const currentPrice = chartCandles.at(-1)?.close;
    if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice) || draftPlan.direction === "PASS") return setChallengeError(zhCN.errors.priceUnavailable);
    const lotIssue = validateManualLot(challengeLot);
    const planIssue = validateChallengePlan({ ...draftPlan, entry: currentPrice });
    if (lotIssue || planIssue) return setChallengeError(visibleError(lotIssue ?? planIssue, "交易参数无效，请检查后重试。"));
    const requiredMargin = calculateRequiredMarginForLot(currentPrice, challengeLot);
    if (!hasSufficientMargin(requiredMargin, challengeSession.account.freeMargin)) {
      return setChallengeError(zhCN.errors.insufficientMargin);
    }
    const position: ActivePosition = {
      direction: draftPlan.direction,
      lotSize: challengeLot,
      entryPrice: currentPrice,
      stopLoss: draftPlan.stopLoss,
      takeProfit: draftPlan.takeProfit,
      openedAt: currentTime,
      usedMargin: requiredMargin,
      maxHigh: currentPrice,
      minLow: currentPrice,
    };
    const previous = challengeSessionRef.current;
    let next = reduceChallengeSession(previous, { type: "OPEN_POSITION", position });
    next = { ...next, account: markAccountToMarket(next.account, position, currentPrice) };
    challengeSessionRef.current = next;
    setChallengeSession(next);
    setChallengeError(null);
    void updateChallengePosition(sessionToken, "challenge-open", currentTime).then(() => persistProductEvent({ type: "OPEN_POSITION", position })).catch((cause: unknown) => {
      challengeSessionRef.current = previous;
      setChallengeSession(previous);
      setChallengeError(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.openPosition));
    });
  }

  async function closeChallengePosition(): Promise<boolean> {
    const position = challengeSessionRef.current.activePosition;
    const currentPrice = chartCandles.at(-1)?.close;
    if (!position || typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) return false;
    const excursions = calculatePositionExcursions(position);
    const trade: ClosedTrade = {
      direction: position.direction,
      lotSize: position.lotSize,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      openedAt: position.openedAt,
      closedAt: currentTime,
      pnl: closePositionPnl(position, currentPrice),
      resultR: calculatePositionRiskR(position, currentPrice),
      mfeR: excursions.mfeR,
      maeR: excursions.maeR,
      exitReason: "MANUAL_CLOSE",
    };
    const previous = challengeSessionRef.current;
    const next = reduceChallengeSession(previous, { type: "CLOSE_POSITION", trade });
    challengeSessionRef.current = next;
    setChallengeSession(next);
    if (next.phase === "BLOWN") {
      setSummaryMode("CHALLENGE");
      setScreen("SUMMARY");
    }
    const request = persistenceEnabled
      ? persistSettlement(sessionToken, `challenge:${sessionToken}:${trade.openedAt}:${trade.closedAt}`, trade.closedAt, trade.exitReason)
      : updateChallengePosition(sessionToken, "challenge-close", currentTime).then(() => undefined);
    try {
      await request;
      return true;
    } catch (cause) {
      challengeSessionRef.current = previous;
      setChallengeSession(previous);
      setChallengeError(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.closePosition));
      return false;
    }
  }

  async function resumeSession(sessionId: string) {
    if (resuming) return;
    setResuming(true);
    setError(null);
    setScreen("SESSION");
    setLoading(true);
    try {
      abortTimeframeRequests();
      const resumeStarted = performance.now();
      const restored = await resumeProductSession(sessionId);
      const responseReady = performance.now();
      const market = restored.market;
      const product = restored.product;
      productSessionIdRef.current = restored.sessionId;
      productVersionRef.current = restored.version;
      activeTokenRef.current = market.token;
      checkpointRef.current = { token: market.token, savedTime: market.currentTime, inFlight: false };
      setSessionToken(market.token);
      setQuestionId(market.questionId);
      setQuestionNumber(market.questionNumber);
      setIsMock(market.isMock);
      setCurrentTime(market.currentTime);
      currentTimeRef.current = market.currentTime;
      const bufferStarted = performance.now();
      marketClockRef.current.reset(market.currentTime);
      marketBufferRef.current.reset(market.currentTime);
      marketBufferRef.current.seedReleased(market.replayCandles);
      const needsBuffer = market.runtimeMode === "QUESTION" || market.runtimeMode === "REPLAY" || market.runtimeMode === "ACTIVE" || market.runtimeMode === "POSITION_OPEN";
      resumeBufferReadyRef.current = !needsBuffer;
      setResumeBufferReady(!needsBuffer);
      const bufferInitMs = performance.now() - bufferStarted;
      candleCacheRef.current = { "1H": market.candles };
      candleCacheTimeRef.current = { "1H": market.currentTime };
      setCandleCache(candleCacheRef.current);
      setTimeframe("1H");
      timeframeRef.current = "1H";
      setNoMoreData(market.noMoreData);
      setReplayCandles(market.replayCandles);
      replayCandlesRef.current = market.replayCandles;
      setPlan(market.plan);
      planRef.current = market.plan;
      setPlanStartTime(market.currentTime);
      setReplayStartTime(market.replayCandles[0]?.timestamp ?? 0);
      replayStartTimeRef.current = market.replayCandles[0]?.timestamp ?? 0;
      setDraftPlan(market.plan ?? createDefaultTradePlan(market.candles.slice(-120), "LONG", MIN_LOT));
      setResult(market.result);
      setExitTimestamp(market.exitTimestamp ?? undefined);
      setPlaying(false);
      playingRef.current = false;
      setPreparingReplay(false);
      setRevealing(false);
      setMarketNotice(null);
      productModeRef.current = product.sessionMode;
      setProductMode(product.sessionMode);
      if (product.sessionMode === "RISK_TRAINING") {
        riskBalanceRef.current = product.balance;
        riskPercentRef.current = product.riskPercent;
        setRiskSession(product);
        const restoredMode = market.runtimeMode === "REPLAY" || market.runtimeMode === "RESULT" || market.runtimeMode === "REVIEW" ? market.runtimeMode : "QUESTION";
        modeRef.current = restoredMode;
        setMode(restoredMode);
      } else {
        let challenge = product;
        if (challenge.activePosition && market.positionCandles.length) {
          let position = challenge.activePosition;
          let account = createAccountState(challenge.account.balance);
          for (const candle of market.positionCandles) {
            const execution = executePositionCandle(position, account, candle);
            position = execution.position;
            account = execution.account;
            if (execution.exitReason) break;
          }
          challenge = { ...challenge, activePosition: position, account, currentTime: market.currentTime };
        }
        challengeSessionRef.current = challenge;
        setChallengeSession(challenge);
        modeRef.current = "CHALLENGE";
        setMode("CHALLENGE");
      }
      hasLoadedRef.current = true;
      sessionSaveReadyRef.current = true;
      setSessionSaveState("ready");
      setScreen("SESSION");
      console.info("RESUME_CLIENT_TIMING", JSON.stringify({
        apiAndJsonMs: Number((responseReady - resumeStarted).toFixed(2)),
        rollingBufferInitMs: Number(bufferInitMs.toFixed(2)),
        stateApplyMs: Number((performance.now() - responseReady).toFixed(2)),
      }));
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (activeTokenRef.current !== market.token) return;
        console.info("RESUME_CHART_VISIBLE", JSON.stringify({ elapsedMs: Number((performance.now() - resumeStarted).toFixed(2)) }));
        if (!needsBuffer) return;
        const controller = new AbortController();
        resumeBufferAbortRef.current = controller;
        void fetchResumeBuffer(market.token, controller.signal).then(async (chunk) => {
          if (controller.signal.aborted || activeTokenRef.current !== market.token) return;
          marketBufferRef.current.append(chunk.candles, chunk.authorizedThrough, chunk.noMoreData);
          resumeBufferReadyRef.current = true;
          setResumeBufferReady(true);
          console.info("RESUME_BUFFER_READY", JSON.stringify({ elapsedMs: Number((performance.now() - resumeStarted).toFixed(2)), candles: chunk.candles.length }));
          if (marketBufferRef.current.shouldRefill(MARKET_BUFFER_LOW_WATER_MINUTES)) {
            void refillMarketBufferRef.current(market.token, INITIAL_AHEAD_BUFFER_MINUTES);
          }
        }).catch((cause: unknown) => {
          if (controller.signal.aborted || activeTokenRef.current !== market.token) return;
          setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, "行情缓冲加载失败，请重新恢复会话。"));
        }).finally(() => {
          if (resumeBufferAbortRef.current === controller) resumeBufferAbortRef.current = null;
        });
      }));
    } catch (cause) {
      setScreen("SELECT");
      setError(visibleError(cause instanceof Error ? cause.message : null, "恢复会话失败。"));
    } finally { setResuming(false); setLoading(false); }
  }

  function startRiskTraining(riskPercent: number) {
    activeTokenRef.current = "";
    productSessionIdRef.current = "";
    productVersionRef.current = 0;
    hasLoadedRef.current = false;
    const next = reduceRiskTrainingSession(createRiskTrainingSession(riskPercent), { type: "START" });
    riskBalanceRef.current = next.balance;
    riskPercentRef.current = riskPercent;
    setRiskSession(next);
    productModeRef.current = "RISK_TRAINING";
    setProductMode("RISK_TRAINING");
    setScreen("SESSION");
    setLoading(true);
    if (persistenceEnabled) {
      void createProductSession({ sessionMode: "RISK_TRAINING", startingBalance: next.startingBalance, riskPercent }, AbortSignal.timeout(15_000))
        .then(({ sessionId, version }) => { productSessionIdRef.current = sessionId; productVersionRef.current = version; return startNewQuestion("RISK_TRAINING"); })
        .catch((cause: unknown) => { setLoading(false); setError(cause instanceof DOMException && cause.name === "TimeoutError" ? "创建训练会话超时，请重试。" : visibleError(cause instanceof Error ? cause.message : null, "创建训练会话失败。")); });
    } else void startNewQuestion("RISK_TRAINING");
  }

  function startChallenge(startingBalance: number) {
    activeTokenRef.current = "";
    productSessionIdRef.current = "";
    productVersionRef.current = 0;
    hasLoadedRef.current = false;
    const next = createChallengeSession(startingBalance);
    challengeSessionRef.current = next;
    setChallengeSession(next);
    challengeLotRef.current = MIN_LOT;
    setChallengeLot(MIN_LOT);
    setChallengeError(null);
    productModeRef.current = "CHALLENGE";
    setProductMode("CHALLENGE");
    setScreen("SESSION");
    setLoading(true);
    if (persistenceEnabled) {
      void createProductSession({ sessionMode: "CHALLENGE", startingBalance }, AbortSignal.timeout(15_000))
        .then(({ sessionId, version }) => { productSessionIdRef.current = sessionId; productVersionRef.current = version; return startNewQuestion("CHALLENGE"); })
        .catch((cause: unknown) => { setLoading(false); setError(cause instanceof DOMException && cause.name === "TimeoutError" ? "创建挑战会话超时，请重试。" : visibleError(cause instanceof Error ? cause.message : null, "创建挑战会话失败。")); });
    } else void startNewQuestion("CHALLENGE");
  }

  async function endRiskTraining() {
    if (!sessionSaveReadyRef.current) return;
    try {
      await persistProductEvent({ type: "END", reason: "USER_ENDED" });
      setRiskSession((current) => reduceRiskTrainingSession(current, { type: "END" }));
      setSummaryMode("RISK_TRAINING");
      setScreen("SUMMARY");
    } catch (cause) {
      setError(visibleError(cause instanceof Error ? cause.message : null, "结束训练未保存。"));
    }
  }

  async function endChallenge() {
    if (!sessionSaveReadyRef.current) return;
    if (challengeSessionRef.current.activePosition) {
      const confirmed = window.confirm(zhCN.challenge.confirmEnd);
      if (!confirmed) return;
      if (!await closeChallengePosition()) return;
    }
    const ended = reduceChallengeSession(challengeSessionRef.current, { type: "END", reason: "USER_ENDED" });
    challengeSessionRef.current = ended;
    setChallengeSession(ended);
    setSummaryMode("CHALLENGE");
    setScreen("SUMMARY");
    try {
      await persistProductEvent({ type: "END", reason: "USER_ENDED" });
      await updateChallengePosition(sessionToken, "challenge-end", currentTime);
    } catch (cause) {
      setError(visibleError(cause instanceof Error ? cause.message : null, "结束挑战未保存。"));
    }
  }

  function returnToModeSelection() {
    abortTimeframeRequests();
    activeTokenRef.current = "";
    sessionSaveReadyRef.current = true;
    setSessionSaveState("ready");
    hasLoadedRef.current = false;
    nextQuestionRef.current = null;
    setCandleCache({});
    candleCacheRef.current = {};
    candleCacheTimeRef.current = {};
    setLoading(false);
    setScreen("SELECT");
  }

  async function advanceToNextQuestion() {
    if (nextQuestionInFlightRef.current) return;
    nextQuestionInFlightRef.current = true;
    try {
      await tradeSubmitRequestRef.current;
      await persistProductEvent({ type: "NEXT_QUESTION" });
      setRiskSession((current) => reduceRiskTrainingSession(current, { type: "NEXT_QUESTION" }));
      await startNewQuestion();
    } catch (cause) {
      setError(visibleError(cause instanceof Error ? cause.message : null, "切换题目失败。"));
    } finally {
      nextQuestionInFlightRef.current = false;
    }
  }

  const applyRevealedCandles = useCallback((candles: Candle[], revealedThrough: number, ended: boolean) => {
    const unique = mergeCandleRows(replayCandlesRef.current, candles);
    replayCandlesRef.current = unique;
    setReplayCandles(unique);
    marketBufferRef.current.append(candles, revealedThrough, ended);
    marketBufferRef.current.discardThrough(revealedThrough);
    appendReleasedCandles(candles, revealedThrough);
    marketClockRef.current.reset(revealedThrough);
    currentTimeRef.current = revealedThrough;
    setCurrentTime(revealedThrough);
    setNoMoreData(ended);
    setMode("REVIEW");
    modeRef.current = "REVIEW";
    setRiskSession((current) => reduceRiskTrainingSession(current, { type: "REVEAL_FUTURE" }));
    setMarketNotice(null);
  }, [appendReleasedCandles]);

  const revealFuture = useCallback(async () => {
    if (!sessionToken || modeRef.current !== "RESULT" || advanceInFlight.current || exitTimestamp === undefined) return;
    advanceInFlight.current = true;
    const revealStarted = performance.now();
    const captureTimeframe = timeframeRef.current;
    const captureProductSessionId = productSessionIdRef.current;
    const captureTrainingSessionId = sessionToken;
    const shouldCaptureWrongBook = persistenceEnabled && productModeRef.current === "RISK_TRAINING" && result?.status === "STOP LOSS" && Boolean(captureProductSessionId);
    setRevealing(true);
    setMarketNotice(zhCN.result.revealing);
    try {
      const marketBuffer = marketBufferRef.current;
      const target = exitTimestamp + REVEAL_FUTURE_SECONDS;
      if (marketBufferRequestRef.current) await marketBufferRequestRef.current;
      await (tradeSubmitRequestRef.current ?? Promise.resolve());
      const released = await revealMarketFuture(sessionToken, exitTimestamp);
      const localEnd = Math.min(target, released.currentTime);
      const local = marketBuffer.peekThrough(localEnd);
      applyRevealedCandles(mergeCandleRows(local, released.candles), released.currentTime, released.noMoreData);
      window.requestAnimationFrame(() => {
        console.info("WRONG_BOOK_PERFORMANCE", JSON.stringify({ stage: "reveal_visible", elapsedMs: Number((performance.now() - revealStarted).toFixed(2)) }));
      });
      if (shouldCaptureWrongBook && !wrongBookScheduledRef.current.has(captureTrainingSessionId)) {
        wrongBookScheduledRef.current.add(captureTrainingSessionId);
        const captureAndSave = () => {
          setWrongBookNotice(null);
          setWrongBookRetry(null);
          void chartRef.current?.captureAfterPaint().then(({ image, captureMs }) => {
            console.info("WRONG_BOOK_PERFORMANCE", JSON.stringify({ stage: "captured", captureMs: Number(captureMs.toFixed(2)), timeframe: captureTimeframe }));
            enqueueWrongBookSave({
              image,
              productSessionId: captureProductSessionId,
              trainingSessionId: captureTrainingSessionId,
              timeframe: captureTimeframe,
              revealStartTime: exitTimestamp,
              revealEndTime: released.currentTime,
            }, {
              onSaved: (saved) => {
                setWrongBookNotice("已保存到错题本");
                console.info("WRONG_BOOK_PERFORMANCE", JSON.stringify({ stage: "saved", ...saved.timings, duplicate: saved.duplicate ?? false }));
              },
              onFailed: (retry) => {
                setWrongBookNotice("错题保存失败，可稍后重试。");
                setWrongBookRetry(() => retry);
              },
            });
          }).catch(() => {
            wrongBookScheduledRef.current.delete(captureTrainingSessionId);
            setWrongBookNotice("错题保存失败，可稍后重试。");
            setWrongBookRetry(() => captureAndSave);
          });
        };
        captureAndSave();
      }
      await persistProductEvent({ type: "REVEAL_FUTURE" });
      console.info("REVEAL FUTURE", JSON.stringify({
        source: "SERVER_AUTHORIZED_4H",
        apiCount: 1,
        requestedStartTime: exitTimestamp,
        revealedThrough: released.currentTime,
        apiCandleCount: released.candles.length,
      }));
    } catch (cause) {
      setMarketNotice(visibleError(cause instanceof Error ? cause.message : null, zhCN.errors.revealFuture));
    } finally {
      advanceInFlight.current = false;
      setRevealing(false);
    }
  }, [applyRevealedCandles, exitTimestamp, persistenceEnabled, persistProductEvent, result?.status, sessionToken]);

  const rawFillTimestamp = liveEvaluation?.filledIndex !== null && liveEvaluation?.filledIndex !== undefined
    ? replayCandles[liveEvaluation.filledIndex]?.timestamp
    : result?.filledIndex !== null && result?.filledIndex !== undefined ? replayCandles[result.filledIndex]?.timestamp : undefined;
  const alignMarker = (timestamp?: number) => timestamp === undefined ? undefined : chartCandles.findLast((candle) => candle.timestamp <= timestamp)?.timestamp;
  const datasetStart = chartCandles[0]?.timestamp ?? currentTime;
  const challengeChartPlan = challengeSession.activePosition
    ? activePositionToPlan(challengeSession.activePosition)
    : draftPlan;
  const chartPlan = productMode === "CHALLENGE" ? challengeChartPlan : mode === "QUESTION" ? draftPlan : plan;
  const positionEnd = mode === "RESULT" || mode === "REVIEW" ? exitTimestamp : currentTime;
  const elapsedReplayMinutes = replayStartTime ? Math.max(0, Math.round((currentTime - replayStartTime) / 60)) : 0;

  if (screen === "SELECT") return <ModeSelection onStartRisk={startRiskTraining} onStartChallenge={startChallenge} savedSessions={savedSessions} resuming={resuming} onResume={(sessionId) => void resumeSession(sessionId)} error={error} />;
  if (screen === "SUMMARY") return summaryMode === "RISK_TRAINING"
    ? <RiskTrainingSummary session={riskSession} onDone={returnToModeSelection} />
    : <ChallengeSummary session={challengeSession} onDone={returnToModeSelection} />;
  if (loading) return <LoadingScreen />;
  if (error || !chartCandles.length) return <main className="grid min-h-[100dvh] place-items-center bg-[#090b0d] px-6 text-[#d8dde2]"><div className="max-w-md border border-[#282f35] bg-[#101418] p-8"><p className="font-mono text-xs text-[#ef5350]">{error === "会话状态发生冲突，请刷新恢复。" ? "SESSION_CONFLICT" : "MARKET_DATA_ERROR"}</p><h1 className="mt-3 text-xl font-semibold">{error === "会话状态发生冲突，请刷新恢复。" ? error : "无法加载行情数据。"}</h1><p className="mt-2 text-sm leading-6 text-[#8f99a3]">{error === "会话状态发生冲突，请刷新恢复。" ? "请刷新页面并恢复当前会话。" : visibleError(error, zhCN.errors.noCandles)}</p><Button className="mt-5" onClick={() => {
    if (error === "会话状态发生冲突，请刷新恢复。") return window.location.reload();
    if (persistenceEnabled && !productSessionIdRef.current) {
      if (productModeRef.current === "CHALLENGE") startChallenge(challengeSessionRef.current.startingBalance);
      else startRiskTraining(riskPercentRef.current);
    } else void startNewQuestion();
  }}>{zhCN.errors.retry}</Button></div></main>;

  return <main className="min-h-[100dvh] bg-[#090b0d] text-[#d8dde2]">
    <header className="flex min-h-16 items-center justify-between border-b border-[#20262b] bg-[#0d1013] px-5 lg:px-8">
      <div className="flex items-center gap-5"><div><p className="font-mono text-[11px] tracking-[0.14em] text-[#6f7a84]">{productMode === "CHALLENGE" ? zhCN.common.challenge : zhCN.common.riskTraining}</p><h1 className="mt-0.5 text-base font-semibold">XAUUSD</h1></div><div className="hidden h-8 w-px bg-[#252b31] sm:block" /><div className="hidden sm:block">{productMode === "CHALLENGE" ? <><p className="text-xs text-[#6f7a84]">{zhCN.challenge.sessionTime}</p><p className="mt-0.5 font-mono text-sm text-[#c9d0d6]">{formatChallengeDay(challengeSession.startedAt, currentTime)}</p></> : <><p className="text-xs text-[#6f7a84]">{zhCN.workspace.currentExercise}</p><p className="mt-0.5 font-mono text-sm text-[#c9d0d6]">{zhCN.workspace.questionNumber}{questionNumber}</p></>}</div></div>
      <div className="flex items-center gap-3"><a href="/wrong-book" className="text-sm text-[#b8c0c7] transition-colors hover:text-[#d6b66d]">错题本</a><div className="hidden text-right sm:block"><p className="text-[10px] tracking-[0.12em] text-[#66717b]">{zhCN.common.balance}</p><p className="font-mono text-sm text-[#d6b66d]">{formatUsd(productMode === "CHALLENGE" ? challengeSession.account.balance : riskSession.balance)}</p></div><span className={`data-badge ${isMock ? "data-badge--mock" : ""}`}><span />{isMock ? zhCN.workspace.demoData : zhCN.workspace.historicalData}</span><Button type="button" variant="outline" size="sm" disabled={sessionSaveState !== "ready"} className="border-[#303840] bg-transparent text-[#b8c0c7] hover:bg-[#171c21] hover:text-white" onClick={productMode === "CHALLENGE" ? endChallenge : endRiskTraining}>{productMode === "CHALLENGE" ? zhCN.challenge.endChallenge : zhCN.workspace.endTraining}</Button></div>
    </header>
    {sessionSaveState !== "ready" ? <div role="status" className="flex items-center justify-between gap-3 border-b border-[#303840] bg-[#161a1d] px-5 py-2 text-xs text-[#d6b66d]">
      <span>{sessionSaveState === "saving" ? "行情已加载，正在后台保存会话；交易稍后可用。" : "行情已加载，但会话保存失败。为保护账户状态，请返回后重新进入。"}</span>
      {sessionSaveState === "failed" ? <Button size="sm" variant="outline" onClick={returnToModeSelection}>返回模式选择</Button> : null}
    </div> : null}
    <section className="grid min-h-[calc(100dvh-64px)] grid-cols-1 xl:grid-cols-[minmax(0,1fr)_370px]">
      <div className="flex min-w-0 flex-col border-r border-[#20262b]">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[#20262b] px-4 lg:px-6">
          <Tabs value={timeframe} onValueChange={(value) => void switchTimeframe(value as Timeframe)}><TabsList variant="line" className="h-10 gap-1 p-0">{TIMEFRAMES.map((item) => <TabsTrigger key={item} value={item} className="min-w-12 rounded-none px-3 font-mono text-xs text-[#707b85] data-[state=active]:text-[#d6b66d] after:bg-[#d6b66d]">{item}</TabsTrigger>)}</TabsList></Tabs>
          <div className="flex items-center gap-3 font-mono text-[11px] text-[#66717b]">{switchingTimeframe ? <span>{zhCN.workspace.preparing} {switchingTimeframe}…</span> : mode === "QUESTION" ? <span>{zhCN.workspace.futureLocked}</span> : mode === "CHALLENGE" ? <span>{phaseLabel(challengeSession.phase)}</span> : <><span className="status-dot" /><span>{modeLabel(mode)} · {elapsedReplayMinutes} 分钟</span></>}</div>
        </div>
        <div className="min-h-[440px] flex-1 lg:min-h-[620px]"><MarketChart ref={chartRef} candles={chartCandles} datasetStart={datasetStart} plan={chartPlan} result={result} fitToken={`${questionNumber}-${timeframe}`} visibleBars={VISIBLE_BARS[timeframe]} draggable={(mode === "QUESTION" || (mode === "CHALLENGE" && !challengeSession.activePosition)) && draftPlan.direction !== "PASS"} onPlanChange={mode === "QUESTION" ? updateRiskPlan : mode === "CHALLENGE" && !challengeSession.activePosition ? updateChallengePlan : undefined} fillTimestamp={productMode === "CHALLENGE" ? alignMarker(challengeSession.activePosition?.openedAt) : alignMarker(rawFillTimestamp)} exitTimestamp={alignMarker(exitTimestamp)} positionStartTimestamp={productMode === "CHALLENGE" ? alignMarker(challengeSession.activePosition?.openedAt) : alignMarker(planStartTime)} positionEndTimestamp={alignMarker(positionEnd)} positionActive={productMode === "CHALLENGE" ? Boolean(challengeSession.activePosition) : liveEvaluation?.status === "FILLED" || Boolean(result?.filledIndex !== null && result?.filledIndex !== undefined)} currentPrice={mode === "QUESTION" ? undefined : chartCandles.at(-1)?.close} /></div>
      </div>
      <aside className="bg-[#0d1013] p-5 lg:p-7">
        {mode === "CHALLENGE" ? <ChallengePanel session={challengeSession} plan={draftPlan} lot={challengeLot} timeframe={timeframe} noMoreData={noMoreData} canAdvance={resumeBufferReady} canCommit={sessionSaveState === "ready"} error={challengeError ?? marketNotice} onDirectionChange={selectChallengeDirection} onLotChange={updateChallengeLot} onToggleStop={() => setDraftPlan((current) => ({ ...current, stopLoss: current.stopLoss === undefined ? createDefaultTradePlan(chartCandles, current.direction === "PASS" ? "LONG" : current.direction, challengeLot).stopLoss : undefined }))} onNextCandle={enqueueMarketAdvance} onOpen={openChallengePosition} onClose={closeChallengePosition} />
          : mode === "QUESTION" ? <DecisionPanel plan={draftPlan} rr={rr} financials={financials} sizing={riskSizing} balance={riskSession.balance} riskPercent={riskSession.riskPercent} validationError={formError ?? validationError} timeframe={timeframe} noMoreData={noMoreData} canAdvance={resumeBufferReady} canCommit={sessionSaveState === "ready"} notice={marketNotice} onDirectionChange={selectDirection} onNextCandle={enqueueMarketAdvance} onSubmit={submitTrade} onNextQuestion={() => void startNewQuestion()} />
          : mode === "REPLAY" && plan ? <ReplayPanel plan={plan} timeframe={timeframe} elapsed={elapsedReplayMinutes} isPlaying={playing} speed={playbackSpeed} status={preparingReplay ? "PREPARING REPLAY" : liveEvaluation?.status ?? "PENDING"} notice={marketNotice} onStep={enqueueMarketAdvance} onTogglePlay={() => setPlaying((value) => { playingRef.current = !value; return !value; })} onSpeedChange={setPlaybackSpeed} preparing={preparingReplay || !resumeBufferReady} />
          : result && plan ? <ResultPanel result={result} plan={plan} balanceBefore={resultBalanceBefore} balanceAfter={riskSession.balance} reviewMode={mode === "REVIEW"} revealing={revealing} notice={marketNotice} onReveal={() => void revealFuture()} onNext={() => void advanceToNextQuestion()} /> : null}
      </aside>
    </section>
    {wrongBookNotice ? <div role="status" className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 border border-[#303840] bg-[#11161a] px-4 py-3 text-sm text-[#d8dde2] shadow-xl"><span>{wrongBookNotice}</span>{wrongBookRetry ? <Button size="sm" variant="outline" onClick={wrongBookRetry}>重新保存</Button> : null}<button type="button" className="text-[#7f8994]" aria-label="关闭" onClick={() => setWrongBookNotice(null)}>×</button></div> : null}
  </main>;
}

function DecisionPanel({ plan, rr, financials, sizing, balance, riskPercent, validationError, timeframe, noMoreData, canAdvance, canCommit, notice, onDirectionChange, onNextCandle, onSubmit, onNextQuestion }: { plan: TradePlan; rr: number | null; financials: ReturnType<typeof calculatePlanFinancials>; sizing: FixedRiskSizingResult | null; balance: number; riskPercent: number; validationError: string | null; timeframe: Timeframe; noMoreData: boolean; canAdvance: boolean; canCommit: boolean; notice: string | null; onDirectionChange: (direction: Direction) => void; onNextCandle: () => void; onSubmit: () => void; onNextQuestion: () => void }) {
  const isPass = plan.direction === "PASS";
  return <div><p className="section-kicker">{zhCN.trading.tradeDecision}</p><h2 className="mt-2 text-xl font-semibold tracking-tight">{zhCN.trading.buildPlan}</h2><p className="mt-2 text-sm leading-6 text-[#7c8791]">{isPass ? zhCN.trading.passHint : zhCN.trading.dragHint}</p>
    <div className="mt-6 grid grid-cols-3 gap-2" role="group" aria-label="交易方向">{(["LONG", "SHORT", "PASS"] as Direction[]).map((value) => <Button key={value} type="button" variant="outline" className={`h-11 border-[#303840] bg-transparent font-mono text-xs hover:bg-[#171c21] hover:text-white ${plan.direction === value ? "decision-active" : "text-[#87919a]"}`} aria-pressed={plan.direction === value} onClick={() => onDirectionChange(value)}>{directionLabel(value)}</Button>)}</div>
    {!isPass ? <><div className="mt-7 grid grid-cols-2 gap-px bg-[#252b31]"><CompactMetric label={zhCN.common.balance} value={formatUsd(balance)} /><CompactMetric label={zhCN.trading.autoLot} value={sizing?.actualLot ? sizing.actualLot.toFixed(2) : "-"} /><CompactMetric label={zhCN.common.targetRisk} value={formatUsd(sizing?.targetRisk ?? 0)} /><CompactMetric label={zhCN.common.actualRisk} value={formatUsd(sizing?.actualRisk ?? 0)} tone="loss" /></div>{sizing?.marginLimited ? <p className="mt-2 border-l-2 border-[#d6b66d] pl-3 text-xs text-[#d6b66d]">{zhCN.trading.marginLimited}，{zhCN.common.targetRisk} {formatPercent(riskPercent)}。</p> : null}
      <div className="mt-5 grid grid-cols-3 gap-px bg-[#252b31]"><CompactMetric label="R:R" value={rr ? `1:${rr.toFixed(2)}` : "无效"} /><CompactMetric label={zhCN.trading.risk} value={formatSignedUsd(financials.riskUsd)} tone="loss" /><CompactMetric label={zhCN.trading.reward} value={formatSignedUsd(financials.rewardUsd)} tone="gain" /></div><div className="mt-px flex items-end justify-between bg-[#111519] px-4 py-3.5"><div><p className="text-xs text-[#707b85]">{zhCN.common.requiredMargin}</p><p className="mt-1 font-mono text-lg text-[#d8dde2]">{formatUsd(financials.requiredMargin)}</p></div><p className="text-right text-[11px] leading-5 text-[#626d77]">{zhCN.trading.risk} {formatPercent(riskPercent)}<br />{zhCN.trading.autoSized}</p></div>{validationError ? <p className="mt-4 border-l-2 border-[#ef5350] pl-3 text-sm text-[#f07875]">{validationError}</p> : null}</> : null}
    <Button type="button" variant="outline" className="mt-6 h-11 w-full border-[#3b4650] bg-[#12171b] text-[#c3cbd2] hover:bg-[#1a2127] hover:text-white" disabled={noMoreData || !canAdvance} onClick={onNextCandle}><StepForward /> {zhCN.common.nextCandle} · {TIMEFRAME_MINUTES[timeframe]}m</Button>{notice ? <p className="mt-3 text-xs text-[#d6b66d]">{notice}</p> : null}{noMoreData ? <Button type="button" variant="outline" className="mt-3 h-11 w-full border-[#303840]" disabled={!canCommit} onClick={onNextQuestion}>{zhCN.common.nextQuestion}</Button> : null}<Button type="button" size="lg" className="mt-3 h-12 w-full bg-[#d6b66d] text-[#111315] hover:bg-[#e2c783] active:translate-y-px" disabled={!canCommit || (!isPass && Boolean(validationError))} onClick={onSubmit}>{isPass ? zhCN.trading.submitPass : zhCN.trading.submitTrade} <ChevronRight /></Button>
  </div>;
}

function ReplayPanel({ plan, timeframe, elapsed, isPlaying, speed, status, notice, onStep, onTogglePlay, onSpeedChange, preparing = false }: { plan: TradePlan; timeframe: Timeframe; elapsed: number; isPlaying: boolean; speed: PlaybackSpeed; status: string; notice: string | null; onStep: () => void; onTogglePlay: () => void; onSpeedChange: (speed: PlaybackSpeed) => void; preparing?: boolean }) {
  const rr = calculateRiskReward(plan); const financials = calculatePlanFinancials(plan);
  const stepMinutes = TIMEFRAME_MINUTES[timeframe];
  return <div><p className="section-kicker">{zhCN.trading.replayMode}</p><div className="mt-3 flex items-center justify-between"><h2 className="text-xl font-semibold">{zhCN.trading.yourTrade}</h2><span className="font-mono text-xs text-[#d6b66d]">{statusLabel(status)}</span></div><dl className="mt-6 border-y border-[#252b31]"><DataRow label={zhCN.trading.directionLot} value={`${directionLabel(plan.direction)} / ${plan.lotSize.toFixed(2)}`} /><DataRow label={zhCN.common.entry} value={formatPrice(plan.entry)} /><DataRow label={zhCN.trading.stopTarget} value={`${formatPrice(plan.stopLoss)} / ${formatPrice(plan.takeProfit)}`} /><DataRow label={zhCN.trading.riskReward} value={`${formatSignedUsd(financials.riskUsd)} / ${formatSignedUsd(financials.rewardUsd)}`} /><DataRow label={zhCN.trading.rrMargin} value={`${rr ? `1:${rr.toFixed(2)}` : "-"} / ${formatUsd(financials.requiredMargin)}`} accent /></dl><div className="mt-7 grid grid-cols-2 gap-px bg-[#252b31]"><CompactMetric label={zhCN.trading.replayClock} value={formatDuration(elapsed)} /><CompactMetric label={zhCN.trading.replayStep} value={`${stepMinutes} ${zhCN.trading.minutesPerCandle}`} /></div><div className="mt-5"><p className="text-xs text-[#707b85]">{zhCN.trading.playbackSpeed}</p><div className="mt-2 grid grid-cols-5 gap-1">{SPEEDS.map((value) => <Button key={value} type="button" variant="outline" disabled={preparing} className={`h-9 px-1 font-mono text-xs ${speed === value ? "border-[#d6b66d] bg-[#211e16] text-[#e0c782]" : "border-[#303840] text-[#87919a]"}`} onClick={() => onSpeedChange(value)}>{value}x</Button>)}</div></div><div className="mt-6 grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="replay-button h-12" disabled={isPlaying || preparing} onClick={onStep}><StepForward /><span className="flex flex-col items-start leading-none"><span>{zhCN.common.nextCandle}</span><small className="mt-1 font-mono text-[10px] text-[#7f8994]">+{timeframe}</small></span></Button><Button type="button" variant="outline" className="replay-button h-12" disabled={preparing} onClick={onTogglePlay}>{isPlaying ? <CirclePause /> : <CirclePlay />}{isPlaying ? zhCN.trading.pause : zhCN.trading.play}</Button></div>{notice ? <p className="mt-4 text-xs text-[#d6b66d]">{notice}</p> : null}<p className="mt-5 text-xs leading-5 text-[#68737d]">{zhCN.trading.replayNote}</p></div>;
}

function ChallengePanel({ session, plan, lot, timeframe, noMoreData, canAdvance, canCommit, error, onDirectionChange, onLotChange, onToggleStop, onNextCandle, onOpen, onClose }: { session: ChallengeSession; plan: TradePlan; lot: number; timeframe: Timeframe; noMoreData: boolean; canAdvance: boolean; canCommit: boolean; error: string | null; onDirectionChange: (direction: Exclude<Direction, "PASS">) => void; onLotChange: (lot: number) => void; onToggleStop: () => void; onNextCandle: () => void; onOpen: () => void; onClose: () => void }) {
  const position = session.activePosition;
  const requiredMargin = calculateRequiredMarginForLot(plan.entry ?? 0, lot);
  const potentialLoss = plan.stopLoss === undefined || plan.entry === undefined
    ? null
    : Math.abs(plan.entry - plan.stopLoss) * 100 * lot;
  const accountRisk = potentialLoss === null || session.account.balance <= 0
    ? null
    : (potentialLoss / session.account.balance) * 100;
  return <div><p className="section-kicker">{zhCN.challenge.account}</p><div className="mt-3 flex items-start justify-between"><div><h2 className="text-xl font-semibold">{position ? zhCN.challenge.positionOpen : zhCN.challenge.marketActive}</h2><p className="mt-1 text-sm text-[#7c8791]">{zhCN.challenge.onePositionMaximum}</p></div><span className="font-mono text-xs text-[#d6b66d]">{phaseLabel(session.phase)}</span></div>
    <div className="mt-6 grid grid-cols-2 gap-px bg-[#252b31]"><CompactMetric label={zhCN.common.balance} value={formatUsd(session.account.balance)} /><CompactMetric label={zhCN.common.equity} value={formatUsd(session.account.equity)} /><CompactMetric label={zhCN.common.floatingPnl} value={formatSignedUsd(session.account.floatingPnl)} tone={session.account.floatingPnl >= 0 ? "gain" : "loss"} /><CompactMetric label={zhCN.common.usedMargin} value={formatUsd(session.account.usedMargin)} /><CompactMetric label={zhCN.common.freeMargin} value={formatUsd(session.account.freeMargin)} /><CompactMetric label={zhCN.common.marginLevel} value={session.account.marginLevel === null ? "—" : `${session.account.marginLevel.toFixed(1)}%`} /></div>
    {position ? <><dl className="mt-5 border-y border-[#252b31]"><DataRow label={zhCN.trading.directionLot} value={`${directionLabel(position.direction)} / ${position.lotSize.toFixed(2)}`} /><DataRow label={zhCN.common.entry} value={formatPrice(position.entryPrice)} /><DataRow label={zhCN.trading.stopTarget} value={`${formatPrice(position.stopLoss)} / ${formatPrice(position.takeProfit)}`} /></dl><Button type="button" size="lg" className="mt-6 h-12 w-full bg-[#ef5350] text-[#111315] hover:bg-[#f16b68]" disabled={!canCommit} onClick={onClose}>{zhCN.challenge.closePosition}</Button></> : <><div className="mt-6 grid grid-cols-2 gap-2">{(["LONG", "SHORT"] as const).map((direction) => <Button key={direction} type="button" variant="outline" className={`h-11 border-[#303840] bg-transparent font-mono text-xs ${plan.direction === direction ? "decision-active" : "text-[#87919a]"}`} onClick={() => onDirectionChange(direction)}>{directionLabel(direction)}</Button>)}</div>
      <div className="mt-5"><label htmlFor="challenge-lot" className="text-sm text-[#aab2ba]">{zhCN.challenge.lotSize}</label><div className="mt-2 grid grid-cols-[44px_minmax(0,1fr)_44px] border border-[#303840] bg-[#0a0d0f]"><Button type="button" variant="ghost" aria-label="减少手数" className="h-11 rounded-none border-r border-[#303840] text-[#929ca5]" disabled={lot <= MIN_LOT} onClick={() => onLotChange(lot - 0.01)}><CircleMinus /></Button><Input id="challenge-lot" type="number" min={MIN_LOT} step="0.01" value={lot.toFixed(2)} onChange={(event) => onLotChange(Number(event.target.value))} className="h-11 rounded-none border-0 bg-transparent text-center font-mono text-base text-[#e0e4e8] shadow-none" /><Button type="button" variant="ghost" aria-label="增加手数" className="h-11 rounded-none border-l border-[#303840] text-[#929ca5]" onClick={() => onLotChange(lot + 0.01)}><CirclePlus /></Button></div></div>
      <div className="mt-5 grid grid-cols-2 gap-px bg-[#252b31]"><CompactMetric label={zhCN.common.requiredMargin} value={formatUsd(requiredMargin)} /><CompactMetric label={zhCN.common.accountRisk} value={accountRisk === null ? "—" : `${accountRisk.toFixed(1)}%`} /><CompactMetric label={zhCN.common.potentialSlLoss} value={potentialLoss === null ? zhCN.common.noStopLoss : formatUsd(potentialLoss)} tone={potentialLoss === null ? undefined : "loss"} /><CompactMetric label={zhCN.common.balanceIfSl} value={potentialLoss === null ? "—" : formatUsd(Math.max(0, session.account.balance - potentialLoss))} /></div><Button type="button" variant="outline" className="mt-3 h-9 w-full border-[#303840] text-xs text-[#9aa4ad]" onClick={onToggleStop}>{plan.stopLoss === undefined ? zhCN.challenge.addStopLoss : zhCN.challenge.removeStopLoss}</Button><Button type="button" size="lg" className="mt-4 h-12 w-full bg-[#d6b66d] text-[#111315] hover:bg-[#e2c783]" disabled={!canCommit} onClick={onOpen}>{zhCN.challenge.openMarketPosition}</Button></>}
    <Button type="button" variant="outline" className="mt-3 h-11 w-full border-[#3b4650] bg-[#12171b] text-[#c3cbd2]" disabled={noMoreData || !canAdvance} onClick={onNextCandle}><StepForward /> {zhCN.common.nextCandle} · {TIMEFRAME_MINUTES[timeframe]}m</Button>{error ? <p className="mt-3 border-l-2 border-[#ef5350] pl-3 text-sm text-[#f07875]">{error}</p> : null}</div>;
}

function ResultPanel({ result, plan, balanceBefore, balanceAfter, reviewMode, revealing, notice, onReveal, onNext }: { result: TradeResult; plan: TradePlan; balanceBefore: number; balanceAfter: number; reviewMode: boolean; revealing: boolean; notice: string | null; onReveal: () => void; onNext: () => void }) {
  const rr = calculateRiskReward(plan); const financials = calculatePlanFinancials(plan); const resultUsd = plan.direction === "PASS" || result.exitPrice === null || plan.entry === undefined ? 0 : calculateXauPnl(plan.direction, plan.entry, result.exitPrice, plan.lotSize);
  return <div><p className="section-kicker">{reviewMode ? zhCN.result.reviewMode : zhCN.result.result}</p><div className="mt-3 flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{statusLabel(result.status)}</h2><p className="mt-1 text-sm text-[#7c8791]">{directionLabel(result.direction)}决策</p></div><div className="text-right"><p className={`font-mono text-2xl font-semibold ${result.resultR >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}`}>{formatR(result.resultR)}</p><p className={`mt-1 font-mono text-sm ${resultUsd >= 0 ? "text-[#26a69a]" : "text-[#ef5350]"}`}>{formatSignedUsd(resultUsd)}</p></div></div><div className="mt-6 grid grid-cols-2 gap-px bg-[#252b31]"><ResultFact label={zhCN.result.balanceBefore} value={formatUsd(balanceBefore)} /><ResultFact label={zhCN.result.balanceAfter} value={formatUsd(balanceAfter)} /><ResultFact label={zhCN.result.direction} value={directionLabel(plan.direction)} /><ResultFact label={zhCN.challenge.lotSize} value={plan.direction === "PASS" ? "-" : plan.lotSize.toFixed(2)} /><ResultFact label={zhCN.common.entry} value={formatPrice(plan.entry)} /><ResultFact label={zhCN.common.stopLoss} value={formatPrice(plan.stopLoss)} /><ResultFact label={zhCN.common.takeProfit} value={formatPrice(plan.takeProfit)} /><ResultFact label={zhCN.result.holdingTime} value={result.filledIndex === null ? "-" : `${result.holdingMinutes} 分钟`} /></div><div className="mt-px grid grid-cols-2 gap-px bg-[#252b31]"><CompactMetric label={zhCN.result.riskUsd} value={formatSignedUsd(financials.riskUsd)} tone="loss" /><CompactMetric label={zhCN.result.rewardUsd} value={formatSignedUsd(financials.rewardUsd)} tone="gain" /><CompactMetric label="R:R" value={rr ? `1:${rr.toFixed(2)}` : "-"} /><CompactMetric label={zhCN.result.margin} value={formatUsd(financials.requiredMargin)} /></div>{plan.direction !== "PASS" ? <div className="mt-5 grid grid-cols-2 gap-px bg-[#252b31]"><CompactMetric label="最大有利波动（MFE）" value={formatR(result.mfeR)} tone={result.mfeR >= 0 ? "gain" : "loss"} /><CompactMetric label="最大不利波动（MAE）" value={formatR(result.maeR)} tone={result.maeR >= 0 ? "gain" : "loss"} /></div> : null}<p className="mt-5 text-xs leading-5 text-[#68737d]">{zhCN.result.executionRule}</p>{notice ? <p className="mt-3 text-xs text-[#ef6b68]">{notice}</p> : null}<div className="mt-7 grid grid-cols-2 gap-2"><Button type="button" variant="outline" className="h-12 border-[#3b4650] px-2 text-[#c3cbd2]" disabled={reviewMode || revealing} onClick={onReveal}>{reviewMode ? zhCN.result.futureRevealed : revealing ? zhCN.result.revealing : zhCN.result.revealFuture}</Button><Button type="button" size="lg" className="h-12 bg-[#d6b66d] px-2 text-[#111315] hover:bg-[#e2c783]" onClick={onNext}>{zhCN.common.nextQuestion} <ChevronRight /></Button></div></div>;
}

function mergeCandleRows(...groups: Candle[][]): Candle[] {
  const byTimestamp = new Map<number, Candle>();
  for (const rows of groups) for (const candle of rows) byTimestamp.set(candle.timestamp, candle);
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function CompactMetric({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) { return <div className="min-w-0 bg-[#111519] px-3 py-3.5"><p className="text-[11px] text-[#707b85]">{label}</p><p className={`mt-1 truncate font-mono text-sm ${tone === "gain" ? "text-[#26a69a]" : tone === "loss" ? "text-[#ef6b68]" : "text-[#d8dde2]"}`}>{value}</p></div>; }
function ResultFact({ label, value }: { label: string; value: string }) { return <div className="bg-[#111519] px-4 py-3"><p className="text-[11px] text-[#707b85]">{label}</p><p className="mt-1 font-mono text-sm text-[#d0d6db]">{value}</p></div>; }
function DataRow({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <div className="flex items-center justify-between border-b border-[#20262b] py-3 last:border-b-0"><dt className="text-sm text-[#747f89]">{label}</dt><dd className={`font-mono text-xs ${accent ? "text-[#d6b66d]" : "text-[#d0d6db]"}`}>{value}</dd></div>; }
function LoadingScreen() { return <main className="min-h-[100dvh] bg-[#090b0d] p-6 text-[#d8dde2]" aria-label={zhCN.common.loading}><span className="sr-only">{zhCN.common.loading}</span><div className="mx-auto max-w-7xl"><div className="flex h-14 items-center justify-between border-b border-[#20262b]"><Skeleton className="h-7 w-36 bg-[#171c21]" /><Skeleton className="h-8 w-32 bg-[#171c21]" /></div><div className="mt-5 grid gap-5 xl:grid-cols-[1fr_360px]"><Skeleton className="h-[72dvh] rounded-none bg-[#111519]" /><Skeleton className="h-[520px] rounded-none bg-[#111519]" /></div></div></main>; }
function formatPrice(value?: number) { return value === undefined ? "-" : value.toFixed(2); }
function formatUsd(value: number) { return `$${value.toFixed(2)}`; }
function formatSignedUsd(value: number) { return `${value > 0 ? "+" : ""}$${value.toFixed(2)}`; }
function formatR(value: number) { return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`; }
function formatDuration(minutes: number) { const hours = Math.floor(minutes / 60); const remainder = minutes % 60; return hours ? `${hours} 小时 ${remainder} 分钟` : `${minutes} 分钟`; }
function formatPercent(value: number) { return `${(value * 100).toFixed(0)}%`; }

function formatChallengeDay(startedAt: number | null, currentTime: number): string {
  if (startedAt === null) return "第 1 天";
  return `第 ${Math.floor(Math.max(0, currentTime - startedAt) / 86_400) + 1} 天`;
}

function activePositionToPlan(position: ActivePosition): TradePlan {
  return {
    direction: position.direction,
    lotSize: position.lotSize,
    entry: position.entryPrice,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
  };
}

function validateChallengePlan(plan: TradePlan): string | null {
  if (plan.direction === "PASS" || plan.entry === undefined) return zhCN.validation.chooseDirection;
  if (plan.stopLoss !== undefined) {
    if (plan.direction === "LONG" && plan.stopLoss >= plan.entry) return zhCN.validation.longStop;
    if (plan.direction === "SHORT" && plan.stopLoss <= plan.entry) return zhCN.validation.shortStop;
  }
  if (plan.takeProfit !== undefined) {
    if (plan.direction === "LONG" && plan.takeProfit <= plan.entry) return zhCN.validation.longTarget;
    if (plan.direction === "SHORT" && plan.takeProfit >= plan.entry) return zhCN.validation.shortTarget;
  }
  return null;
}

function applyRiskSizing(plan: TradePlan, balance: number, riskPercent: number): { plan: TradePlan; sizing: FixedRiskSizingResult | null } {
  if (plan.direction === "PASS" || plan.entry === undefined || plan.stopLoss === undefined) return { plan, sizing: null };
  const sizing = calculateFixedRiskAutoLot({ balance, riskPercent, entryPrice: plan.entry, stopLoss: plan.stopLoss, freeMargin: balance });
  return { plan: { ...plan, lotSize: sizing.actualLot || MIN_LOT }, sizing };
}

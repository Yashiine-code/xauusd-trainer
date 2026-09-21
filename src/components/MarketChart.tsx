"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import { calculatePlanFinancials, roundPrice } from "../lib/trading";
import { mutateFastForwardMetrics } from "../lib/fast-forward-metrics";
import type { Candle, TradePlan, TradeResult } from "../types/market";

type TradeLineKey = "entry" | "stopLoss" | "takeProfit";
type LineCoordinates = Partial<Record<TradeLineKey, number>>;
type PositionCoordinates = { startX: number; endX: number } | null;

type MarketChartProps = {
  candles: Candle[];
  datasetStart: number;
  plan: TradePlan | null;
  result: TradeResult | null;
  fitToken: string;
  visibleBars: number;
  draggable?: boolean;
  onPlanChange?: (plan: TradePlan) => void;
  fillTimestamp?: number;
  exitTimestamp?: number;
  positionStartTimestamp?: number;
  positionEndTimestamp?: number;
  positionActive?: boolean;
  currentPrice?: number;
};

export type MarketChartHandle = {
  captureAfterPaint: () => Promise<{ image: HTMLCanvasElement; captureMs: number }>;
};

const DISPLAY_EPOCH = 946_684_800;
const LINE_META: Record<TradeLineKey, { label: string; color: string }> = {
  entry: { label: "入场", color: "#d8dde2" },
  stopLoss: { label: "止损", color: "#ef5350" },
  takeProfit: { label: "止盈", color: "#26a69a" },
};

function toDisplayTime(timestamp: number, datasetStart: number): UTCTimestamp {
  return (DISPLAY_EPOCH + timestamp - datasetStart) as UTCTimestamp;
}

function formatRelativeTime(time: Time): string {
  const seconds = typeof time === "number" ? time : DISPLAY_EPOCH;
  const elapsed = Math.max(0, seconds - DISPLAY_EPOCH);
  const day = Math.floor(elapsed / 86_400) + 1;
  const minuteOfDay = Math.floor((elapsed % 86_400) / 60);
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfDay % 60).padStart(2, "0");
  return `第 ${day} 天  ${hours}:${minutes}`;
}

export const MarketChart = forwardRef<MarketChartHandle, MarketChartProps>(function MarketChart({
  candles,
  datasetStart,
  plan,
  result,
  fitToken,
  visibleBars,
  draggable = false,
  onPlanChange,
  fillTimestamp,
  exitTimestamp,
  positionStartTimestamp,
  positionEndTimestamp,
  positionActive = false,
  currentPrice,
}: MarketChartProps, forwardedRef) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartHostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const chartAliveRef = useRef(false);
  const chartGenerationRef = useRef(0);
  const markerPluginRef = useRef<{ detach: () => void } | null>(null);
  const fittedTokenRef = useRef<string | null>(null);
  const renderedDataRef = useRef<CandlestickData<Time>[]>([]);
  const renderedCandlesRef = useRef<Candle[]>([]);
  const planRef = useRef(plan);
  const datasetStartRef = useRef(datasetStart);
  const positionStartRef = useRef(positionStartTimestamp);
  const positionEndRef = useRef(positionEndTimestamp);
  const refreshFrameRef = useRef<number | null>(null);
  const draggingRef = useRef<TradeLineKey | null>(null);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const [dragging, setDragging] = useState<TradeLineKey | null>(null);
  const [lineCoordinates, setLineCoordinates] = useState<LineCoordinates>({});
  const [positionCoordinates, setPositionCoordinates] = useState<PositionCoordinates>(null);

  useImperativeHandle(forwardedRef, () => ({
    captureAfterPaint: () => new Promise((resolve, reject) => {
      const started = performance.now();
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        try {
          const chart = chartRef.current;
          const series = seriesRef.current;
          const currentPlan = planRef.current;
          if (!chartAliveRef.current || !chart || !series) throw new Error("Chart is not ready.");
          const source = chart.takeScreenshot();
          const target = document.createElement("canvas");
          target.width = source.width;
          target.height = source.height;
          const context = target.getContext("2d");
          if (!context) throw new Error("Screenshot canvas is unavailable.");
          context.drawImage(source, 0, 0);
          if (currentPlan && currentPlan.direction !== "PASS") {
            const pixelRatio = source.width / Math.max(1, chartHostRef.current?.clientWidth ?? source.width);
            context.font = `${Math.max(12, 11 * pixelRatio)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
            context.textBaseline = "middle";
            for (const key of Object.keys(LINE_META) as TradeLineKey[]) {
              const price = currentPlan[key];
              const coordinate = price === undefined ? null : series.priceToCoordinate(price);
              if (price === undefined || coordinate === null) continue;
              const y = coordinate * pixelRatio;
              const meta = LINE_META[key];
              context.strokeStyle = meta.color;
              context.globalAlpha = 0.82;
              context.setLineDash(key === "entry" ? [] : [6 * pixelRatio, 5 * pixelRatio]);
              context.beginPath();
              context.moveTo(0, y);
              context.lineTo(source.width, y);
              context.stroke();
              context.setLineDash([]);
              context.globalAlpha = 1;
              const label = `${meta.label}  ${price.toFixed(2)}`;
              const labelWidth = context.measureText(label).width + 16 * pixelRatio;
              context.fillStyle = "#11161a";
              context.fillRect(source.width - labelWidth - 8 * pixelRatio, y - 11 * pixelRatio, labelWidth, 22 * pixelRatio);
              context.fillStyle = meta.color;
              context.fillText(label, source.width - labelWidth, y);
            }
          }
          resolve({ image: target, captureMs: performance.now() - started });
        } catch (cause) { reject(cause); }
      }));
    }),
  }), []);

  useEffect(() => {
    planRef.current = plan;
    datasetStartRef.current = datasetStart;
    positionStartRef.current = positionStartTimestamp;
    positionEndRef.current = positionEndTimestamp;
  }, [datasetStart, plan, positionEndTimestamp, positionStartTimestamp]);

  const refreshLineCoordinates = useCallback(() => {
    if (!chartAliveRef.current) return;
    const series = seriesRef.current;
    const currentPlan = planRef.current;
    if (!series || !currentPlan || currentPlan.direction === "PASS") {
      setLineCoordinates({});
      setPositionCoordinates(null);
      return;
    }

    const next: LineCoordinates = {};
    for (const key of Object.keys(LINE_META) as TradeLineKey[]) {
      const price = currentPlan[key];
      const coordinate = price === undefined ? null : series.priceToCoordinate(price);
      if (coordinate !== null) next[key] = coordinate;
    }
    setLineCoordinates(next);

    const timeScale = chartRef.current?.timeScale();
    const host = chartHostRef.current;
    const startTimestamp = positionStartRef.current;
    const endTimestamp = positionEndRef.current;
    if (!timeScale || !host || startTimestamp === undefined || endTimestamp === undefined) {
      setPositionCoordinates(null);
      return;
    }
    const rawStart = timeScale.timeToCoordinate(toDisplayTime(startTimestamp, datasetStartRef.current));
    const rawEnd = timeScale.timeToCoordinate(toDisplayTime(endTimestamp, datasetStartRef.current));
    if (rawEnd === null) {
      setPositionCoordinates(null);
      return;
    }
    const endX = Math.min(host.clientWidth - 72, rawEnd);
    const mappedStart = rawStart === null ? endX - 150 : rawStart;
    const startX = Math.max(0, endX - mappedStart < 110 ? endX - 150 : mappedStart);
    setPositionCoordinates({ startX, endX: Math.max(startX + 2, endX) });
  }, []);

  const scheduleCoordinateRefresh = useCallback(() => {
    if (!chartAliveRef.current) return;
    if (refreshFrameRef.current !== null) return;
    const generation = chartGenerationRef.current;
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      if (!chartAliveRef.current || chartGenerationRef.current !== generation) return;
      refreshLineCoordinates();
    });
  }, [refreshLineCoordinates]);

  useEffect(() => {
    const container = containerRef.current;
    const chartHost = chartHostRef.current;
    if (!container || !chartHost) return;

    let disposed = false;
    const generation = chartGenerationRef.current + 1;
    chartGenerationRef.current = generation;
    const chart = createChart(chartHost, {
      width: chartHost.clientWidth,
      height: chartHost.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#0b0e11" },
        textColor: "#7f8994",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#181d22" },
        horzLines: { color: "#181d22" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "#252b31",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "#252b31",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => formatRelativeTime(time),
      },
      localization: { timeFormatter: (time: Time) => formatRelativeTime(time) },
      handleScale: true,
      handleScroll: true,
    });
    mutateFastForwardMetrics((metrics) => { metrics.chartCreateCount = (metrics.chartCreateCount ?? 0) + 1; });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceLineVisible: false,
      lastValueVisible: true,
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const scale = original();
        const currentPlan = planRef.current;
        if (!scale?.priceRange || !currentPlan || currentPlan.direction === "PASS") return scale;
        const prices = [currentPlan.entry, currentPlan.stopLoss, currentPlan.takeProfit].filter(
          (price): price is number => Number.isFinite(price),
        );
        if (!prices.length) return scale;
        scale.priceRange.minValue = Math.min(scale.priceRange.minValue, ...prices);
        scale.priceRange.maxValue = Math.max(scale.priceRange.maxValue, ...prices);
        return scale;
      },
    });

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      if (disposed || chartGenerationRef.current !== generation) return;
      const data = param.seriesData.get(series) as CandlestickData<Time> | undefined;
      if (!data) {
        setHovered(null);
      } else {
        setHovered({
          timestamp: 0,
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          volume: 0,
        });
      }
      scheduleCoordinateRefresh();
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const refreshOnInteraction = () => scheduleCoordinateRefresh();
    const resizeObserver = new ResizeObserver((entries) => {
      if (disposed || chartGenerationRef.current !== generation) return;
      const bounds = entries[0]?.contentRect;
      if (bounds) chart.resize(bounds.width, bounds.height);
      scheduleCoordinateRefresh();
    });
    resizeObserver.observe(container);
    container.addEventListener("wheel", refreshOnInteraction, { passive: true });
    container.addEventListener("pointermove", refreshOnInteraction, { passive: true });

    chartRef.current = chart;
    seriesRef.current = series;
    chartAliveRef.current = true;

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      container.removeEventListener("wheel", refreshOnInteraction);
      container.removeEventListener("pointermove", refreshOnInteraction);
      if (refreshFrameRef.current !== null) window.cancelAnimationFrame(refreshFrameRef.current);
      refreshFrameRef.current = null;
      markerPluginRef.current?.detach();
      markerPluginRef.current = null;
      if (chartGenerationRef.current === generation) {
        chartAliveRef.current = false;
        chartRef.current = null;
        seriesRef.current = null;
        renderedDataRef.current = [];
        renderedCandlesRef.current = [];
      }
      chart.remove();
    };
  }, [scheduleCoordinateRefresh]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chartAliveRef.current || !chart || !series) return;

    const previous = renderedDataRef.current;
    const previousCandles = renderedCandlesRef.current;
    const fitChanged = fittedTokenRef.current !== fitToken;
    const prefixProbe = Math.max(0, previousCandles.length - 2);
    const unchangedPrefix = !fitChanged && previousCandles.length > 0 && candles.length >= previousCandles.length &&
      previousCandles[0] === candles[0] && previousCandles[prefixProbe] === candles[prefixProbe];

    if (unchangedPrefix) {
      const start = Math.max(0, previous.length - 1);
      const next = previous.slice(0, start);
      for (let index = start; index < candles.length; index += 1) {
        const point = toChartCandle(candles[index], datasetStart);
        series.update(point);
        next.push(point);
        mutateFastForwardMetrics((metrics) => { metrics.incrementalUpdateCount += 1; });
      }
      renderedDataRef.current = next;
    } else {
      const displayData = candles.map((candle) => toChartCandle(candle, datasetStart));
      series.setData(displayData);
      mutateFastForwardMetrics((metrics) => { metrics.fullSetDataCount += 1; });
      renderedDataRef.current = displayData;
    }
    renderedCandlesRef.current = candles;
    if (fitChanged) {
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - visibleBars),
        to: candles.length + 6,
      });
      fittedTokenRef.current = fitToken;
    }
    scheduleCoordinateRefresh();
  }, [candles, datasetStart, fitToken, scheduleCoordinateRefresh, visibleBars]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!chartAliveRef.current || !series) return;

    markerPluginRef.current?.detach();
    markerPluginRef.current = null;

    const markers: SeriesMarker<Time>[] = [];
    if (fillTimestamp && plan && plan.direction !== "PASS") {
      markers.push({
        time: toDisplayTime(fillTimestamp, datasetStart),
        position: plan.direction === "LONG" ? "belowBar" : "aboveBar",
        color: "#d8dde2",
        shape: plan.direction === "LONG" ? "arrowUp" : "arrowDown",
        text: "入场",
      });
    }
    if (exitTimestamp && result) {
      markers.push({
        time: toDisplayTime(exitTimestamp, datasetStart),
        position: result.resultR >= 0 ? "aboveBar" : "belowBar",
        color: result.resultR >= 0 ? "#26a69a" : "#ef5350",
        shape: "circle",
        text: result.status,
      });
    }

    const markerPlugin = createSeriesMarkers(series, markers);
    markerPluginRef.current = markerPlugin;
    return () => {
      if (markerPluginRef.current !== markerPlugin || !chartAliveRef.current) return;
      markerPlugin.detach();
      markerPluginRef.current = null;
    };
  }, [datasetStart, exitTimestamp, fillTimestamp, plan, result]);

  useEffect(() => {
    if (chartAliveRef.current && !draggingRef.current) seriesRef.current?.priceScale().applyOptions({ autoScale: true });
    scheduleCoordinateRefresh();
  }, [plan, scheduleCoordinateRefresh]);

  function updatePrice(key: TradeLineKey, price: number) {
    const currentPlan = planRef.current;
    if (!currentPlan || currentPlan.direction === "PASS" || !onPlanChange) return;
    onPlanChange({ ...currentPlan, [key]: roundPrice(price) });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>, key: TradeLineKey) {
    if (!draggable) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = key;
    setDragging(key);
    chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const key = draggingRef.current;
    const series = seriesRef.current;
    const container = containerRef.current;
    if (!key || !series || !container) return;

    event.preventDefault();
    event.stopPropagation();
    const bounds = container.getBoundingClientRect();
    const coordinate = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    const price = series.coordinateToPrice(coordinate);
    if (price === null) return;
    setLineCoordinates((current) => ({ ...current, [key]: coordinate }));
    updatePrice(key, price);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    draggingRef.current = null;
    setDragging(null);
    chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
    scheduleCoordinateRefresh();
  }

  function handleLineKeyDown(event: React.KeyboardEvent<HTMLDivElement>, key: TradeLineKey) {
    if (!draggable || !plan || plan.direction === "PASS") return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : 0.01;
    const price = plan[key];
    if (price === undefined) return;
    updatePrice(key, price + (event.key === "ArrowUp" ? step : -step));
  }

  const ohlc = hovered ?? candles.at(-1) ?? null;
  const financials = plan ? calculatePlanFinancials(plan) : null;
  const positionWidth = positionCoordinates ? Math.max(2, positionCoordinates.endX - positionCoordinates.startX) : 0;
  const durationMinutes = positionStartTimestamp !== undefined && positionEndTimestamp !== undefined
    ? Math.max(0, Math.round((positionEndTimestamp - positionStartTimestamp) / 60))
    : 0;
  const entryY = lineCoordinates.entry;
  const stopY = lineCoordinates.stopLoss;
  const targetY = lineCoordinates.takeProfit;

  return (
    <div ref={containerRef} className="relative h-full min-h-[380px] overflow-hidden bg-[#0b0e11]">
      {ohlc ? (
        <div className="pointer-events-none absolute left-4 top-3 z-10 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-[#aab2ba]">
          <span>开 <b className="font-medium text-[#d8dde2]">{ohlc.open.toFixed(2)}</b></span>
          <span>高 <b className="font-medium text-[#26a69a]">{ohlc.high.toFixed(2)}</b></span>
          <span>低 <b className="font-medium text-[#ef5350]">{ohlc.low.toFixed(2)}</b></span>
          <span>收 <b className="font-medium text-[#d8dde2]">{ohlc.close.toFixed(2)}</b></span>
        </div>
      ) : null}

      <div ref={chartHostRef} className="absolute inset-0" aria-label="XAUUSD K线图" />

      {plan && plan.direction !== "PASS" && positionCoordinates && entryY !== undefined && stopY !== undefined && targetY !== undefined ? (
        <div
          className={`position-tool ${positionActive ? "position-tool--active" : "position-tool--pending"}`}
          style={{ left: positionCoordinates.startX, width: positionWidth }}
          aria-hidden="true"
        >
          <div className="position-tool__profit" style={{ top: Math.min(entryY, targetY), height: Math.max(1, Math.abs(entryY - targetY)) }} />
          <div className="position-tool__risk" style={{ top: Math.min(entryY, stopY), height: Math.max(1, Math.abs(entryY - stopY)) }} />
          {positionWidth > 76 ? <span className="position-tool__duration" style={{ top: Math.max(30, Math.min(entryY, stopY, targetY) + 5) }}>{durationMinutes}分</span> : null}
        </div>
      ) : null}

      {currentPrice !== undefined ? <div className="current-price-label">当前 <b>{currentPrice.toFixed(2)}</b></div> : null}

      {plan && plan.direction !== "PASS"
        ? (Object.keys(LINE_META) as TradeLineKey[]).map((key) => {
            const coordinate = lineCoordinates[key];
            const price = plan[key];
            if (coordinate === undefined || price === undefined) return null;
            const meta = LINE_META[key];
            const amount =
              key === "stopLoss"
                ? financials?.riskUsd
                : key === "takeProfit"
                  ? financials?.rewardUsd
                  : null;
            return (
              <div
                key={key}
                role="slider"
                tabIndex={draggable ? 0 : -1}
                aria-label={`${meta.label}价格`}
                aria-valuemin={0}
                aria-valuemax={100_000}
                aria-valuenow={price}
                aria-valuetext={price.toFixed(2)}
                aria-readonly={!draggable}
                className={`trade-line-zone group ${draggable ? "trade-line-zone--draggable" : ""} ${dragging === key ? "trade-line-zone--dragging" : ""}`}
                style={{ top: coordinate - 9, color: meta.color }}
                onPointerDown={(event) => handlePointerDown(event, key)}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => handleLineKeyDown(event, key)}
              >
                <span className="trade-line-rule" />
                <span className="trade-line-label">
                  <b>{meta.label}</b>
                  <span>{price.toFixed(2)}</span>
                  {amount !== null && amount !== undefined ? (
                    <strong>{formatSignedUsd(amount)}</strong>
                  ) : null}
                </span>
              </div>
            );
          })
        : null}
    </div>
  );
});

function toChartCandle(candle: Candle, datasetStart: number): CandlestickData<Time> {
  return {
    time: toDisplayTime(candle.timestamp, datasetStart),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

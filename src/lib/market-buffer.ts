import type { Candle } from "../types/market.ts";

export const INITIAL_AHEAD_BUFFER_MINUTES = 24 * 60;
export const MARKET_BUFFER_LOW_WATER_MINUTES = 6 * 60;
export const MARKET_BUFFER_REFILL_MINUTES = 24 * 60;
const MAX_RELEASED_HISTORY_CANDLES = 20_000;

export class MarketBuffer {
  private rows: Candle[] = [];
  private releasedRows: Candle[] = [];
  private through: number;
  private ended = false;

  constructor(currentTime: number) {
    this.through = currentTime;
  }

  get size(): number {
    return this.rows.length;
  }

  get authorizedThrough(): number {
    return this.through;
  }

  get datasetEnded(): boolean {
    return this.ended;
  }

  reset(currentTime: number): void {
    this.rows = [];
    this.releasedRows = [];
    this.through = currentTime;
    this.ended = false;
  }

  seedReleased(candles: Candle[]): number {
    const byTimestamp = new Map(this.releasedRows.map((candle) => [candle.timestamp, candle]));
    for (const candle of candles) {
      if (candle.timestamp <= this.through) byTimestamp.set(candle.timestamp, candle);
    }
    this.releasedRows = [...byTimestamp.values()]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_RELEASED_HISTORY_CANDLES);
    return this.releasedRows.length;
  }

  releasedSnapshot(end = Number.POSITIVE_INFINITY): Candle[] {
    return this.releasedRows.filter((candle) => candle.timestamp <= end);
  }

  append(candles: Candle[], authorizedThrough: number, noMoreData: boolean): number {
    const known = new Set(this.rows.map((candle) => candle.timestamp));
    for (const candle of candles) {
      if (candle.timestamp > this.through && !known.has(candle.timestamp)) {
        this.rows.push(candle);
        known.add(candle.timestamp);
      }
    }
    this.rows.sort((left, right) => left.timestamp - right.timestamp);
    this.through = Math.max(this.through, authorizedThrough, this.rows.at(-1)?.timestamp ?? this.through);
    this.ended = this.ended || noMoreData;
    return this.rows.length;
  }

  peekThrough(targetTime: number): Candle[] {
    let count = 0;
    while (count < this.rows.length && this.rows[count].timestamp <= targetTime) count += 1;
    return count ? this.rows.slice(0, count) : [];
  }

  discardThrough(targetTime: number): void {
    let count = 0;
    while (count < this.rows.length && this.rows[count].timestamp <= targetTime) count += 1;
    if (count) this.seedReleased(this.rows.splice(0, count));
  }

  takeThrough(targetTime: number): Candle[] {
    const candles = this.peekThrough(targetTime);
    this.discardThrough(targetTime);
    return candles;
  }

  shouldRefill(lowWater = MARKET_BUFFER_LOW_WATER_MINUTES): boolean {
    return !this.ended && this.rows.length < lowWater;
  }
}

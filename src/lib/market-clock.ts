export type MarketClockAdvance = {
  consumedSteps: number;
  targetTime: number;
  reachedDatasetEnd: boolean;
};

export class MarketClock {
  private time: number;
  private pending = 0;

  constructor(currentTime: number) {
    this.time = currentTime;
  }

  get currentTime(): number {
    return this.time;
  }

  get pendingSteps(): number {
    return this.pending;
  }

  reset(currentTime: number): void {
    this.time = currentTime;
    this.pending = 0;
  }

  enqueue(steps = 1): number {
    const safeSteps = Math.max(0, Math.trunc(steps));
    this.pending += safeSteps;
    return this.pending;
  }

  clearPending(): void {
    this.pending = 0;
  }

  preview(stepMinutes: number, authorizedThrough: number, datasetEnded: boolean): MarketClockAdvance | null {
    if (this.pending < 1 || authorizedThrough <= this.time) return null;
    const stepSeconds = Math.max(1, Math.trunc(stepMinutes)) * 60;
    const availableSeconds = authorizedThrough - this.time;
    let consumedSteps = Math.min(this.pending, Math.floor(availableSeconds / stepSeconds));
    if (!consumedSteps && datasetEnded) consumedSteps = 1;
    if (!consumedSteps) return null;
    const targetTime = Math.min(this.time + consumedSteps * stepSeconds, authorizedThrough);
    return {
      consumedSteps,
      targetTime,
      reachedDatasetEnd: datasetEnded && targetTime >= authorizedThrough,
    };
  }

  commit(advance: MarketClockAdvance, exactTime = advance.targetTime): void {
    this.time = Math.min(advance.targetTime, Math.max(this.time, exactTime));
    this.pending = Math.max(0, this.pending - advance.consumedSteps);
  }
}

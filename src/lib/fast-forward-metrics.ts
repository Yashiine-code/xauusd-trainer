export type FastForwardMetrics = {
  trainerRenderCount: number;
  fullSetDataCount: number;
  incrementalUpdateCount: number;
  bufferRefillCount: number;
  flushCount: number;
  consumedStepCount: number;
  maxFeedbackLatencyMs: number;
  longTaskCount: number;
  chartCreateCount: number;
};

const metricsGlobal = globalThis as typeof globalThis & {
  __fastForwardMetrics?: FastForwardMetrics;
};

function freshMetrics(): FastForwardMetrics {
  return {
    trainerRenderCount: 0,
    fullSetDataCount: 0,
    incrementalUpdateCount: 0,
    bufferRefillCount: 0,
    flushCount: 0,
    consumedStepCount: 0,
    maxFeedbackLatencyMs: 0,
    longTaskCount: 0,
    chartCreateCount: 0,
  };
}

export function resetFastForwardMetrics(): void {
  metricsGlobal.__fastForwardMetrics = freshMetrics();
}

export function mutateFastForwardMetrics(update: (metrics: FastForwardMetrics) => void): void {
  const metrics = metricsGlobal.__fastForwardMetrics ??= freshMetrics();
  update(metrics);
}

export function snapshotFastForwardMetrics(): FastForwardMetrics {
  return { ...(metricsGlobal.__fastForwardMetrics ??= freshMetrics()) };
}

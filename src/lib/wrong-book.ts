import type { Timeframe } from "../types/market";

export type WrongBookSaveInput = {
  image: Blob | HTMLCanvasElement;
  productSessionId: string;
  trainingSessionId: string;
  timeframe: Timeframe;
  revealStartTime: number;
  revealEndTime: number;
};

type SaveResult = { timings?: { uploadMs?: number; dbMs?: number; totalMs?: number }; duplicate?: boolean };

function canvasBlob(canvas: HTMLCanvasElement, type = "image/webp", quality = 0.84): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Chart encoding failed.")), type, quality));
}

async function compressChartImage(source: Blob | HTMLCanvasElement, maxWidth: number, quality: number): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return source instanceof Blob ? source : canvasBlob(source, "image/webp", quality);
  }
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return source instanceof Blob ? source : canvasBlob(source, "image/webp", quality);
    context.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/webp", quality });
  } finally { bitmap.close(); }
}

async function saveOnce(input: WrongBookSaveInput): Promise<SaveResult> {
  const [image, thumbnail] = await Promise.all([
    compressChartImage(input.image, 1600, 0.84),
    compressChartImage(input.image, 560, 0.76),
  ]);
  const form = new FormData();
  form.set("image", image, "chart.webp");
  form.set("thumbnail", thumbnail, "chart-thumbnail.webp");
  form.set("productSessionId", input.productSessionId);
  form.set("trainingSessionId", input.trainingSessionId);
  form.set("timeframe", input.timeframe);
  form.set("revealStartTime", String(input.revealStartTime));
  form.set("revealEndTime", String(input.revealEndTime));
  const response = await fetch("/api/wrong-book", { method: "POST", body: form });
  const result = await response.json() as SaveResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "错题保存失败，可稍后重试。");
  return result;
}

export function enqueueWrongBookSave(
  input: WrongBookSaveInput,
  handlers: { onSaved?: (result: SaveResult) => void; onFailed?: (retry: () => void) => void } = {},
): void {
  let attempts = 0;
  const run = () => {
    attempts += 1;
    void saveOnce(input).then((result) => handlers.onSaved?.(result)).catch(() => {
      if (attempts < 2) {
        window.setTimeout(run, 700 * attempts);
        return;
      }
      handlers.onFailed?.(() => {
        attempts = 0;
        run();
      });
    });
  };
  run();
}

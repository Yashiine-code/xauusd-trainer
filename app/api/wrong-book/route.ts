import { attachRefreshedCookies, getAuthenticatedUser } from "../../../src/server/auth";
import { withPersistenceRequest } from "../../../src/server/persistence/request-scope";
import { completeWrongBookImage, listWrongBookEntries, reserveWrongBookEntry, serializeWrongBook } from "../../../src/server/wrong-book/repository";
import { uploadWrongBookImage } from "../../../src/server/wrong-book/storage";
import type { Timeframe } from "../../../src/types/market";

const TIMEFRAMES = new Set<Timeframe>(["1H", "15m", "5m", "3m", "1m"]);

async function authenticate(request: Request) {
  const auth = await getAuthenticatedUser(request);
  return auth?.accessStatus === "active" ? auth : null;
}

async function get(request: Request) {
  try {
    const auth = await authenticate(request);
    if (!auth) return Response.json({ error: "请先登录。" }, { status: 403 });
    const requested = Number(new URL(request.url).searchParams.get("page") ?? 1);
    const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
    const { rows, total } = await listWrongBookEntries(auth.user.id, page);
    return attachRefreshedCookies(Response.json({ entries: rows.map(serializeWrongBook), page, pageSize: 20, total }), auth.refreshed);
  } catch (cause) {
    console.error("WRONG_BOOK_LIST_FAILURE", cause instanceof Error ? cause.message : "unknown");
    return Response.json({ error: "读取错题本失败。" }, { status: 503 });
  }
}

async function post(request: Request) {
  const started = performance.now();
  try {
    const auth = await authenticate(request);
    if (!auth) return Response.json({ error: "请先登录。" }, { status: 403 });
    const form = await request.formData();
    const image = form.get("image");
    const thumbnail = form.get("thumbnail");
    const productSessionId = String(form.get("productSessionId") ?? "");
    const trainingSessionId = String(form.get("trainingSessionId") ?? "");
    const timeframe = String(form.get("timeframe") ?? "") as Timeframe;
    const revealStartTime = Number(form.get("revealStartTime"));
    const revealEndTime = Number(form.get("revealEndTime"));
    if (!(image instanceof File) || !(thumbnail instanceof File) || image.size < 1 || image.size > 5_000_000 || thumbnail.size < 1 || thumbnail.size > 1_000_000 || !image.type.startsWith("image/") || !thumbnail.type.startsWith("image/")) {
      return Response.json({ error: "错题截图无效。" }, { status: 400 });
    }
    if (!productSessionId || !trainingSessionId || !TIMEFRAMES.has(timeframe) || !Number.isFinite(revealStartTime) || !Number.isFinite(revealEndTime)) {
      return Response.json({ error: "错题信息无效。" }, { status: 400 });
    }
    const reserved = await reserveWrongBookEntry({ userId: auth.user.id, productSessionId, trainingSessionId, timeframe, revealStartTime, revealEndTime });
    if (reserved.alreadyUploaded) {
      return attachRefreshedCookies(Response.json({ entry: serializeWrongBook(reserved.row), duplicate: true, timings: { totalMs: performance.now() - started } }), auth.refreshed);
    }
    const path = `${auth.user.id}/${reserved.row.id}.webp`;
    const thumbnailPath = `${auth.user.id}/${reserved.row.id}-thumb.webp`;
    const uploadStarted = performance.now();
    await Promise.all([uploadWrongBookImage(path, image), uploadWrongBookImage(thumbnailPath, thumbnail)]);
    const uploadMs = performance.now() - uploadStarted;
    const dbStarted = performance.now();
    const row = await completeWrongBookImage(auth.user.id, reserved.row.id, path, thumbnailPath, { contentType: image.type, bytes: image.size, thumbnailBytes: thumbnail.size });
    const dbMs = performance.now() - dbStarted;
    return attachRefreshedCookies(Response.json({ entry: serializeWrongBook(row), timings: { uploadMs, dbMs, totalMs: performance.now() - started } }), auth.refreshed);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown";
    console.error("WRONG_BOOK_SAVE_FAILURE", JSON.stringify({ message, totalMs: performance.now() - started }));
    return Response.json({ error: "错题保存失败，可稍后重试。" }, { status: message.includes("not eligible") ? 409 : 503 });
  }
}

export function GET(request: Request) { return withPersistenceRequest(() => get(request)); }
export function POST(request: Request) { return withPersistenceRequest(() => post(request)); }

import { attachRefreshedCookies, getAuthenticatedUser } from "../../../../src/server/auth";
import { withPersistenceRequest } from "../../../../src/server/persistence/request-scope";
import { getWrongBookEntry, serializeWrongBook, updateWrongBookReview, WRONG_BOOK_TAGS } from "../../../../src/server/wrong-book/repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function active(request: Request) {
  const auth = await getAuthenticatedUser(request);
  return auth?.accessStatus === "active" ? auth : null;
}

async function get(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await active(request);
    if (!auth) return Response.json({ error: "请先登录。" }, { status: 403 });
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "错题不存在。" }, { status: 404 });
    const row = await getWrongBookEntry(auth.user.id, id);
    if (!row) return Response.json({ error: "错题不存在。" }, { status: 404 });
    return attachRefreshedCookies(Response.json({ entry: serializeWrongBook(row) }), auth.refreshed);
  } catch { return Response.json({ error: "读取错题失败。" }, { status: 503 }); }
}

async function patch(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await active(request);
    if (!auth) return Response.json({ error: "请先登录。" }, { status: 403 });
    const { id } = await context.params;
    if (!UUID.test(id)) return Response.json({ error: "错题不存在。" }, { status: 404 });
    const body = await request.json() as { note?: unknown; tags?: unknown };
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 5000) : "";
    const tags = Array.isArray(body.tags) ? [...new Set(body.tags.filter((tag): tag is string => typeof tag === "string" && (WRONG_BOOK_TAGS as readonly string[]).includes(tag)))].slice(0, 7) : [];
    const row = await updateWrongBookReview(auth.user.id, id, note, tags);
    if (!row) return Response.json({ error: "错题不存在。" }, { status: 404 });
    return attachRefreshedCookies(Response.json({ entry: serializeWrongBook(row) }), auth.refreshed);
  } catch { return Response.json({ error: "保存复盘失败。" }, { status: 503 }); }
}

export function GET(request: Request, context: { params: Promise<{ id: string }> }) { return withPersistenceRequest(() => get(request, context)); }
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { return withPersistenceRequest(() => patch(request, context)); }


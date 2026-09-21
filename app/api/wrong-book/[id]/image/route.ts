import { getAuthenticatedUser } from "../../../../../src/server/auth";
import { withPersistenceRequest } from "../../../../../src/server/persistence/request-scope";
import { getWrongBookEntry } from "../../../../../src/server/wrong-book/repository";
import { downloadWrongBookImage } from "../../../../../src/server/wrong-book/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function get(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth || auth.accessStatus !== "active") return new Response(null, { status: 403 });
  const { id } = await context.params;
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  const row = await getWrongBookEntry(auth.user.id, id);
  if (!row?.screenshot_path) return new Response(null, { status: 404 });
  const useThumbnail = new URL(request.url).searchParams.get("size") === "thumbnail";
  const stored = await downloadWrongBookImage(useThumbnail && row.thumbnail_path ? row.thumbnail_path : row.screenshot_path);
  if (!stored.ok || !stored.body) return new Response(null, { status: 502 });
  return new Response(stored.body, {
    headers: {
      "Content-Type": stored.headers.get("Content-Type") ?? "image/webp",
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withPersistenceRequest(() => get(request, context));
}

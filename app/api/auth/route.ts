import { getAuthenticatedUser, signIn, signOut, signUp, attachRefreshedCookies, AuthRateLimitError, AuthSignupError } from "../../../src/server/auth.ts";
import { withPersistenceRequest } from "../../../src/server/persistence/request-scope.ts";

async function get(request: Request) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth) return Response.json({ user: null, accessStatus: null }, { status: 401 });
    return attachRefreshedCookies(Response.json({ user: auth.user, accessStatus: auth.accessStatus }), auth.refreshed);
  } catch {
    return Response.json({ error: "认证服务暂时不可用。" }, { status: 503 });
  }
}

async function post(request: Request) {
  let payload: { action?: string; email?: string; password?: string };
  try { payload = await request.json(); } catch { return Response.json({ error: "请求格式无效。" }, { status: 400 }); }
  if (payload.action === "signout") return signOut(request);
  if (payload.action !== "signup" && payload.action !== "signin") return Response.json({ error: "不支持的操作。" }, { status: 400 });
  const email = payload.email?.trim().toLowerCase() ?? "";
  const password = payload.password ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "请输入有效的邮箱地址。" }, { status: 400 });
  if (password.length < 8) return Response.json({ error: "密码至少需要 8 位。" }, { status: 400 });
  if (password.length > 128) return Response.json({ error: "密码不能超过 128 位。" }, { status: 400 });
  try {
    if (payload.action === "signin") return await signIn(email, password);
    return await signUp(email, password);
  } catch (cause) {
    if (cause instanceof AuthRateLimitError) return Response.json({ error: cause.message }, { status: 429 });
    if (cause instanceof AuthSignupError) return Response.json({ error: cause.message }, { status: cause.status });
    return Response.json({ error: "认证服务暂时不可用。" }, { status: 503 });
  }
}

export function GET(request: Request) { return withPersistenceRequest(() => get(request)); }
export function POST(request: Request) { return withPersistenceRequest(() => post(request)); }

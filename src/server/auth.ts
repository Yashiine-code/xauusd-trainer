import { getAccessStatus, upsertUser, type AccessStatus } from "./auth-user-store.ts";
import { timedPhase } from "./persistence/request-scope.ts";

const ACCESS_COOKIE = "xau_access";
const REFRESH_COOKIE = "xau_refresh";

type AuthUser = { id: string; email?: string };
type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; user: AuthUser };

export class AuthRateLimitError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super("操作过于频繁，请稍后再试。");
    this.status = status;
    this.code = code;
  }
}

export class AuthSignupError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class AuthUpstreamError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly upstreamCode: string;

  constructor(endpoint: string, status: number, upstreamCode: string) {
    super(`Supabase Auth ${endpoint} returned ${status} (${upstreamCode}).`);
    this.endpoint = endpoint;
    this.status = status;
    this.upstreamCode = upstreamCode;
  }
}

function failureCode(cause: unknown): string {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") return cause.code;
  return cause instanceof Error ? cause.name : "unknown";
}

function authConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase Auth is not configured.");
  return { url: url.replace(/\/$/, ""), key };
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const { url, key } = authConfig();
  try {
    const response = await fetch(`${url}/auth/v1/${path}`, {
      ...init,
      headers: { apikey: key, "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 500) {
      const payload = await response.clone().json().catch(() => ({})) as { error_code?: string; code?: string };
      const endpoint = path.split("?")[0];
      const code = payload.error_code ?? payload.code ?? "unknown";
      console.error("AUTH_UPSTREAM_HTTP", JSON.stringify({ endpoint, status: response.status, code }));
      throw new AuthUpstreamError(endpoint, response.status, code);
    }
    return response;
  } catch (cause) {
    if (!(cause instanceof AuthUpstreamError)) console.error("AUTH_UPSTREAM_NETWORK", JSON.stringify({ endpoint: path.split("?")[0], code: failureCode(cause) }));
    throw cause;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const pair = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

function setSessionCookies(response: Response, tokens: TokenResponse) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${ACCESS_COOKIE}=${encodeURIComponent(tokens.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(60, tokens.expires_in)}${secure}`);
  response.headers.append("Set-Cookie", `${REFRESH_COOKIE}=${encodeURIComponent(tokens.refresh_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

export function clearSessionCookies(response: Response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${ACCESS_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
  response.headers.append("Set-Cookie", `${REFRESH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

export async function signUp(email: string, password: string): Promise<Response> {
  const response = await authFetch("signup", { method: "POST", body: JSON.stringify({ email, password }) });
  if (response.status === 429) {
    const payload = await response.json().catch(() => ({})) as { error_code?: string };
    throw new AuthRateLimitError(429, payload.error_code ?? "rate_limit");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { code?: string; error_code?: string };
    const code = payload.error_code ?? payload.code;
    if (code === "user_already_exists" || code === "email_exists") throw new AuthSignupError(409, "该邮箱已注册，请直接登录。");
    if (code === "weak_password") throw new AuthSignupError(400, "密码强度不足，请使用更安全的密码。");
    if (code === "email_address_invalid" || code === "invalid_email") throw new AuthSignupError(400, "邮箱格式无效，请检查后重试。");
    if (code === "signup_disabled" || code === "email_provider_disabled") throw new AuthSignupError(503, "邮箱注册暂未开放。");
    throw new AuthSignupError(response.status >= 500 ? 503 : 400, "注册失败，请检查邮箱和密码后重试。");
  }
  // GoTrue returns tokens at the top level when email confirmation is off.
  // The nested session form is accepted too, without a second login request.
  const payload = await response.json() as Partial<TokenResponse> & { session?: TokenResponse | null };
  const tokens = payload.session?.access_token ? payload.session : payload.access_token ? payload as TokenResponse : null;
  if (!tokens) {
    if (!payload.user?.id) throw new Error("Invalid signup response.");
    // Retain this branch for a future return to confirmed-email signups.
    return Response.json({ needsConfirmation: true }, { status: 202 });
  }
  if (!tokens.user?.id || !tokens.access_token || !tokens.refresh_token) throw new Error("Invalid signup session.");
  let accessStatus: AccessStatus;
  try { accessStatus = await upsertUser(tokens.user.id); }
  catch (cause) {
    console.error("AUTH_SIGNUP_PERSISTENCE", JSON.stringify({ code: failureCode(cause) }));
    throw cause;
  }
  if (accessStatus !== "active") return Response.json({ error: "此账号的访问权限已暂停。", accessStatus }, { status: 403 });
  const result = Response.json({ user: { id: tokens.user.id, email: tokens.user.email }, accessStatus, needsConfirmation: false });
  setSessionCookies(result, tokens);
  return result;
}

export async function signIn(email: string, password: string): Promise<Response> {
  const response = await authFetch("token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!response.ok) return Response.json({ error: "邮箱或密码不正确，或邮箱尚未验证。" }, { status: 401 });
  const tokens = await response.json() as TokenResponse;
  if (!tokens.user?.id || !tokens.access_token || !tokens.refresh_token) return Response.json({ error: "登录响应无效。" }, { status: 502 });
  let accessStatus: AccessStatus;
  try { accessStatus = await upsertUser(tokens.user.id); }
  catch (cause) {
    console.error("AUTH_SIGNIN_PERSISTENCE", JSON.stringify({ code: failureCode(cause) }));
    throw cause;
  }
  const result = Response.json({ user: { id: tokens.user.id, email: tokens.user.email }, accessStatus });
  setSessionCookies(result, tokens);
  return result;
}

async function getUserWithToken(token: string): Promise<AuthUser | null> {
  const response = await authFetch("user", { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const user = await response.json() as AuthUser;
  return user.id ? user : null;
}

export async function getAuthenticatedUser(request: Request): Promise<{ user: AuthUser; accessStatus: AccessStatus; refreshed?: TokenResponse } | null> {
  let stage = "user_validation";
  const counts = { userRequests: 0, refreshRequests: 0, accessStatusReads: 0 };
  try {
  let accessToken = cookieValue(request, ACCESS_COOKIE);
  if (accessToken) counts.userRequests++;
  let user = accessToken ? await timedPhase("AUTH_VERIFICATION", () => getUserWithToken(accessToken!)) : null;
  let refreshed: TokenResponse | undefined;
  if (!user) {
    const refreshToken = cookieValue(request, REFRESH_COOKIE);
    if (!refreshToken) return null;
    stage = "token_refresh";
    counts.refreshRequests++;
    const response = await timedPhase("AUTH_TOKEN_REFRESH", () => authFetch("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) }));
    if (!response.ok) return null;
    refreshed = await response.json() as TokenResponse;
    accessToken = refreshed.access_token;
    stage = "refreshed_user_validation";
    if (accessToken) counts.userRequests++;
    user = accessToken ? await timedPhase("AUTH_VERIFICATION_AFTER_REFRESH", () => getUserWithToken(accessToken!)) : null;
  }
  if (!user) return null;
  stage = "access_status_read";
  counts.accessStatusReads++;
  const accessStatus = await timedPhase("ACCESS_STATUS_CHECK", async () => await getAccessStatus(user.id) ?? await upsertUser(user.id));
  if (process.env.PHASE2_AUTH_DIAGNOSTICS === "true") {
    console.info("AUTH_REQUEST_COUNTS", JSON.stringify({ endpoint: new URL(request.url).pathname, ...counts }));
  }
  return { user, accessStatus, refreshed };
  } catch (cause) {
    console.error("AUTH_SESSION_FAILURE", JSON.stringify({ endpoint: new URL(request.url).pathname, stage, code: failureCode(cause), ...counts }));
    throw cause;
  }
}

export function attachRefreshedCookies(response: Response, refreshed?: TokenResponse): Response {
  if (refreshed) setSessionCookies(response, refreshed);
  return response;
}

export async function signOut(request: Request): Promise<Response> {
  const token = cookieValue(request, ACCESS_COOKIE);
  if (token) await authFetch("logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  const response = Response.json({ signedOut: true });
  clearSessionCookies(response);
  return response;
}

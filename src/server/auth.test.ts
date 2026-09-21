import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthRateLimitError, getAuthenticatedUser, signUp } from "./auth.ts";
import { POST as authPost } from "../../app/api/auth/route.ts";

function signupRequest(password = "safe-password-123") {
  return new Request("http://localhost/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "signup", email: "new@example.com", password }),
  });
}

test("signup with auto-confirm returns a login session and creates an active profile", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const paths: string[] = [];
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-only-key";
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/auth/v1/signup") return Response.json({
        user: { id: "test-user-id", email: "new@example.com" },
        access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600,
      });
      if (path === "/rest/v1/users") {
        assert.deepEqual(JSON.parse(String(init?.body)), { user_id: "test-user-id" });
        return Response.json([{ access_status: "active" }]);
      }
      throw new Error(`Unexpected fetch ${path}`);
    };
    const response = await authPost(signupRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { user: { id: "test-user-id", email: "new@example.com" }, accessStatus: "active", needsConfirmation: false });
    assert.equal(response.headers.getSetCookie().length, 2);
    assert.deepEqual(paths, ["/auth/v1/signup", "/rest/v1/users"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  }
});

test("suspended profile does not receive login cookies after signup", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-only-key";
    globalThis.fetch = async (input) => new URL(String(input)).pathname === "/auth/v1/signup"
      ? Response.json({ user: { id: "test-user-id" }, access_token: "access", refresh_token: "refresh", expires_in: 3600 })
      : Response.json([{ access_status: "suspended" }]);
    const response = await authPost(signupRequest());
    assert.equal(response.status, 403);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.match(((await response.json()) as { error: string }).error, /暂停/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  }
});

test("confirmation-enabled signup retains the future email verification path", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let requests = 0;
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    globalThis.fetch = async () => { requests++; return Response.json({ user: { id: "unconfirmed-user" } }); };
    const response = await authPost(signupRequest());
    assert.equal(response.status, 202);
    assert.equal(((await response.json()) as { needsConfirmation: boolean }).needsConfirmation, true);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});

test("signup validation and duplicate-email errors are in Chinese", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let requests = 0;
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    globalThis.fetch = async () => { requests++; return Response.json({ code: "user_already_exists" }, { status: 422 }); };
    const short = await authPost(signupRequest("short"));
    assert.equal(short.status, 400);
    assert.match(((await short.json()) as { error: string }).error, /至少需要 8 位/);
    assert.equal(requests, 0);
    const duplicate = await authPost(signupRequest());
    assert.equal(duplicate.status, 409);
    assert.match(((await duplicate.json()) as { error: string }).error, /该邮箱已注册/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});

test("one signup action makes exactly one Auth request and preserves the mail rate limit", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let requests = 0;
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    globalThis.fetch = async () => {
      requests++;
      return Response.json({ error_code: "over_email_send_rate_limit" }, { status: 429 });
    };
    await assert.rejects(signUp("test@example.com", "test-password-123"), (cause) =>
      cause instanceof AuthRateLimitError && cause.status === 429 && cause.code === "over_email_send_rate_limit");
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});

test("Auth /user 503 is not mistaken for an expired token or followed by refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const paths: string[] = [];
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    globalThis.fetch = async (input) => {
      paths.push(String(input));
      return Response.json({ error_code: "service_unavailable" }, { status: 503 });
    };
    await assert.rejects(getAuthenticatedUser(new Request("http://localhost/api/sessions", {
      headers: { Cookie: "xau_access=test-token; xau_refresh=test-refresh" },
    })), /Supabase Auth user returned 503/);
    assert.deepEqual(paths, ["https://example.supabase.co/auth/v1/user"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  }
});

test("one protected operation validates identity and access status once without refreshing", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const paths: string[] = [];
  try {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-only-key";
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/auth/v1/user") return Response.json({ id: "test-user-id" });
      if (path === "/rest/v1/users") return Response.json([{ access_status: "active" }]);
      throw new Error(`Unexpected fetch ${path}`);
    };
    const auth = await getAuthenticatedUser(new Request("http://localhost/api/sessions", {
      headers: { Cookie: "xau_access=test-token; xau_refresh=test-refresh" },
    }));
    assert.equal(auth?.accessStatus, "active");
    assert.deepEqual(paths, ["/auth/v1/user", "/rest/v1/users"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  }
});

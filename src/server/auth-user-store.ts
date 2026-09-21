export type AccessStatus = "active" | "suspended";

async function userStoreRequest(path: string, init: RequestInit): Promise<Response> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Server-side user store is not configured.");
  return fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function getAccessStatus(userId: string): Promise<AccessStatus | null> {
  if (process.env.PHASE2_AUTH_DIAGNOSTICS === "true") console.info("ACCESS_STATUS_READ", JSON.stringify({ count: 1, transport: "supabase_http" }));
  const response = await userStoreRequest(`users?user_id=eq.${encodeURIComponent(userId)}&select=access_status&limit=1`, { method: "GET" });
  if (!response.ok) throw new Error(`Access status read failed (${response.status}).`);
  const rows = await response.json() as { access_status: AccessStatus }[];
  return rows[0]?.access_status ?? null;
}

export async function upsertUser(userId: string): Promise<AccessStatus> {
  const response = await userStoreRequest("users?on_conflict=user_id&select=access_status", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!response.ok) throw new Error(`User profile upsert failed (${response.status}).`);
  const rows = await response.json() as { access_status: AccessStatus }[];
  if (!rows[0]?.access_status) throw new Error("User profile response is missing access status.");
  return rows[0].access_status;
}

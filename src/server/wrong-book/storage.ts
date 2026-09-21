const BUCKET = "wrong-book";

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Wrong Book storage is not configured.");
  return { url, key };
}

function headers(contentType?: string): HeadersInit {
  const { key } = config();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

export async function uploadWrongBookImage(path: string, image: Blob): Promise<void> {
  const { url } = config();
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { ...headers(image.type || "image/webp"), "x-upsert": "true", "Cache-Control": "max-age=31536000" },
    body: image,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Wrong Book upload failed (${response.status}).`);
}

export async function downloadWrongBookImage(path: string): Promise<Response> {
  const { url } = config();
  return fetch(`${url}/storage/v1/object/authenticated/${BUCKET}/${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
}


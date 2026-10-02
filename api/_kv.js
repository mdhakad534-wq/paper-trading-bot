const BASE = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

function assertConfigured() {
  if (!BASE || !TOKEN) throw new Error("Redis is not configured -- KV_REST_API_URL / KV_REST_API_TOKEN env vars are missing.");
}

export async function kvGet(key) {
  assertConfigured();
  const res = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Redis GET failed: ${res.status}`);
  const data = await res.json();
  return data.result ?? null;
}

export async function kvSet(key, value) {
  assertConfigured();
  const res = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
    body: value,
  });
  if (!res.ok) throw new Error(`Redis SET failed: ${res.status}`);
  return true;
}

export async function kvGetJSON(key, fallback) {
  const raw = await kvGet(key);
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function kvSetJSON(key, value) {
  return kvSet(key, JSON.stringify(value));
}

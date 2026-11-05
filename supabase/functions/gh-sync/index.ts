// Pulls Fitbit data from the Google Health API: sleep, resting heart rate, heart rate
// variability, steps and active calories. Runs hourly and when the app is opened.
// Each response is stored raw in google_raw; buildEntries() turns it into timeline entries.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const API = "https://health.googleapis.com/v4/users/me/dataTypes";
const COOLDOWN_MS = 10 * 60_000;
const FIRST_DAYS = 60; // first import reaches back two months
const NORMAL_DAYS = 4; // later runs re-read a few days so late-arriving data is caught

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const civil = (d: Date) => ({ date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } });

async function freshToken(admin: any, row: any) {
  if (new Date(row.expires_at).getTime() - Date.now() > 120_000) return row.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? "reconnect" : `token refresh failed (${res.status})`);
  const t = await res.json();
  await admin.from("oauth_tokens").update({
    access_token: t.access_token,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("user_id", row.user_id).eq("provider", "google_health");
  return t.access_token;
}

/* ---------- fetchers: each returns the list of raw responses it stored ---------- */
async function store(admin: any, userId: string, dataType: string, res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  await admin.from("google_raw").insert({
    user_id: userId, data_type: dataType, status: res.status,
    response: body, response_text: body === null ? text.slice(0, 20000) : null,
  });
  if (!res.ok) throw new Error(`${dataType}: ${res.status} ${text.slice(0, 200)}`);
  return body;
}

async function listAll(admin: any, userId: string, token: string, dataType: string, filter: string, pageSize: number) {
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const url = new URL(`${API}/${dataType}/dataPoints`);
    url.searchParams.set("filter", filter);
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await store(admin, userId, dataType, await fetch(url, { headers: { Authorization: `Bearer ${token}` } }));
    pageToken = body?.nextPageToken || "";
    if (!pageToken) break;
  }
}

async function dailyRollUp(admin: any, userId: string, token: string, dataType: string, from: Date, to: Date) {
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${API}/${dataType}/dataPoints:dailyRollUp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ range: { start: civil(from), end: civil(to) }, windowSizeDays: 1, pageSize: 90, ...(pageToken ? { pageToken } : {}) }),
    });
    const body = await store(admin, userId, dataType, res);
    pageToken = body?.nextPageToken || "";
    if (!pageToken) break;
  }
}

/* ---------- turn stored responses into timeline entries ---------- */
// Filled in once the real response shapes have been checked.
async function buildEntries(_admin: any, _userId: string) {
  return 0;
}

async function syncUser(admin: any, row: any, conn: any) {
  const token = await freshToken(admin, row);
  const days = conn?.cursor ? NORMAL_DAYS : FIRST_DAYS;
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const errors: string[] = [];
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { errors.push((e as Error).message); } };

  await run(() => listAll(admin, row.user_id, token, "sleep", `sleep.interval.end_time >= "${from.toISOString()}"`, 25));
  await run(() => listAll(admin, row.user_id, token, "daily-resting-heart-rate", `daily_resting_heart_rate.date >= "${ymd(from)}"`, 100));
  await run(() => listAll(admin, row.user_id, token, "daily-heart-rate-variability", `daily_heart_rate_variability.date >= "${ymd(from)}"`, 100));
  await run(() => dailyRollUp(admin, row.user_id, token, "steps", from, to));
  await run(() => dailyRollUp(admin, row.user_id, token, "active-energy-burned", from, to));

  const entries = await buildEntries(admin, row.user_id);
  return { entries, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: tokens } = await admin.from("oauth_tokens").select("*").eq("provider", "google_health");
  const results: any[] = [];
  for (const row of tokens || []) {
    const { data: conn } = await admin.from("connections").select("*")
      .eq("user_id", row.user_id).eq("provider", "google_health").maybeSingle();
    if (conn?.last_sync_at && Date.now() - new Date(conn.last_sync_at).getTime() < COOLDOWN_MS) {
      results.push({ skipped: "recent" });
      continue;
    }
    await admin.from("connections").update({ last_sync_at: new Date().toISOString() })
      .eq("user_id", row.user_id).eq("provider", "google_health");
    try {
      const r = await syncUser(admin, row, conn);
      await admin.from("connections").update({
        status: "connected", cursor: Math.floor(Date.now() / 1000),
        last_sync_at: new Date().toISOString(),
        last_error: r.errors.length ? r.errors.join(" | ").slice(0, 1000) : null,
      }).eq("user_id", row.user_id).eq("provider", "google_health");
      results.push(r);
    } catch (e) {
      const msg = (e as Error).message;
      await admin.from("connections").update({
        status: msg === "reconnect" ? "needs_reconnect" : "error",
        last_error: msg === "reconnect" ? "Google Health access expired. Connect again." : msg,
      }).eq("user_id", row.user_id).eq("provider", "google_health");
      results.push({ error: msg });
    }
  }
  return json({ results });
});

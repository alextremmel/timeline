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
const offsetSec = (o?: string) => (o ? parseInt(o, 10) || 0 : 0); // "-18000s" -> -18000
const localDate = (iso: string, off: string) => new Date(new Date(iso).getTime() + offsetSec(off) * 1000).toISOString().slice(0, 10);
const civilYmd = (d: any) => d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;
function hm(min: number) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
function clockAt(iso: string, off: string) {
  const d = new Date(new Date(iso).getTime() + offsetSec(off) * 1000);
  let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}
// UTC instant for a local wall-clock time on a date in an IANA time zone
function zonedInstant(ymdStr: string, hh: number, mm: number, tz: string) {
  const guess = new Date(`${ymdStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(guess).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

async function buildEntries(admin: any, userId: string) {
  const { data: raws } = await admin.from("google_raw").select("id, data_type, response")
    .eq("user_id", userId).eq("status", 200).is("processed_at", null).order("id");
  if (!raws?.length) return 0;

  const { data: lastMine } = await admin.from("entries").select("tz").eq("user_id", userId)
    .eq("source", "me").not("tz", "is", null).order("ts", { ascending: false }).limit(1);
  const tz = lastMine?.[0]?.tz || "America/New_York";

  const sleeps = new Map<string, any>();
  const rhr = new Map<string, number>();
  const hrv = new Map<string, any>();
  const days = new Map<string, { steps?: number; activeCal?: number }>();
  for (const r of raws) {
    const body = r.response || {};
    for (const p of body.dataPoints || []) {
      if (p.sleep) sleeps.set(p.name || p.sleep.interval?.startTime, p);
      if (p.dailyRestingHeartRate) { const d = civilYmd(p.dailyRestingHeartRate.date); if (d) rhr.set(d, Number(p.dailyRestingHeartRate.beatsPerMinute)); }
      if (p.dailyHeartRateVariability) { const d = civilYmd(p.dailyHeartRateVariability.date); if (d) hrv.set(d, p.dailyHeartRateVariability); }
    }
    for (const p of body.rollupDataPoints || []) {
      const d = civilYmd(p.civilStartTime?.date); if (!d) continue;
      const day = days.get(d) || {};
      if (p.steps) day.steps = Number(p.steps.countSum || 0);
      if (p.activeEnergyBurned) day.activeCal = Number(p.activeEnergyBurned.kcalSum || 0);
      days.set(d, day);
    }
  }

  const rows: any[] = [];
  // Sleep: one entry at wake-up time, with that morning's resting HR and HRV
  for (const [key, p] of sleeps) {
    const s = p.sleep, iv = s.interval || {}, sum = s.summary || {};
    if (!iv.startTime || !iv.endTime) continue;
    const wakeDate = localDate(iv.endTime, iv.endUtcOffset);
    const stage = (t: string) => Number((sum.stagesSummary || []).find((x: any) => x.type === t)?.minutes || 0);
    const asleep = Number(sum.minutesAsleep || 0);
    const main = s.metadata?.mainSleep !== false;
    const line1 = `${main ? "Sleep" : "Nap"} · ${hm(asleep)} asleep (${clockAt(iv.startTime, iv.startUtcOffset)}–${clockAt(iv.endTime, iv.endUtcOffset)})`;
    const stageBits = [["Deep", "DEEP"], ["REM", "REM"], ["Light", "LIGHT"], ["Awake", "AWAKE"]]
      .filter(([, t]) => stage(t) > 0).map(([label, t]) => `${label} ${hm(stage(t))}`);
    const vitals: string[] = [];
    if (main && rhr.has(wakeDate)) vitals.push(`resting HR ${rhr.get(wakeDate)}`);
    if (main && hrv.has(wakeDate)) vitals.push(`HRV ${Math.round(hrv.get(wakeDate).averageHeartRateVariabilityMilliseconds)} ms`);
    rows.push({
      user_id: userId, ts: iv.endTime, tz, source: "google_health",
      source_id: `sleep:${String(key).split("/").pop()}`,
      body: [line1, stageBits.join(" · "), vitals.join(" · ")].filter(Boolean).join("\n"),
      details: {
        kind: main ? "sleep" : "nap", wake_date: wakeDate,
        start: iv.startTime, end: iv.endTime, utc_offset: iv.endUtcOffset,
        minutes_asleep: asleep, minutes_awake: Number(sum.minutesAwake || 0), minutes_in_period: Number(sum.minutesInSleepPeriod || 0),
        stages_minutes: Object.fromEntries((sum.stagesSummary || []).map((x: any) => [x.type.toLowerCase(), Number(x.minutes)])),
        stages: (s.stages || []).map((x: any) => [x.type, x.startTime, x.endTime]),
        resting_hr: main ? rhr.get(wakeDate) ?? null : null,
        hrv: main ? hrv.get(wakeDate) ?? null : null,
        device: p.dataSource?.device?.displayName || null,
      },
    });
  }
  // Days with resting HR / HRV but no sleep record still get those numbers in the day total
  const sleepDates = new Set(rows.filter((r) => r.details.kind === "sleep").map((r) => r.details.wake_date));

  // Day totals for finished days, placed at 11:59 PM
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  for (const [d, v] of days) {
    if (d >= today) continue;
    const bits: string[] = [];
    if (v.steps != null) bits.push(`${v.steps.toLocaleString("en-US")} steps`);
    if (v.activeCal != null) bits.push(`${Math.round(v.activeCal).toLocaleString("en-US")} active cal`);
    if (!sleepDates.has(d)) {
      if (rhr.has(d)) bits.push(`resting HR ${rhr.get(d)}`);
      if (hrv.has(d)) bits.push(`HRV ${Math.round(hrv.get(d).averageHeartRateVariabilityMilliseconds)} ms`);
    }
    if (!bits.length) continue;
    rows.push({
      user_id: userId, ts: zonedInstant(d, 23, 59, tz).toISOString(), tz, source: "google_health",
      source_id: `day:${d}`, body: `Day total · ${bits.join(" · ")}`,
      details: { kind: "day", date: d, steps: v.steps ?? null, active_kcal: v.activeCal != null ? Math.round(v.activeCal) : null,
        resting_hr: rhr.get(d) ?? null, hrv: hrv.get(d) ?? null },
    });
  }

  // Today's running totals for the "Today so far" display
  const live = days.get(today);
  if (live) {
    await admin.from("live_today").upsert({
      user_id: userId, local_date: today,
      steps: live.steps ?? null, active_kcal: live.activeCal != null ? Math.round(live.activeCal) : null,
      updated_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from("entries").upsert(rows.slice(i, i + 200), { onConflict: "user_id,source,source_id" });
    if (error) throw new Error("saving entries failed: " + error.message);
  }
  await admin.from("google_raw").update({ processed_at: new Date().toISOString() }).in("id", raws.map((r: any) => r.id));
  // keep storage small: raw responses are only needed briefly once processed
  await admin.from("google_raw").delete().eq("user_id", userId).not("processed_at", "is", null)
    .lt("fetched_at", new Date(Date.now() - 3 * 86400_000).toISOString());
  return rows.length;
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

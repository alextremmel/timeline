// Adds Fitbit heart rate to each Strava workout.
// For every workout, reads the Google Health "heart-rate" samples between its start and end,
// keeps every reading in workout_hr, and copies a short summary (average, max, a 60-point
// line for the graph) into the workout's entries.details.hr so the app can draw it.
// Runs hourly (pg_cron job "workout-hr-hourly") and right after new Strava workouts arrive.
// If Fitbit hasn't synced yet the workout is "pending" and is retried for 2 days, then "none".
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const API = "https://health.googleapis.com/v4/users/me/dataTypes";
const RETRY_HOURS = 48;          // keep looking this long after a workout ends
const RECHECK_MINUTES = 50;      // don't re-ask Google about a pending workout more often than this
const PER_RUN = 40;              // workouts handled per run
const GRAPH_POINTS = 60;

// Google Health rejects access tokens that also carry the calendar scopes, so health calls
// always use a token narrowed to just the health scopes (cached as access_kind = 'health').
const HEALTH_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
];
async function freshToken(admin: any, row: any) {
  if (row.access_kind === "health" && new Date(row.expires_at).getTime() - Date.now() > 120_000) return row.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
      scope: HEALTH_SCOPES.join(" "),
    }),
  });
  if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? "reconnect" : `token refresh failed (${res.status})`);
  const t = await res.json();
  await admin.from("oauth_tokens").update({
    access_token: t.access_token,
    access_kind: "health",
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("user_id", row.user_id).eq("provider", "google_health");
  return t.access_token;
}

// Reads one heart rate data point, whatever the exact field names are.
function readPoint(p: any): { t: number; bpm: number } | null {
  const hr = p?.heartRate ?? p?.heart_rate ?? p;
  const bpm = Number(hr?.beatsPerMinute ?? hr?.bpm ?? hr?.value);
  const time = hr?.sampleTime?.physicalTime ?? hr?.sampleTime?.time ?? p?.sampleTime?.physicalTime ?? hr?.time ?? p?.time;
  const t = time ? Date.parse(time) : NaN;
  if (!isFinite(bpm) || bpm < 25 || bpm > 250 || !isFinite(t)) return null;
  return { t, bpm };
}

async function fetchSamples(token: string, start: string, end: string, debug: (b: any) => Promise<void>) {
  const out: { t: number; bpm: number }[] = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const url = new URL(`${API}/heart-rate/dataPoints`);
    url.searchParams.set("filter", `heart_rate.sample_time.physical_time >= "${start}" AND heart_rate.sample_time.physical_time < "${end}"`);
    url.searchParams.set("pageSize", "10000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (i === 0) await debug(body ?? { status: res.status, text: text.slice(0, 2000) });
    if (!res.ok) throw new Error(`heart-rate: ${res.status} ${text.slice(0, 200)}`);
    for (const p of body?.dataPoints || []) {
      const s = readPoint(p);
      if (s) out.push(s);
    }
    pageToken = body?.nextPageToken || "";
    if (!pageToken) break;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function summarize(samples: { t: number; bpm: number }[], startMs: number, endMs: number, miles: number) {
  const rel = samples.map((s) => [Math.round((s.t - startMs) / 1000), s.bpm] as [number, number]);
  // Time-weighted average: each reading counts for the time until the next one (capped at 60 s).
  let wSum = 0, w = 0;
  for (let i = 0; i < rel.length; i++) {
    const next = i + 1 < rel.length ? rel[i + 1][0] : Math.round((endMs - startMs) / 1000);
    const dt = Math.min(60, Math.max(1, next - rel[i][0]));
    wSum += rel[i][1] * dt; w += dt;
  }
  const avg = w ? wSum / w : 0;
  const bpms = rel.map((r) => r[1]);
  const durS = Math.max(1, (endMs - startMs) / 1000);
  // Graph line: GRAPH_POINTS evenly spaced averages across the workout (null where no readings).
  const graph: (number | null)[] = [];
  for (let b = 0; b < GRAPH_POINTS; b++) {
    const lo = (b / GRAPH_POINTS) * durS, hi = ((b + 1) / GRAPH_POINTS) * durS;
    const inB = rel.filter((r) => r[0] >= lo && r[0] < hi).map((r) => r[1]);
    graph.push(inB.length ? Math.round(inB.reduce((a, c) => a + c, 0) / inB.length) : null);
  }
  // Minute-by-minute averages, for the AI link.
  const byMinute: (number | null)[] = [];
  for (let m = 0; m < Math.ceil(durS / 60); m++) {
    const inM = rel.filter((r) => r[0] >= m * 60 && r[0] < (m + 1) * 60).map((r) => r[1]);
    byMinute.push(inM.length ? Math.round(inM.reduce((a, c) => a + c, 0) / inM.length) : null);
  }
  const covered = new Set(rel.map((r) => Math.floor(r[0] / 60))).size / Math.max(1, Math.ceil(durS / 60));
  return {
    rel,
    hr: {
      status: "ok",
      avg_bpm: Math.round(avg),
      max_bpm: Math.max(...bpms),
      min_bpm: Math.min(...bpms),
      beats_per_mile: miles > 0.05 ? Math.round((avg * durS / 60) / miles) : null,
      readings: rel.length,
      coverage_pct: Math.round(covered * 100),
      graph,
      by_minute: byMinute,
    },
  };
}

Deno.serve(async (req) => {
  const limit = Math.min(PER_RUN, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || PER_RUN));
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: tokens } = await admin.from("oauth_tokens").select("*").eq("provider", "google_health");
  const results: any[] = [];

  for (const tok of tokens || []) {
    const userId = tok.user_id;
    try {
      const token = await freshToken(admin, tok);
      const { data: workouts } = await admin.from("entries").select("id, details")
        .eq("user_id", userId).eq("source", "strava").order("ts", { ascending: false }).limit(500);
      const { data: done } = await admin.from("workout_hr").select("entry_id, status, attempts, checked_at").eq("user_id", userId);
      const known = new Map((done || []).map((d: any) => [d.entry_id, d]));
      const now = Date.now();

      const todo = (workouts || []).filter((w: any) => {
        const k = known.get(w.id);
        if (!k) return true;
        if (k.status !== "pending") return false;
        return now - Date.parse(k.checked_at) > RECHECK_MINUTES * 60_000;
      }).slice(0, limit);

      let debugSaved = false;
      const debug = async (body: any) => {
        if (debugSaved) return;
        debugSaved = true;
        await admin.from("google_raw").insert({
          user_id: userId, data_type: "heart-rate (sample)", status: 200,
          response: { first_points: (body?.dataPoints || []).slice(0, 3), keys: Object.keys(body || {}), raw: body?.dataPoints ? undefined : body },
          processed_at: new Date().toISOString(),
        });
      };

      let ok = 0, pending = 0, none = 0;
      for (const w of todo) {
        const d = w.details || {};
        const startMs = Date.parse(d.start), endMs = Date.parse(d.end);
        if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) continue;
        const samples = await fetchSamples(token, new Date(startMs).toISOString(), new Date(endMs).toISOString(), debug);
        const prev = known.get(w.id);
        const attempts = (prev?.attempts || 0) + 1;
        const recent = now - endMs < RETRY_HOURS * 3600_000;
        const lastAt = samples.length ? samples[samples.length - 1].t : 0;
        // Fitbit may not have synced the end of the workout yet: wait while it's recent.
        const looksPartial = samples.length > 0 && endMs - lastAt > 5 * 60_000 && recent;

        let hr: any, row: any;
        if (samples.length && !looksPartial) {
          const s = summarize(samples, startMs, endMs, Number(d.distance_mi) || 0);
          hr = s.hr;
          row = { status: "ok", samples: s.rel, sample_count: s.rel.length, avg_bpm: hr.avg_bpm, max_bpm: hr.max_bpm, min_bpm: hr.min_bpm };
          ok++;
        } else if (recent) {
          hr = { status: "pending" };
          row = { status: "pending", samples: null, sample_count: samples.length, avg_bpm: null, max_bpm: null, min_bpm: null };
          pending++;
        } else {
          hr = { status: "none" };
          row = { status: "none", samples: null, sample_count: 0, avg_bpm: null, max_bpm: null, min_bpm: null };
          none++;
        }
        await admin.from("workout_hr").upsert({ entry_id: w.id, user_id: userId, attempts, checked_at: new Date().toISOString(), ...row });
        await admin.from("entries").update({ details: { ...d, hr } }).eq("id", w.id);
      }
      results.push({ checked: todo.length, ok, pending, none });
    } catch (e) {
      results.push({ error: (e as Error).message });
    }
  }
  return json({ results });
});

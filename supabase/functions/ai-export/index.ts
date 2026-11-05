// Read-only export of the timeline for any AI: GET /functions/v1/ai-export?key=SECRET
// Options: days=30 (1-3650), format=text|json|csv, view=timeline (default)|daily|both, photos=links
// It can only read. The key is checked against a hash in export_keys.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
const send = (body: string, type: string, status = 200) =>
  new Response(body, { status, headers: { ...HEADERS, "Content-Type": `${type}; charset=utf-8` } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : v);
function hm(min: number | null) {
  if (min == null) return null;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function describe(r: any) {
  const m = r.metrics || {};
  switch (r.kind) {
    case "sleep": case "nap":
      return `${r.kind} ${m.bedtime_local?.slice(11)}–${m.wake_local?.slice(11)}, asleep ${m.minutes_asleep} min (${hm(m.minutes_asleep)}): deep ${m.minutes_deep ?? "?"}, REM ${m.minutes_rem ?? "?"}, light ${m.minutes_light ?? "?"}, awake ${m.minutes_awake ?? "?"} min`
        + (m.resting_hr_bpm != null ? `; resting HR ${m.resting_hr_bpm} bpm` : "")
        + (m.hrv_ms != null ? `; HRV ${m.hrv_ms} ms` : "");
    case "workout":
      return `${m.activity} ${m.start_local?.slice(11)}–${m.end_local?.slice(11)}: ${m.distance_mi} mi in ${m.duration_min} min`
        + (m.pace_min_per_mi != null ? `, pace ${m.pace_min_per_mi} min/mi` : "")
        + (m.speed_mph != null ? `, ${m.speed_mph} mph` : "");
    case "day_total":
      return `day total: ${m.steps ?? "?"} steps, ${m.active_kcal ?? "?"} active kcal`;
    default:
      return (r.text || "").replace(/\s*\n\s*/g, " / ") || "(photo only)";
  }
}

function csvCell(v: unknown) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: any[], cols: string[]) {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: HEADERS });
  if (req.method !== "GET") return send("Use GET.", "text/plain", 405);
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "";
  if (!key) return send("Missing key.", "text/plain", 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const keyHash = await sha256(key);
  const { data: k } = await admin.from("export_keys").select("user_id, revoked_at").eq("key_hash", keyHash).maybeSingle();
  if (!k || k.revoked_at) return send("Invalid or revoked key.", "text/plain", 401);
  admin.from("export_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", keyHash).then(() => {});

  const days = Math.min(3650, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const format = (url.searchParams.get("format") || "text").toLowerCase();
  const view = (url.searchParams.get("view") || "timeline").toLowerCase();
  const withPhotoLinks = url.searchParams.get("photos") === "links";
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const wantDaily = view !== "timeline", wantTimeline = view !== "daily";
  const [{ data: daily, error: e1 }, { data: timeline, error: e2 }] = await Promise.all([
    wantDaily
      ? admin.from("ai_daily").select("local_date, day_of_week, sleep_minutes, bedtime_local, wake_local, deep_minutes, rem_minutes, resting_hr_bpm, hrv_ms, steps, active_kcal, workouts, run_walk_miles, bike_miles, workout_list, notes")
          .eq("user_id", k.user_id).gte("local_date", since).order("local_date")
      : Promise.resolve({ data: [], error: null }),
    wantTimeline
      ? admin.from("ai_timeline").select("entry_id, local_date, day_of_week, local_time, timestamp_utc, timezone, source, kind, text, photo_count, metrics")
          .eq("user_id", k.user_id).gte("local_date", since).order("timestamp_utc").limit(20000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (e1 || e2) return send("Couldn't read the data right now. Try again.", "text/plain", 500);

  // Optional photo links (valid 7 days)
  const photoLinks = new Map<string, string[]>();
  if (withPhotoLinks && timeline?.some((r: any) => r.photo_count > 0)) {
    const ids = timeline.filter((r: any) => r.photo_count > 0).map((r: any) => r.entry_id);
    const { data: photos } = await admin.from("entry_photos").select("entry_id, path").in("entry_id", ids);
    const paths = (photos || []).map((p: any) => p.path);
    if (paths.length) {
      const { data: signed } = await admin.storage.from("photos").createSignedUrls(paths, 7 * 86400);
      const byPath = new Map((signed || []).map((s: any) => [s.path, s.signedUrl]));
      for (const p of photos || []) {
        const u = byPath.get(p.path); if (!u) continue;
        photoLinks.set(p.entry_id, [...(photoLinks.get(p.entry_id) || []), u]);
      }
    }
  }

  const tl = (timeline || []).map((r: any) => ({
    date: r.local_date, day: r.day_of_week, time: r.local_time, timezone: r.timezone, timestamp_utc: r.timestamp_utc,
    source: r.source, kind: r.kind, text: n(r.text), photos: r.photo_count, ...(withPhotoLinks ? { photo_links: photoLinks.get(r.entry_id) || [] } : {}),
    metrics: r.metrics,
  }));

  if (format === "json") {
    return send(JSON.stringify({
      generated_at: new Date().toISOString(), days, since,
      notes: "Times are local to the timezone given. Sleep is listed at wake time and its resting HR/HRV belong to that morning. day_total is Fitbit steps and active calories for a finished day. Manual notes are free text written by the person (food, mood, symptoms, weight, etc.).",
      daily: wantDaily ? daily : undefined, timeline: wantTimeline ? tl : undefined,
    }, null, 2), "application/json");
  }
  if (format === "csv") {
    if (view === "daily") return send(toCsv(daily || [], Object.keys((daily || [])[0] || { local_date: 1 })), "text/csv");
    const flat = tl.map((r: any) => ({ ...r, metrics: r.metrics ? JSON.stringify(r.metrics) : "", photo_links: (r.photo_links || []).join(" ") }));
    return send(toCsv(flat, ["date", "day", "time", "timezone", "source", "kind", "text", "photos", ...(withPhotoLinks ? ["photo_links"] : []), "metrics"]), "text/csv");
  }

  // Plain text, easiest for any AI to read
  const lines: string[] = [];
  lines.push(`PERSONAL TIMELINE — last ${days} days (from ${since}), generated ${new Date().toISOString()}`);
  lines.push("Sources: manual = notes and photos the person logged; strava = workouts; fitbit = sleep (listed at wake time, with that morning's resting HR and HRV) and day totals (steps, active calories, at 23:59).");
  lines.push("All times are local (America/New_York unless shown otherwise).");
  if (wantDaily && daily?.length) {
    lines.push("", "=== DAILY SUMMARY ===");
    lines.push("date | day | sleep | bed–wake | deep/REM min | resting HR | HRV ms | steps | active kcal | workouts");
    for (const d of daily) {
      lines.push([d.local_date, d.day_of_week, hm(d.sleep_minutes) ?? "-",
        d.bedtime_local ? `${d.bedtime_local.slice(11)}–${d.wake_local?.slice(11)}` : "-",
        d.deep_minutes != null ? `${d.deep_minutes}/${d.rem_minutes}` : "-",
        d.resting_hr_bpm ?? "-", d.hrv_ms ?? "-", d.steps ?? "-", d.active_kcal ?? "-",
        d.workout_list || "-"].join(" | "));
    }
  }
  if (wantTimeline && tl.length) {
    lines.push("", "=== TIMELINE (every entry, in order) ===");
    let cur = "";
    for (const r of tl) {
      if (r.date !== cur) { cur = r.date; lines.push("", `${r.date} (${r.day})`); }
      const photo = r.photos ? (withPhotoLinks && r.photo_links?.length ? ` [photos: ${r.photo_links.join(" ")}]` : ` [${r.photos} photo${r.photos > 1 ? "s" : ""}]`) : "";
      lines.push(`  ${r.time} [${r.source} ${r.kind}] ${describe({ ...r, metrics: r.metrics })}${photo}`);
    }
  }
  return send(lines.join("\n") + "\n", "text/plain");
});

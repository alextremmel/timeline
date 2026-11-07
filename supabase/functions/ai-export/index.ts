// Read-only export of the timeline for any AI: GET /functions/v1/ai-export?key=SECRET
// Options: days=30 (1-3650) or from=YYYY-MM-DD&to=YYYY-MM-DD, kind=sleep,workout,note,photo,day_total,weather,nap,
//   order=newest (default)|oldest, format=text|json|csv, view=timeline (default)|daily|both|references, photos=links
// A single photo: ?key=…&photo=<id> (the links that photos=links produces)
// Reference items (linked from entries as [[Name]]) are always included first, with each version's dates.
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

// The night's sleep stages in order, as local times. Blips under 2 minutes are folded into the
// stage around them (except awake periods, which are always kept), then repeats are joined.
function stageTimeline(stages: any, tz: string) {
  if (!Array.isArray(stages) || !stages.length) return [];
  const segs = stages
    .map((s: any) => ({ stage: String(s?.[0] || "").toLowerCase(), start: Date.parse(s?.[1]), end: Date.parse(s?.[2]) }))
    .filter((s: any) => s.stage && isFinite(s.start) && isFinite(s.end) && s.end > s.start)
    .sort((a: any, b: any) => a.start - b.start);
  const out: any[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    const short = (s.end - s.start) / 60000 < 2 && s.stage !== "awake";
    if (prev && (prev.stage === s.stage || short)) { prev.end = Math.max(prev.end, s.end); continue; }
    out.push({ ...s });
  }
  let fmt: Intl.DateTimeFormat;
  try { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  return out.map((s) => ({ stage: s.stage, start: fmt.format(new Date(s.start)), minutes: Math.round((s.end - s.start) / 60000) }));
}

function describe(r: any) {
  const m = r.metrics || {};
  switch (r.kind) {
    case "sleep": case "nap":
      return `${r.kind} ${m.bedtime_local?.slice(11)}–${m.wake_local?.slice(11)}, asleep ${m.minutes_asleep} min (${hm(m.minutes_asleep)}): deep ${m.minutes_deep ?? "?"}, REM ${m.minutes_rem ?? "?"}, light ${m.minutes_light ?? "?"}, awake ${m.minutes_awake ?? "?"} min`
        + (m.resting_hr_bpm != null ? `; resting HR ${m.resting_hr_bpm} bpm` : "")
        + (m.hrv_ms != null ? `; HRV ${m.hrv_ms} ms` : "")
        + (Array.isArray(m.stages) && m.stages.length
          ? `\n      stages: ${m.stages.map((x: any) => `${x.start} ${x.stage} ${x.minutes}m`).join(", ")}` : "");
    case "workout":
      return `${m.activity} ${m.start_local?.slice(11)}–${m.end_local?.slice(11)}: ${m.distance_mi} mi in ${m.duration_min} min`
        + (m.pace_min_per_mi != null ? `, pace ${m.pace_min_per_mi} min/mi` : "")
        + (m.speed_mph != null ? `, ${m.speed_mph} mph` : "")
        + (m.avg_hr_bpm != null
          ? `; heart rate avg ${m.avg_hr_bpm} / max ${m.max_hr_bpm} bpm`
            + (m.heartbeats_per_mile != null ? `, ${m.heartbeats_per_mile} heartbeats per mile` : "")
            + (Array.isArray(m.hr_by_minute) && m.hr_by_minute.length ? `; HR by minute: ${m.hr_by_minute.map((v: any) => v ?? "-").join(",")}` : "")
          : m.heart_rate_status === "pending" ? "; heart rate not synced yet"
          : m.heart_rate_status === "none" ? "; no heart rate recorded" : "");
    case "day_total":
      return `day total: ${m.steps ?? "?"} steps, ${m.active_kcal ?? "?"} active kcal`;
    case "weather":
      return `weather that day: high ${m.temp_max_f ?? "?"}°F / low ${m.temp_min_f ?? "?"}°F`
        + (m.condition ? `, ${m.condition}` : "")
        + (m.humidity_mean_pct != null ? `, humidity ${m.humidity_mean_pct}% (range ${m.humidity_min_pct ?? "?"}–${m.humidity_max_pct ?? "?"}%)` : "")
        + (m.dew_point_mean_f != null ? `, dew point ${m.dew_point_mean_f}°F` : "")
        + (m.feels_like_max_f != null ? `, feels like ${m.feels_like_max_f}/${m.feels_like_min_f}°F` : "")
        + (m.uv_index_max != null ? `, UV max ${m.uv_index_max}` : "")
        + (m.precipitation_in != null ? `, precipitation ${m.precipitation_in} in` : "")
        + (m.wind_max_mph != null ? `, wind max ${m.wind_max_mph} mph` : "")
        + (m.sunshine_hours != null ? `, ${m.sunshine_hours} h sunshine` : "");
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

  // A single photo by its short id (keeps photo links short enough for every AI's web reader)
  const photoId = url.searchParams.get("photo");
  if (photoId) {
    if (!/^[0-9a-f-]{36}$/i.test(photoId)) return send("Bad photo id.", "text/plain", 400);
    const { data: ep } = await admin.from("entry_photos").select("path").eq("id", photoId).eq("user_id", k.user_id).maybeSingle();
    const { data: rv } = ep ? { data: null } : await admin.from("ref_versions").select("photo_path").eq("id", photoId).eq("user_id", k.user_id).maybeSingle();
    const path = ep?.path || rv?.photo_path;
    if (!path) return send("Photo not found.", "text/plain", 404);
    const { data: file, error } = await admin.storage.from("photos").download(path);
    if (error || !file) return send("Couldn't load that photo.", "text/plain", 500);
    return new Response(file, { headers: { ...HEADERS, "Content-Type": "image/jpeg" } });
  }

  const days = Math.min(3650, Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const format = (url.searchParams.get("format") || "text").toLowerCase();
  const view = (url.searchParams.get("view") || "timeline").toLowerCase();
  const withPhotoLinks = url.searchParams.get("photos") === "links";
  const isDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fromP = url.searchParams.get("from"), toP = url.searchParams.get("to");
  const since = isDate(fromP) ? fromP! : new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const until = isDate(toP) ? toP! : null;
  const KINDS = ["sleep", "nap", "workout", "day_total", "weather", "note", "photo"];
  const kinds = (url.searchParams.get("kind") || "").toLowerCase().split(",").map((x) => x.trim()).filter((x) => KINDS.includes(x));
  // Newest first by default: if a reader cuts a long export short, the oldest days are what get dropped.
  const newest = (url.searchParams.get("order") || "newest").toLowerCase() !== "oldest";
  const wantRefs = !kinds.length || kinds.includes("note") || kinds.includes("photo");
  const wantPlanned = !kinds.length || kinds.includes("workout");
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-export`;
  const photoUrl = (id: string) => `${base}?key=${encodeURIComponent(key)}&photo=${id}`;

  const wantDaily = view === "daily" || view === "both", wantTimeline = view === "timeline" || view === "both";
  const [{ data: daily, error: e1 }, { data: timeline, error: e2 }] = await Promise.all([
    wantDaily
      ? admin.from("ai_daily").select("local_date, day_of_week, sleep_minutes, bedtime_local, wake_local, deep_minutes, rem_minutes, resting_hr_bpm, hrv_ms, steps, active_kcal, workouts, run_walk_miles, bike_miles, workout_list, notes, weather_high_f, weather_low_f, humidity_pct, dew_point_f, uv_index, precipitation_in, weather")
          .eq("user_id", k.user_id).gte("local_date", since).lte("local_date", until || "9999-12-31").order("local_date", { ascending: !newest })
      : Promise.resolve({ data: [], error: null }),
    wantTimeline
      ? (() => {
        let q = admin.from("ai_timeline").select("entry_id, local_date, day_of_week, local_time, timestamp_utc, timezone, source, kind, text, photo_count, metrics")
          .eq("user_id", k.user_id).gte("local_date", since).lte("local_date", until || "9999-12-31");
        if (kinds.length) q = q.in("kind", kinds);
        return q.order("timestamp_utc", { ascending: !newest }).limit(20000);
      })()
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (e1 || e2) return send("Couldn't read the data right now. Try again.", "text/plain", 500);

  // Reference items: every version, with the dates it applied
  const { data: refRows } = !wantRefs ? { data: [] as any[] } : await admin.from("ai_references")
    .select("version_id, ref_id, name, description, photo_path, valid_from_local, valid_until_local, archived, archived_at_local")
    .eq("user_id", k.user_id).order("ref_id").order("valid_from_local");
  const refMap = new Map<string, any>();
  for (const r of refRows || []) {
    const item = refMap.get(r.ref_id) || { name: r.name, archived: r.archived, archived_at: r.archived_at_local?.slice(0, 16).replace("T", " ") ?? null, versions: [] as any[] };
    item.name = r.name; // current name = latest version
    item.versions.push({
      name: r.name, from: r.valid_from_local?.slice(0, 16).replace("T", " "),
      until: r.valid_until_local ? r.valid_until_local.slice(0, 16).replace("T", " ") : null,
      description: r.description, has_photo: !!r.photo_path,
      ...(withPhotoLinks && r.photo_path ? { photo_link: photoUrl(r.version_id) } : {}),
    });
    refMap.set(r.ref_id, item);
  }
  const references = [...refMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Optional photo links (short links served by this function)
  const photoLinks = new Map<string, string[]>();
  if (withPhotoLinks && timeline?.some((r: any) => r.photo_count > 0)) {
    const ids = timeline.filter((r: any) => r.photo_count > 0).map((r: any) => r.entry_id);
    const { data: photos } = await admin.from("entry_photos").select("id, entry_id").in("entry_id", ids);
    for (const p of photos || []) photoLinks.set(p.entry_id, [...(photoLinks.get(p.entry_id) || []), photoUrl(p.id)]);
  }

  // Planned workouts: read live from the Exercise calendar (never stored)
  let planned: any[] = [];
  if (wantPlanned) try {
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/calendar-upcoming`, {
      method: "POST",
      headers: { Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: k.user_id }),
    });
    const j = await r.json();
    if (j?.status === "ok") planned = j.days || [];
  } catch { /* leave planned empty */ }
  const weekday = (ymd: string) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

  const tl = (timeline || []).map((r: any) => ({
    date: r.local_date, day: r.day_of_week, time: r.local_time, timezone: r.timezone, timestamp_utc: r.timestamp_utc,
    source: r.source, kind: r.kind, text: n(r.text), photos: r.photo_count, ...(withPhotoLinks ? { photo_links: photoLinks.get(r.entry_id) || [] } : {}),
    metrics: (r.kind === "sleep" || r.kind === "nap") && r.metrics
      ? { ...r.metrics, stages: stageTimeline(r.metrics.stages, r.timezone) } : r.metrics,
  }));

  if (format === "json") {
    const compact = tl.map((r: any) => Array.isArray(r.metrics?.stages)
      ? { ...r, metrics: { ...r.metrics, stages: r.metrics.stages.map((x: any) => `${x.start} ${x.stage} ${x.minutes}m`).join(", ") } } : r);
    return send(JSON.stringify({
      generated_at: new Date().toISOString(), days, since, until, order: newest ? "newest first" : "oldest first", kinds: kinds.length ? kinds : "all",
      references_note: "Entries link a reference item by writing [[Name]]. Use the version whose from/until dates contain the entry's time. Plain words without [[ ]] do NOT refer to reference items.",
      references,
      notes: "Times are local to the timezone given. Sleep is listed at wake time and its resting HR/HRV belong to that morning; metrics.stages is the night's stage sequence as text: 'local start time, stage, minutes', blips under 2 min folded in, awake periods kept. day_total is Fitbit steps and active calories for a finished day. Workouts carry Fitbit heart rate (avg, max, heartbeats per mile, minute-by-minute) where recorded. Manual notes are free text written by the person (food, mood, symptoms, weight, etc.). weather is the outdoor weather for that day where the person was (°F, inches). planned_next_7_days are plans from the person's Exercise calendar, not things that happened.",
      planned_next_7_days: planned,
      daily: wantDaily ? daily : undefined, timeline: wantTimeline ? compact : undefined,
    }), "application/json");
  }
  if (format === "csv") {
    if (view === "references") {
      const flat = references.flatMap((r: any) => r.versions.map((v: any) => ({ name: v.name, from: v.from, until: v.until || "", archived: r.archived, description: v.description || "", photo_link: v.photo_link || "" })));
      return send(toCsv(flat, ["name", "from", "until", "archived", "description", ...(withPhotoLinks ? ["photo_link"] : [])]), "text/csv");
    }
    if (view === "daily") return send(toCsv(daily || [], Object.keys((daily || [])[0] || { local_date: 1 })), "text/csv");
    const flat = tl.map((r: any) => ({ ...r, metrics: r.metrics ? JSON.stringify(r.metrics) : "", photo_links: (r.photo_links || []).join(" ") }));
    return send(toCsv(flat, ["date", "day", "time", "timezone", "source", "kind", "text", "photos", ...(withPhotoLinks ? ["photo_links"] : []), "metrics"]), "text/csv");
  }

  // Plain text, easiest for any AI to read
  const lines: string[] = [];
  lines.push(`PERSONAL TIMELINE — ${until ? `${since} to ${until}` : `from ${since}`}${kinds.length ? `, only: ${kinds.join(", ")}` : ""}, ${newest ? "NEWEST FIRST" : "oldest first"}, generated ${new Date().toISOString()}`);
  lines.push("If this gets cut off, ask for less: add &kind=sleep (or workout, note, photo, day_total, weather), &days=7, or &from=YYYY-MM-DD&to=YYYY-MM-DD; &order=oldest reverses the order.");
  lines.push("Sources: manual = notes and photos the person logged; strava = workouts (with Fitbit heart rate during the workout where recorded; heartbeats per mile = average HR × minutes ÷ miles, lower at the same pace means fitter); fitbit = sleep (listed at wake time, with that morning's resting HR and HRV, then the night's stages in order as 'start time, stage, minutes'; blips under 2 min are folded into the surrounding stage, awake periods always kept) and day totals (steps, active calories, at 23:59); weather = outdoor weather for the day where the person was (from their phone's evening location; listed at 23:59; days before weather tracking began have none).");
  lines.push("All times are local (America/New_York unless shown otherwise).");
  if (references.length) {
    lines.push("", "=== REFERENCES ===");
    lines.push("Entries link these by writing [[Name]]. Use the version whose dates contain the entry's time. Plain words without [[ ]] do NOT refer to these.");
    for (const r of references) {
      lines.push("", `[[${r.name}]]${r.archived ? ` (archived ${r.archived_at})` : ""}`);
      for (const v of r.versions) {
        const photo = v.photo_link ? ` [photo: ${v.photo_link}]` : v.has_photo ? " [has photo]" : "";
        lines.push(`  ${v.from} → ${v.until || "now"}${v.name !== r.name ? ` (named "${v.name}")` : ""}: ${(v.description || "(no description)").replace(/\s*\n\s*/g, " / ")}${photo}`);
      }
    }
  }
  if (planned.length) {
    lines.push("", "=== PLANNED (next 7 days, from the person's Exercise calendar; plans, not things that happened) ===");
    for (const d of planned) for (const ev of d.events) lines.push(`  ${d.date} (${weekday(d.date)}): ${ev.title}${ev.notes ? " — " + ev.notes.replace(/\s*\n\s*/g, " / ") : ""}`);
  }
  if (wantDaily && daily?.length) {
    lines.push("", "=== DAILY SUMMARY ===");
    lines.push("date | day | sleep | bed–wake | deep/REM min | resting HR | HRV ms | steps | active kcal | workouts | weather hi/lo °F, humidity %, dew point °F");
    for (const d of daily) {
      lines.push([d.local_date, d.day_of_week, hm(d.sleep_minutes) ?? "-",
        d.bedtime_local ? `${d.bedtime_local.slice(11)}–${d.wake_local?.slice(11)}` : "-",
        d.deep_minutes != null ? `${d.deep_minutes}/${d.rem_minutes}` : "-",
        d.resting_hr_bpm ?? "-", d.hrv_ms ?? "-", d.steps ?? "-", d.active_kcal ?? "-",
        d.workout_list || "-",
        d.weather_high_f != null ? `${Math.round(d.weather_high_f)}/${Math.round(d.weather_low_f)}, ${d.humidity_pct ?? "?"}%, ${d.dew_point_f ?? "?"}` : "-"].join(" | "));
    }
  }
  if (wantTimeline && tl.length) {
    lines.push("", "=== TIMELINE (every entry; newest first unless order=oldest) ===");
    let cur = "";
    for (const r of tl) {
      if (r.date !== cur) { cur = r.date; lines.push("", `${r.date} (${r.day})`); }
      const photo = r.photos ? (withPhotoLinks && r.photo_links?.length ? ` [photos: ${r.photo_links.join(" ")}]` : ` [${r.photos} photo${r.photos > 1 ? "s" : ""}]`) : "";
      lines.push(`  ${r.time} [${r.source} ${r.kind}] ${describe({ ...r, metrics: r.metrics })}${photo}`);
    }
  }
  return send(lines.join("\n") + "\n", "text/plain");
});

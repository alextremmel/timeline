// Receives Apple Health data sent by the iPhone Shortcut.
// The Shortcut proves who it is with a private key in the "x-timeline-key" header.
// Every delivery is stored as-is in health_raw, then turned into timeline entries.
//
// Delivery format (JSON body, each field is text with one record per line):
//   strava: "Type|Start ISO|End ISO|Value|Unit"   (Walking + Running Distance, Cycling Distance from Strava)
//
// Location (from the evening "Timeline Location" automation), used for that day's weather:
//   {"lat": 40.71, "lon": -74.01}   — rounded to 2 decimals (about 1 km) before it is stored.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- formatting ---------- */
function clock(totalSeconds: number) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function toMiles(value: number, unit: string) {
  const u = unit.trim().toLowerCase();
  if (u === "km") return value / 1.609344;
  if (u === "m") return value / 1609.344;
  if (u === "yd") return value / 1760;
  return value; // mi
}

/* ---------- Strava workouts (one Apple Health record per workout) ---------- */
function stravaEntries(userId: string, text: string) {
  const rows: any[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [type, startIso, endIso, valueStr, unit = "mi"] = line.split("|").map((p) => p.trim());
    const start = new Date(startIso), end = new Date(endIso);
    const value = parseFloat(valueStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || !isFinite(value)) continue;

    const miles = toMiles(value, unit);
    const seconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
    const bike = /cycl/i.test(type);
    const minPerMile = miles > 0 ? seconds / 60 / miles : 0;
    const kind = bike ? "Bike" : minPerMile > 14 ? "Walk" : "Run";

    const parts = [kind, `${miles.toFixed(2)} mi`, clock(seconds)];
    if (miles >= 0.1 && seconds > 0) {
      parts.push(bike ? `${(miles / (seconds / 3600)).toFixed(1)} mph` : `${clock(seconds / miles)} /mi`);
    }
    rows.push({
      user_id: userId,
      ts: start.toISOString(),
      tz: null,
      body: parts.join(" · "),
      source: "strava",
      source_id: `${bike ? "bike" : "foot"}:${start.toISOString()}`,
      details: {
        via: "apple_health", health_type: type, kind,
        start: startIso, end: endIso,
        distance_mi: Math.round(miles * 1000) / 1000, duration_s: Math.round(seconds),
      },
    });
  }
  return rows;
}

/* ---------- evening location, for the weather ---------- */
function coord(v: unknown) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  return parseFloat(v.trim().replace(",", "."));
}
function readLocation(p: any): { lat: number; lon: number } | null {
  if (!p || typeof p !== "object") return null;
  let lat = coord(p.lat ?? p.latitude), lon = coord(p.lon ?? p.lng ?? p.longitude);
  if ((!isFinite(lat) || !isFinite(lon)) && typeof p.location === "string") {
    const m = p.location.match(/(-?\d+(?:[.,]\d+)?)\s*[,;]\s*(-?\d+(?:[.,]\d+)?)/);
    if (m) { lat = coord(m[1]); lon = coord(m[2]); }
  }
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}
function dateIn(timeZone: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
async function savePlace(admin: any, userId: string, loc: { lat: number; lon: number }) {
  let timezone = "America/New_York";
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto&forecast_days=1&daily=temperature_2m_max`);
    const j = await r.json();
    if (typeof j.timezone === "string" && j.timezone) timezone = j.timezone;
  } catch { /* keep the default */ }
  const local_date = dateIn(timezone);
  const { error } = await admin.from("places").insert({ user_id: userId, lat: loc.lat, lon: loc.lon, timezone, local_date });
  if (error) throw new Error(error.message);
  const now = new Date().toISOString();
  await admin.from("connections").upsert({ user_id: userId, provider: "location", status: "connected", last_sync_at: now, last_error: null });
  return { date: local_date, timezone };
}

/* ---------- process every delivery not yet turned into entries ---------- */
async function processPending(admin: any, userId: string) {
  const { data: pending } = await admin.from("health_raw").select("id, payload")
    .eq("user_id", userId).is("processed_at", null).order("id").limit(20);
  let made = 0;
  for (const d of pending || []) {
    try {
      const p = d.payload || {};
      const rows = [
        ...(typeof p.strava === "string" ? stravaEntries(userId, p.strava) : []),
      ];
      if (rows.length) {
        // The shortcut re-sends recent workouts every time: keep anything added later (like heart rate).
        const { data: existing } = await admin.from("entries").select("source_id, details")
          .eq("user_id", userId).eq("source", "strava").in("source_id", rows.map((r) => r.source_id));
        const prev = new Map((existing || []).map((e: any) => [e.source_id, e.details || {}]));
        for (const r of rows) {
          const old = prev.get(r.source_id);
          if (old?.hr) r.details = { ...r.details, hr: old.hr };
        }
        const { error } = await admin.from("entries").upsert(rows, { onConflict: "user_id,source,source_id" });
        if (error) throw new Error(error.message);
      }
      made += rows.length;
      await admin.from("health_raw").update({ processed_at: new Date().toISOString(), process_error: null }).eq("id", d.id);
    } catch (e) {
      await admin.from("health_raw").update({ process_error: (e as Error).message }).eq("id", d.id);
    }
  }
  return made;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const key = req.headers.get("x-timeline-key") || new URL(req.url).searchParams.get("key") || "";
  if (!key) return reply({ error: "Missing key." }, 401);
  const keyHash = await sha256(key);
  const { data: k } = await admin.from("ingest_keys").select("user_id").eq("key_hash", keyHash).maybeSingle();
  if (!k) return reply({ error: "Wrong key." }, 401);

  const contentType = req.headers.get("content-type") || "";
  const text = await req.text();
  if (text.length > 5_000_000) return reply({ error: "Too much data in one delivery." }, 413);
  let payload: unknown = null;
  try { payload = JSON.parse(text); } catch { /* keep as text */ }

  // An evening location delivery: store the rounded spot only, nothing else.
  const loc = readLocation(payload);
  if (loc && !(payload as any).strava) {
    try {
      const place = await savePlace(admin, k.user_id, loc);
      await admin.from("ingest_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", keyHash);
      return reply({ ok: true, location_saved_for: place.date });
    } catch {
      return reply({ error: "Couldn't save the location." }, 500);
    }
  }

  const { data: row, error } = await admin.from("health_raw").insert({
    user_id: k.user_id, content_type: contentType,
    payload, payload_text: payload === null ? text : null,
  }).select("id").single();
  if (error) return reply({ error: "Couldn't store the delivery." }, 500);

  const entries = await processPending(admin, k.user_id);
  // New workouts: look up their Fitbit heart rate in the background.
  if (entries > 0) {
    const job = fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/workout-hr`, { method: "POST" }).catch(() => {});
    try { (globalThis as any).EdgeRuntime?.waitUntil(job); } catch { /* best effort */ }
  }

  const now = new Date().toISOString();
  await admin.from("ingest_keys").update({ last_used_at: now }).eq("key_hash", keyHash);
  await admin.from("connections").upsert({
    user_id: k.user_id, provider: "apple_health", status: "connected", last_sync_at: now, last_error: null,
  });

  return reply({ ok: true, delivery: row.id, entries });
});

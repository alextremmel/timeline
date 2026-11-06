// Looks up each finished day's weather at the place you were (from the evening
// location automation) and saves it as one "weather" timeline entry per day.
// Runs hourly (pg_cron job "weather-sync-hourly"). Weather comes from Open-Meteo (free, no key).
//
// GET ?preview=LAT,LON,YYYY-MM-DD returns what would be saved for that spot and day, without saving.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const DAILY = [
  "weather_code", "temperature_2m_max", "temperature_2m_min",
  "apparent_temperature_max", "apparent_temperature_min",
  "relative_humidity_2m_mean", "relative_humidity_2m_max", "relative_humidity_2m_min",
  "dew_point_2m_mean", "uv_index_max", "precipitation_sum", "wind_speed_10m_max",
  "sunshine_duration",
];
const MAX_DAYS_PER_RUN = 14;

const CONDITION: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "fog", 48: "fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "rain showers", 82: "heavy rain showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

function dateIn(timeZone: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(ymd: string, n: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const r0 = (v: unknown) => (typeof v === "number" ? Math.round(v) : null);
const r1 = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : null);
const r2 = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : null);

async function fetchDay(lat: number, lon: number, date: string) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), start_date: date, end_date: date,
    timezone: "auto", temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    daily: DAILY.join(","),
  }).toString();
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.reason || `Open-Meteo answered ${r.status}`);
  const d = j.daily || {};
  const pick = (k: string) => (Array.isArray(d[k]) ? d[k][0] : null);
  if (pick("temperature_2m_max") == null) throw new Error("No weather for that day yet");
  return {
    timezone: j.timezone as string,
    utc_offset_seconds: j.utc_offset_seconds as number,
    weather_code: pick("weather_code"),
    temp_max_f: r1(pick("temperature_2m_max")), temp_min_f: r1(pick("temperature_2m_min")),
    feels_like_max_f: r1(pick("apparent_temperature_max")), feels_like_min_f: r1(pick("apparent_temperature_min")),
    humidity_mean_pct: r0(pick("relative_humidity_2m_mean")),
    humidity_max_pct: r0(pick("relative_humidity_2m_max")), humidity_min_pct: r0(pick("relative_humidity_2m_min")),
    dew_point_mean_f: r1(pick("dew_point_2m_mean")),
    uv_index_max: r1(pick("uv_index_max")),
    precipitation_in: r2(pick("precipitation_sum")),
    wind_max_mph: r1(pick("wind_speed_10m_max")),
    sunshine_hours: typeof pick("sunshine_duration") === "number" ? r1(pick("sunshine_duration") / 3600) : null,
  };
}

function buildEntry(userId: string | null, date: string, place: any, w: any, fromSameDay: boolean) {
  const condition = CONDITION[w.weather_code as number] ?? null;
  const parts = [`High ${r0(w.temp_max_f)}° / low ${r0(w.temp_min_f)}°F`];
  if (condition) parts.push(condition);
  if (w.humidity_mean_pct != null) parts.push(`humidity ${w.humidity_mean_pct}%`);
  if (w.dew_point_mean_f != null) parts.push(`dew point ${r0(w.dew_point_mean_f)}°`);
  if (w.uv_index_max != null) parts.push(`UV ${r0(w.uv_index_max)}`);
  if (w.precipitation_in != null) parts.push(`rain/snow ${w.precipitation_in.toFixed(2)} in`);
  // Saved at 23:59 local time, like the Fitbit day totals.
  const ts = new Date(Date.parse(date + "T23:59:00Z") - (w.utc_offset_seconds || 0) * 1000).toISOString();
  return {
    user_id: userId, ts, tz: w.timezone, source: "weather", source_id: date,
    body: "Weather · " + parts.join(" · "),
    details: {
      kind: "weather", date, condition, ...w,
      lat: place.lat, lon: place.lon,
      location_from: fromSameDay ? "that evening's location" : `last known location (${place.local_date})`,
      via: "open-meteo",
    },
  };
}

async function syncUser(admin: any, userId: string, places: any[]) {
  const tz = places[places.length - 1].timezone || "America/New_York";
  const yesterday = addDays(dateIn(tz), -1);
  const first = places[0].local_date;
  if (!first || first > yesterday) return { saved: 0 };

  const { data: have } = await admin.from("entries").select("source_id")
    .eq("user_id", userId).eq("source", "weather").gte("source_id", first);
  const done = new Set((have || []).map((r: any) => r.source_id));

  const wanted: string[] = [];
  for (let d = yesterday; d >= first && wanted.length < MAX_DAYS_PER_RUN; d = addDays(d, -1)) {
    if (!done.has(d)) wanted.push(d);
  }
  const rows: any[] = [], errors: string[] = [];
  for (const date of wanted) {
    const same = places.filter((p) => p.local_date === date);
    const place = same.length ? same[same.length - 1] : [...places].reverse().find((p) => p.local_date < date);
    if (!place) continue;
    try {
      rows.push(buildEntry(userId, date, place, await fetchDay(place.lat, place.lon, date), same.length > 0));
    } catch (e) {
      errors.push(`${date}: ${(e as Error).message}`);
    }
  }
  if (rows.length) {
    const { error } = await admin.from("entries").upsert(rows, { onConflict: "user_id,source,source_id" });
    if (error) throw new Error(error.message);
  }
  await admin.from("connections").upsert({
    user_id: userId, provider: "weather", status: "connected", last_sync_at: new Date().toISOString(),
    last_error: errors.length ? errors.join(" | ").slice(0, 1000) : null,
  });
  return { saved: rows.length, errors };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const preview = url.searchParams.get("preview");
  if (preview) {
    const [lat, lon, date] = preview.split(",");
    try {
      const w = await fetchDay(Number(lat), Number(lon), date);
      return json(buildEntry(null, date, { lat: Number(lat), lon: Number(lon), local_date: date }, w, true));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: all, error } = await admin.from("places")
    .select("user_id, lat, lon, timezone, local_date, received_at").order("received_at");
  if (error) return json({ error: error.message }, 500);
  const byUser = new Map<string, any[]>();
  for (const p of all || []) {
    if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
    byUser.get(p.user_id)!.push(p);
  }
  const results: any[] = [];
  for (const [userId, places] of byUser) {
    try { results.push(await syncUser(admin, userId, places)); }
    catch (e) { results.push({ error: (e as Error).message }); }
  }
  return json({ results });
});

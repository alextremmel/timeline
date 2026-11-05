// Pulls Strava activities into the timeline as entries (source = "strava").
// Runs hourly on a schedule and whenever the app is opened. Safe to call often:
// it skips if a sync ran in the last 10 minutes, and re-imports never duplicate.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const COOLDOWN_MS = 10 * 60_000;
const RECHECK_S = 7 * 86400; // re-read the last week so renamed/edited activities update

/* ---------- formatting ---------- */
const MI = 1609.344;
function dur(s: number) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function prettyType(t: string) { return (t || "Activity").replace(/([a-z])([A-Z])/g, "$1 $2"); }
const PACE_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);
const SPEED_TYPES = new Set(["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide", "Velomobile", "Handcycle"]);

function describe(a: any) {
  const type = a.sport_type || a.type;
  const parts: string[] = [prettyType(type)];
  const miles = (a.distance || 0) / MI;
  if (type === "Swim" && a.distance) parts.push(`${Math.round(a.distance * 1.09361)} yd`);
  else if (miles >= 0.05) parts.push(`${miles.toFixed(2)} mi`);
  if (a.moving_time) parts.push(dur(a.moving_time));
  if (PACE_TYPES.has(type) && miles >= 0.1 && a.moving_time) parts.push(`${dur(a.moving_time / miles)} /mi`);
  if (SPEED_TYPES.has(type) && miles >= 0.1 && a.moving_time) parts.push(`${(miles / (a.moving_time / 3600)).toFixed(1)} mph`);
  if (a.average_heartrate) parts.push(`avg HR ${Math.round(a.average_heartrate)}`);
  if (a.max_heartrate) parts.push(`max HR ${Math.round(a.max_heartrate)}`);
  if (a.total_elevation_gain > 1) parts.push(`${Math.round(a.total_elevation_gain * 3.28084)} ft climb`);
  if (a.kilojoules) parts.push(`${Math.round(a.kilojoules)} kJ`);
  return `${a.name || prettyType(type)}\n${parts.join(" · ")}`;
}
function tzOf(a: any) {
  const m = /\)\s*(\S+)$/.exec(a.timezone || "");
  return m ? m[1] : null;
}

/* ---------- strava calls ---------- */
async function freshToken(admin: any, row: any) {
  if (new Date(row.expires_at).getTime() - Date.now() > 120_000) return row.access_token;
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("STRAVA_CLIENT_ID")!,
      client_secret: Deno.env.get("STRAVA_CLIENT_SECRET")!,
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? "reconnect" : `token refresh failed (${res.status})`);
  const t = await res.json();
  await admin.from("oauth_tokens").update({
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("user_id", row.user_id).eq("provider", "strava");
  return t.access_token;
}

async function syncUser(admin: any, row: any, conn: any) {
  const token = await freshToken(admin, row);
  const now = Math.floor(Date.now() / 1000);
  const after = conn?.cursor ? Math.min(Number(conn.cursor), now - RECHECK_S) : 0;
  let page = 1, imported = 0, newest = conn?.cursor ? Number(conn.cursor) : 0;

  while (page <= 50) {
    const url = `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) throw new Error("Strava rate limit reached; will retry next hour");
    if (res.status === 401) throw new Error("reconnect");
    if (!res.ok) throw new Error(`Strava returned ${res.status}`);
    const list: any[] = await res.json();
    if (!list.length) break;

    const rows = list.map((a) => {
      const details = { ...a };
      delete details.map; // route line isn't needed and is large
      newest = Math.max(newest, Math.floor(new Date(a.start_date).getTime() / 1000));
      return {
        user_id: row.user_id,
        ts: a.start_date,
        tz: tzOf(a),
        body: describe(a),
        source: "strava",
        source_id: String(a.id),
        details,
      };
    });
    const { error } = await admin.from("entries").upsert(rows, { onConflict: "user_id,source,source_id" });
    if (error) throw new Error("saving entries failed: " + error.message);
    imported += rows.length;
    if (list.length < 200) break;
    page++;
  }
  return { imported, newest };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: tokens } = await admin.from("oauth_tokens").select("*").eq("provider", "strava");
  const results: any[] = [];
  for (const row of tokens || []) {
    const { data: conn } = await admin.from("connections").select("*")
      .eq("user_id", row.user_id).eq("provider", "strava").maybeSingle();
    if (conn?.last_sync_at && Date.now() - new Date(conn.last_sync_at).getTime() < COOLDOWN_MS) {
      results.push({ skipped: "recent" });
      continue;
    }
    // claim this run so overlapping calls skip
    await admin.from("connections").update({ last_sync_at: new Date().toISOString() })
      .eq("user_id", row.user_id).eq("provider", "strava");
    try {
      const r = await syncUser(admin, row, conn);
      await admin.from("connections").update({
        status: "connected", cursor: r.newest || conn?.cursor || null,
        last_sync_at: new Date().toISOString(), last_error: null,
      }).eq("user_id", row.user_id).eq("provider", "strava");
      results.push({ imported: r.imported });
    } catch (e) {
      const msg = (e as Error).message;
      await admin.from("connections").update({
        status: msg === "reconnect" ? "needs_reconnect" : "error",
        last_error: msg === "reconnect" ? "Strava access expired or was revoked. Connect again." : msg,
      }).eq("user_id", row.user_id).eq("provider", "strava");
      results.push({ error: msg });
    }
  }
  return json({ results });
});

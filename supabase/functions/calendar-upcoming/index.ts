// Reads planned all-day events from the "Exercise" Google Calendar, today through the next 7 days.
// Read live from Google every time and never saved, so past events simply stop appearing.
// Called by the app (signed-in user) for the "Coming up" section.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const CALENDAR_NAME = "exercise";
const DAYS_AHEAD = 7;
const NEEDED = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

function dateIn(timeZone: string, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(ymd: string, n: number) {
  const d = new Date(ymd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

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
  if (!res.ok) throw new Error("reconnect");
  const t = await res.json();
  await admin.from("oauth_tokens").update({
    access_token: t.access_token,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("user_id", row.user_id).eq("provider", "google_health");
  return t.access_token;
}

async function upcoming(admin: any, userId: string) {
  const { data: row } = await admin.from("oauth_tokens").select("*").eq("user_id", userId).eq("provider", "google_health").maybeSingle();
  if (!row) return { status: "not_connected", days: [] };
  if (!NEEDED.every((s) => (row.scope || "").includes(s))) return { status: "needs_calendar_access", days: [] };
  let token: string;
  try { token = await freshToken(admin, row); } catch { return { status: "needs_reconnect", days: [] }; }
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const lr = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", auth);
  if (lr.status === 401 || lr.status === 403) return { status: "needs_calendar_access", days: [] };
  if (!lr.ok) return { status: "error", days: [] };
  const list = await lr.json();
  const cal = (list.items || []).find((c: any) =>
    [c.summaryOverride, c.summary].some((n) => (n || "").trim().toLowerCase() === CALENDAR_NAME));
  if (!cal) return { status: "no_calendar", days: [] };

  const tz = cal.timeZone || "America/New_York";
  const today = dateIn(tz);
  const last = addDays(today, DAYS_AHEAD);
  const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`);
  // Generous window in UTC; the all-day dates are filtered exactly below.
  u.search = new URLSearchParams({
    timeMin: new Date(Date.parse(today + "T00:00:00Z") - 86400_000).toISOString(),
    timeMax: new Date(Date.parse(last + "T00:00:00Z") + 2 * 86400_000).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "250",
  }).toString();
  const er = await fetch(u, auth);
  if (!er.ok) return { status: "error", days: [] };
  const ev = await er.json();

  const byDay = new Map<string, any[]>();
  for (const e of ev.items || []) {
    const date = e.start?.date; // all-day events only; anything with a time is skipped
    if (!date || e.status === "cancelled" || date < today || date > last) continue;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push({ title: (e.summary || "(no title)").trim(), notes: (e.description || "").trim() || null });
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, events]) => ({ date, events }));
  return { status: "ok", calendar: cal.summaryOverride || cal.summary, timezone: tz, today, days };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  let userId: string | null = null;
  if (jwt && jwt === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
    // Server-to-server call from the AI link, which has already checked its own key.
    userId = (await req.json().catch(() => ({})))?.user_id || null;
  } else {
    const { data: { user } } = await admin.auth.getUser(jwt);
    userId = user?.id || null;
  }
  if (!userId) return json({ error: "Not signed in." }, 401);
  try {
    return json(await upcoming(admin, userId));
  } catch (e) {
    return json({ status: "error", days: [], error: (e as Error).message });
  }
});

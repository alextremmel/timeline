// Starts "Connect Google Health" for the signed-in user. Returns Google's approval URL.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  // Read-only: the "Exercise" calendar's planned all-day events, for "Coming up"
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId) return json({ error: "Google Health isn't set up yet (missing client ID)." }, 500);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (error || !user) return json({ error: "Not signed in." }, 401);

  await admin.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  const state = crypto.randomUUID();
  const { error: e2 } = await admin.from("oauth_states").insert({ state, user_id: user.id, provider: "google_health" });
  if (e2) return json({ error: "Couldn't start the connection." }, 500);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${SUPABASE_URL}/functions/v1/gh-callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  return json({ url: url.toString() });
});

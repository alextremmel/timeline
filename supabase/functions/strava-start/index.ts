// Starts the "Connect Strava" flow for the signed-in user.
// Returns the Strava approval URL; the app sends the browser there.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const clientId = Deno.env.get("STRAVA_CLIENT_ID");
  if (!clientId) return json({ error: "Strava isn't set up yet (missing client ID)." }, 500);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (error || !user) return json({ error: "Not signed in." }, 401);

  // clear out stale states, then make a fresh one for this user
  await admin.from("oauth_states").delete().lt("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  const state = crypto.randomUUID();
  const { error: e2 } = await admin.from("oauth_states").insert({ state, user_id: user.id, provider: "strava" });
  if (e2) return json({ error: "Couldn't start the connection." }, 500);

  const url = new URL("https://www.strava.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${SUPABASE_URL}/functions/v1/strava-callback`);
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", "read,activity:read_all");
  url.searchParams.set("state", state);
  return json({ url: url.toString() });
});

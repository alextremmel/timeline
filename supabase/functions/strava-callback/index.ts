// Strava sends the browser here after you approve access.
// Swaps the one-time code for tokens, stores them server-side, starts the first sync,
// and sends you back to the app.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const APP_URL = "https://alextremmel.github.io/timeline/";
const back = (status: string) => Response.redirect(`${APP_URL}?strava=${status}`, 302);

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const scope = u.searchParams.get("scope") || "";
  if (u.searchParams.get("error") || !code || !state) return back("cancelled");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // the state must be one we just issued (within 30 minutes); use it once
  const { data: st } = await admin.from("oauth_states").select("user_id, created_at")
    .eq("state", state).eq("provider", "strava").maybeSingle();
  await admin.from("oauth_states").delete().eq("state", state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 30 * 60_000) return back("expired");
  if (!scope.includes("activity:read")) return back("needs-activity-access");

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("STRAVA_CLIENT_ID")!,
      client_secret: Deno.env.get("STRAVA_CLIENT_SECRET")!,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return back("failed");
  const tok = await res.json();

  await admin.from("oauth_tokens").upsert({
    user_id: st.user_id, provider: "strava",
    access_token: tok.access_token, refresh_token: tok.refresh_token,
    expires_at: new Date(tok.expires_at * 1000).toISOString(), scope,
    updated_at: new Date().toISOString(),
  });
  const athlete = tok.athlete || {};
  await admin.from("connections").upsert({
    user_id: st.user_id, provider: "strava", status: "connected",
    account_label: [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || null,
    last_error: null,
  });

  // kick off the first import in the background (all past activities)
  const first = fetch(`${SUPABASE_URL}/functions/v1/strava-sync`, { method: "POST" }).catch(() => {});
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(first);

  return back("connected");
});

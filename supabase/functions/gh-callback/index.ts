// Google sends the browser here after you approve access. Stores tokens server-side,
// starts the first import, and sends you back to the app.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const APP_URL = "https://alextremmel.github.io/timeline/";
const back = (status: string) => Response.redirect(`${APP_URL}?google=${status}`, 302);

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (u.searchParams.get("error") || !code || !state) return back("cancelled");

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: st } = await admin.from("oauth_states").select("user_id, created_at")
    .eq("state", state).eq("provider", "google_health").maybeSingle();
  await admin.from("oauth_states").delete().eq("state", state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 30 * 60_000) return back("expired");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      redirect_uri: `${SUPABASE_URL}/functions/v1/gh-callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    await admin.from("connections").upsert({
      user_id: st.user_id, provider: "google_health", status: "error",
      last_error: `token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    });
    return back("failed");
  }
  const tok = await res.json();
  if (!tok.refresh_token) return back("no-refresh-token");

  // Google Health rejects tokens that also carry calendar scopes, so keep a health-only access token.
  let healthToken = tok.access_token, healthExpires = tok.expires_in || 3600;
  const narrowed = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: tok.refresh_token,
      grant_type: "refresh_token",
      scope: [
        "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
        "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
      ].join(" "),
    }),
  });
  let kind: string | null = null;
  if (narrowed.ok) {
    const n = await narrowed.json();
    healthToken = n.access_token; healthExpires = n.expires_in || 3600; kind = "health";
  }

  await admin.from("oauth_tokens").upsert({
    user_id: st.user_id, provider: "google_health",
    access_token: healthToken, refresh_token: tok.refresh_token, access_kind: kind,
    expires_at: new Date(Date.now() + healthExpires * 1000).toISOString(),
    scope: tok.scope || null, updated_at: new Date().toISOString(),
  });

  // Check the Google account is linked to Google Health
  const id = await fetch("https://health.googleapis.com/v4/users/me/identity", {
    headers: { Authorization: `Bearer ${healthToken}` },
  });
  const linked = id.ok;
  await admin.from("connections").upsert({
    user_id: st.user_id, provider: "google_health",
    status: linked ? "connected" : "error",
    cursor: null, last_sync_at: null,
    last_error: linked ? null : `identity check failed (${id.status}): ${(await id.text()).slice(0, 300)}`,
  });
  if (!linked) return back("not-linked");

  const first = fetch(`${SUPABASE_URL}/functions/v1/gh-sync`, { method: "POST" }).catch(() => {});
  // @ts-ignore EdgeRuntime is provided by Supabase
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(first);
  return back("connected");
});

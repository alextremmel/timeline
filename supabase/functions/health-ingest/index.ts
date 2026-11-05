// Receives Apple Health data sent by the iPhone Shortcut.
// The Shortcut proves who it is with a private key in the "x-timeline-key" header.
// Every delivery is stored as-is in health_raw; turning it into timeline entries
// happens in process() (added once the delivery format is confirmed).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const key = req.headers.get("x-timeline-key") || new URL(req.url).searchParams.get("key") || "";
  if (!key) return reply({ error: "Missing key." }, 401);
  const { data: k } = await admin.from("ingest_keys").select("user_id").eq("key_hash", await sha256(key)).maybeSingle();
  if (!k) return reply({ error: "Wrong key." }, 401);

  const contentType = req.headers.get("content-type") || "";
  const text = await req.text();
  if (text.length > 5_000_000) return reply({ error: "Too much data in one delivery." }, 413);
  let payload: unknown = null;
  try { payload = JSON.parse(text); } catch { /* keep as text */ }

  const { data: row, error } = await admin.from("health_raw").insert({
    user_id: k.user_id, content_type: contentType,
    payload, payload_text: payload === null ? text : null,
  }).select("id").single();
  if (error) return reply({ error: "Couldn't store the delivery." }, 500);

  const now = new Date().toISOString();
  await admin.from("ingest_keys").update({ last_used_at: now }).eq("key_hash", await sha256(key));
  await admin.from("connections").upsert({
    user_id: k.user_id, provider: "apple_health", status: "connected", last_sync_at: now, last_error: null,
  });

  return reply({ ok: true, delivery: row.id, bytes: text.length });
});

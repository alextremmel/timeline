"use strict";
/* Timeline of Me — a private, time-stamped personal log backed by Supabase. */

const TAGS = [
  { k: "food", label: "Food" }, { k: "drink", label: "Drink" }, { k: "weight", label: "Weight" },
  { k: "mood", label: "Mood" }, { k: "symptom", label: "Symptom" }, { k: "activity", label: "Activity" },
  { k: "sleep", label: "Sleep" }, { k: "meds", label: "Meds" }, { k: "note", label: "Note" },
];
const TAGMAP = Object.fromEntries(TAGS.map(t => [t.k, t]));
const PAGE = 60;
const BUCKET = "photos";

const $ = id => document.getElementById(id);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}
const pad = n => String(n).padStart(2, "0");
const ms = ts => new Date(ts).getTime();
const dayKey = t => { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const toLocalInput = t => { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

/* ---------- clock ---------- */
function tick() { const d = new Date(); $("clock").textContent = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " · " + fmtTime(d); }
tick(); setInterval(tick, 15000);

/* ---------- supabase ---------- */
const cfg = window.TIMELINE_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

/* ---------- state ---------- */
const S = {
  user: null, entries: new Map(), oldestTs: null, hasMore: false, loading: false, loaded: false,
  filter: null, draft: null, editing: null, lastAdded: null, confirmId: null,
  urls: new Map(), // storage path -> {url, exp}
};
const freshDraft = () => ({ tags: new Set(), values: {}, photos: [], whenMs: null });
S.draft = freshDraft();

/* ---------- auth ---------- */
async function showForSession(session) {
  S.user = session?.user || null;
  $("signinView").hidden = !!S.user;
  $("appView").hidden = !S.user;
  $("signOutBtn").hidden = !S.user;
  if (S.user && !S.loaded) { S.loaded = true; await loadEntries(true); }
  if (!S.user) { S.loaded = false; S.entries.clear(); S.urls.clear(); renderFeed(); }
}
$("signinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("signinBtn"), err = $("signinError");
  err.hidden = true; btn.disabled = true; btn.textContent = "Signing in…";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  btn.disabled = false; btn.textContent = "Sign in";
  if (error) {
    err.textContent = /invalid/i.test(error.message) ? "That email and password don't match. Check them and try again." : "Couldn't sign in: " + error.message;
    err.hidden = false;
  }
});
$("signOutBtn").onclick = async () => { await sb.auth.signOut(); resetComposer(); };
sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "INITIAL_SESSION") setTimeout(() => showForSession(session), 0);
});

/* ---------- data ---------- */
const SELECT = "id, ts, tz, body, tags, weight_lb, mood, severity, rested, source, source_id, details, created_at, entry_photos(id, path, width, height, created_at)";
async function loadEntries(reset) {
  if (S.loading) return;
  S.loading = true;
  if (reset) { S.entries.clear(); S.oldestTs = null; }
  renderFeed();
  let q = sb.from("entries").select(SELECT).order("ts", { ascending: false }).limit(PAGE);
  if (!reset && S.oldestTs) q = q.lt("ts", S.oldestTs);
  const { data, error } = await q;
  S.loading = false;
  if (error) { showStatus("Your log couldn't load. Check your connection, then pull down to refresh."); renderFeed(); return; }
  $("status").hidden = true;
  for (const e of data) S.entries.set(e.id, e);
  if (data.length) S.oldestTs = data[data.length - 1].ts;
  S.hasMore = data.length === PAGE;
  await signPhotos([...S.entries.values()]);
  renderFeed();
}
async function reloadOne(id) {
  const { data, error } = await sb.from("entries").select(SELECT).eq("id", id).maybeSingle();
  if (error) return;
  if (data) { S.entries.set(id, data); await signPhotos([data]); } else S.entries.delete(id);
}
async function signPhotos(list) {
  const now = Date.now();
  const need = [];
  for (const e of list) for (const p of e.entry_photos || []) {
    const c = S.urls.get(p.path);
    if (!c || c.exp < now + 60000) need.push(p.path);
  }
  if (!need.length) return;
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
  for (const r of data || []) if (r.signedUrl) S.urls.set(r.path, { url: r.signedUrl, exp: now + 3600 * 1000 });
}
function showStatus(msg) { const s = $("status"); s.textContent = msg; s.hidden = false; }
$("moreBtn").onclick = () => loadEntries(false);

/* ---------- composer ---------- */
function renderTagChips() {
  const box = $("tagChips"); box.replaceChildren();
  for (const t of TAGS) box.append(h("button", {
    type: "button", class: "chip", style: `--c:var(--t-${t.k})`, "aria-pressed": String(S.draft.tags.has(t.k)),
    onclick: () => { S.draft.tags.has(t.k) ? S.draft.tags.delete(t.k) : S.draft.tags.add(t.k); renderTagChips(); renderExtras(); },
  }, t.label));
}
function scale(name, max, hint) {
  const wrap = h("div", { class: "scale", role: "group", "aria-label": name });
  for (let i = 1; i <= max; i++) wrap.append(h("button", {
    type: "button", "aria-pressed": String(S.draft.values[name] === i),
    onclick: () => { S.draft.values[name] = S.draft.values[name] === i ? undefined : i; renderExtras(); },
  }, i));
  return [wrap, h("span", { class: "scale-hint", text: hint })];
}
function renderExtras() {
  const box = $("extras"); box.replaceChildren();
  if (S.draft.tags.has("weight")) {
    const inp = h("input", { id: "weightInput", class: "num", type: "number", inputmode: "decimal", step: "0.1", placeholder: "lb", value: S.draft.values.weight ?? "" });
    inp.addEventListener("input", () => { const v = parseFloat(inp.value); S.draft.values.weight = isFinite(v) ? v : undefined; });
    box.append(h("div", { class: "extra" }, h("label", { for: "weightInput", text: "Weight" }), inp, h("span", { class: "scale-hint", text: "pounds" })));
  }
  if (S.draft.tags.has("mood")) box.append(h("div", { class: "extra" }, h("label", { text: "Mood" }), ...scale("mood", 5, "1 awful · 5 great")));
  if (S.draft.tags.has("symptom")) box.append(h("div", { class: "extra" }, h("label", { text: "Severity" }), ...scale("severity", 10, "1 barely · 10 worst")));
  if (S.draft.tags.has("sleep")) box.append(h("div", { class: "extra" }, h("label", { text: "Rested" }), ...scale("rested", 5, "1 exhausted · 5 fully rested")));
}
function renderThumbs() {
  const box = $("thumbs"); box.replaceChildren(); box.hidden = !S.draft.photos.length;
  S.draft.photos.forEach((p, i) => box.append(h("div", { class: "thumb" },
    h("img", { src: p.preview, alt: "Photo to attach" }),
    h("button", { type: "button", "aria-label": "Remove photo", onclick: () => { if (p.blob) URL.revokeObjectURL(p.preview); S.draft.photos.splice(i, 1); renderThumbs(); } }, "×"))));
}
function renderWhen() {
  $("whenLabel").textContent = S.draft.whenMs == null ? "Now" : new Date(S.draft.whenMs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
$("whenBtn").onclick = () => { const i = $("whenInput"); i.hidden = !i.hidden; if (!i.hidden) { i.value = toLocalInput(S.draft.whenMs ?? Date.now()); i.focus(); } };
$("whenInput").addEventListener("change", e => { const v = e.target.value; S.draft.whenMs = v ? new Date(v).getTime() : null; renderWhen(); });

async function shrink(file) {
  let src;
  try { src = await createImageBitmap(file); }
  catch { src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
  const w = src.width, ht = src.height, s = Math.min(1, 1600 / Math.max(w, ht));
  const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(ht * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
  return { blob, w: c.width, h: c.height };
}
$("photoInput").addEventListener("change", async e => {
  for (const f of e.target.files) {
    try { const r = await shrink(f); S.draft.photos.push({ ...r, preview: URL.createObjectURL(r.blob) }); }
    catch { toast("That photo couldn't be read. Try a different one."); }
  }
  e.target.value = ""; renderThumbs();
});

function resetComposer() {
  for (const p of S.draft.photos) if (p.blob) URL.revokeObjectURL(p.preview);
  S.draft = freshDraft(); S.editing = null; $("text").value = ""; $("whenInput").hidden = true;
  $("editFlag").hidden = true; $("composer").classList.remove("editing"); $("saveBtn").textContent = "Log it";
  renderTagChips(); renderExtras(); renderThumbs(); renderWhen();
}
$("cancelEdit").onclick = resetComposer;

function startEdit(id) {
  const e = S.entries.get(id); if (!e) return;
  resetComposer(); S.editing = id;
  $("text").value = e.body || "";
  S.draft.tags = new Set(e.tags || []);
  S.draft.values = { weight: e.weight_lb ?? undefined, mood: e.mood ?? undefined, severity: e.severity ?? undefined, rested: e.rested ?? undefined };
  S.draft.photos = (e.entry_photos || []).map(p => ({ existing: p, preview: S.urls.get(p.path)?.url || "" }));
  S.draft.whenMs = ms(e.ts);
  $("editFlag").hidden = false; $("composer").classList.add("editing"); $("saveBtn").textContent = "Save changes";
  renderTagChips(); renderExtras(); renderThumbs(); renderWhen();
  window.scrollTo({ top: 0, behavior: "smooth" }); $("text").focus();
}

$("composer").addEventListener("submit", async ev => {
  ev.preventDefault();
  const text = $("text").value.trim();
  const v = S.draft.values;
  if (!text && !S.draft.photos.length && ![v.weight, v.mood, v.severity, v.rested].some(x => x != null)) { toast("Write something or add a photo first."); return; }
  const btn = $("saveBtn"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const tags = [...S.draft.tags];
    const newPhotos = S.draft.photos.filter(p => p.blob);
    if (!tags.length && !newPhotos.length && !S.draft.photos.length) tags.push("note");
    const row = {
      ts: new Date(S.draft.whenMs ?? Date.now()).toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      body: text || null, tags,
      weight_lb: v.weight ?? null, mood: v.mood ?? null, severity: v.severity ?? null, rested: v.rested ?? null,
    };
    let id = S.editing;
    if (id) {
      const { error } = await sb.from("entries").update(row).eq("id", id);
      if (error) throw error;
      // photos removed during the edit
      const kept = new Set(S.draft.photos.filter(p => p.existing).map(p => p.existing.id));
      const removed = (S.entries.get(id)?.entry_photos || []).filter(p => !kept.has(p.id));
      if (removed.length) {
        await sb.from("entry_photos").delete().in("id", removed.map(p => p.id));
        await sb.storage.from(BUCKET).remove(removed.map(p => p.path));
      }
    } else {
      const { data, error } = await sb.from("entries").insert(row).select("id").single();
      if (error) throw error;
      id = data.id;
    }
    for (const p of newPhotos) {
      const path = `${S.user.id}/${id}/${uuid()}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const { error } = await sb.from("entry_photos").insert({ entry_id: id, path, width: p.w, height: p.h });
      if (error) throw error;
    }
    await reloadOne(id);
    S.lastAdded = id;
    resetComposer();
    renderFeed();
    toast(label === "Save changes" ? "Saved" : "Logged");
  } catch (e) {
    console.error(e);
    toast(/jwt|auth/i.test(e?.message || "") ? "You've been signed out. Sign in again and retry." : "Couldn't save. Check your connection and try again.");
    btn.textContent = label;
  } finally {
    btn.disabled = false;
    if (btn.textContent === "Saving…") btn.textContent = label;
  }
});

/* ---------- feed ---------- */
function renderFilters() {
  const box = $("filters"); box.replaceChildren();
  box.append(h("button", { type: "button", class: "chip", "aria-pressed": String(!S.filter), onclick: () => { S.filter = null; renderFilters(); renderFeed(); } }, "Everything"));
  for (const t of TAGS) box.append(h("button", {
    type: "button", class: "chip", style: `--c:var(--t-${t.k})`, "aria-pressed": String(S.filter === t.k),
    onclick: () => { S.filter = S.filter === t.k ? null : t.k; renderFilters(); renderFeed(); },
  }, t.label));
}
function visible() {
  let list = [...S.entries.values()];
  if (S.filter) list = list.filter(e => (e.tags || []).includes(S.filter));
  return list.sort((a, b) => ms(b.ts) - ms(a.ts));
}
function dayLabel(key) {
  const today = dayKey(Date.now()), yest = dayKey(Date.now() - 864e5);
  if (key === today) return "Today";
  if (key === yest) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: y === new Date().getFullYear() ? undefined : "numeric" });
}
function valChips(e) {
  const out = [];
  if (e.weight_lb != null) out.push(Number(e.weight_lb) + " lb");
  if (e.mood != null) out.push("mood " + e.mood + "/5");
  if (e.severity != null) out.push("severity " + e.severity + "/10");
  if (e.rested != null) out.push("rested " + e.rested + "/5");
  return out;
}
function renderEntry(e) {
  const first = (e.tags || []).find(t => TAGMAP[t]) || "note";
  const li = h("li", { class: "entry" + (S.lastAdded === e.id ? " new" : ""), style: `--c:var(--t-${first})` });
  li.append(h("div", { class: "entry-head" },
    h("span", { class: "time", text: fmtTime(e.ts) }),
    ...(e.tags || []).map(t => h("span", { class: "tag", style: `--c:var(--t-${TAGMAP[t] ? t : "note"})`, text: TAGMAP[t]?.label || t })),
    e.source && e.source !== "me" ? h("span", { class: "src", text: e.source }) : null));
  if (e.body) li.append(h("p", { class: "body", text: e.body }));
  const vals = valChips(e);
  if (vals.length) li.append(h("div", { class: "vals" }, vals.map(t => h("span", { class: "val", text: t }))));
  const photos = e.entry_photos || [];
  if (photos.length) li.append(h("div", { class: "pics" }, photos.map(p => {
    const u = S.urls.get(p.path)?.url;
    return h("button", { type: "button", "aria-label": "Open photo", onclick: () => u && openPhoto(u) }, u ? h("img", { src: u, alt: "", loading: "lazy" }) : null);
  })));
  if (!e.source || e.source === "me") {
    if (S.confirmId === e.id) {
      li.append(h("div", { class: "confirm" },
        h("span", { text: "Delete this entry" + (photos.length ? " and its photos" : "") + "?" }),
        h("button", { type: "button", class: "yes", onclick: () => del(e) }, "Delete"),
        h("button", { type: "button", onclick: () => { S.confirmId = null; renderFeed(); } }, "Keep")));
    } else {
      li.append(h("div", { class: "entry-tools" },
        h("button", { type: "button", onclick: () => startEdit(e.id) }, "Edit"),
        h("button", { type: "button", class: "del", onclick: () => { S.confirmId = e.id; renderFeed(); } }, "Delete")));
    }
  }
  return li;
}
async function del(e) {
  S.confirmId = null;
  const paths = (e.entry_photos || []).map(p => p.path);
  const { error } = await sb.from("entries").delete().eq("id", e.id);
  if (error) { toast("Couldn't delete. Try again."); renderFeed(); return; }
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  S.entries.delete(e.id);
  if (S.editing === e.id) resetComposer();
  renderFeed(); toast("Deleted");
}
function renderFeed() {
  const feed = $("feed"); const list = visible(); feed.replaceChildren();
  $("count").textContent = S.entries.size ? `${list.length} ${list.length === 1 ? "entry" : "entries"} shown` : "";
  if (!list.length) {
    if (S.loading) feed.append(h("div", { class: "empty" }, h("strong", { text: "Opening your log…" }), "Your entries will appear here, newest first."));
    else if (S.filter) feed.append(h("div", { class: "empty" }, h("strong", { text: "Nothing tagged " + TAGMAP[S.filter].label + " in what's loaded" }), "Pick Everything to see the whole log, or show older entries below."));
    else if (S.user) feed.append(h("div", { class: "empty" }, h("strong", { text: "Your timeline starts with the first entry" }), "Type what you had for breakfast, snap the scale, or note how you're feeling, then tap Log it. Each entry gets stamped with the time."));
  } else {
    let curDay = null, ul;
    const counts = {};
    for (const e of list) { const k = dayKey(e.ts); counts[k] = (counts[k] || 0) + 1; }
    for (const e of list) {
      const k = dayKey(e.ts);
      if (k !== curDay) {
        curDay = k;
        const sec = h("section", { class: "day" }, h("h2", null, dayLabel(k), h("small", { text: counts[k] + (counts[k] === 1 ? " entry" : " entries") })));
        ul = h("ul", { class: "entries" }); sec.append(ul); feed.append(sec);
      }
      ul.append(renderEntry(e));
    }
  }
  $("moreBtn").hidden = !S.hasMore || S.loading;
  S.lastAdded = null;
}
function openPhoto(url) { $("lightImg").src = url; $("lightbox").hidden = false; }
$("lightbox").onclick = () => { $("lightbox").hidden = true; $("lightImg").removeAttribute("src"); };
document.addEventListener("keydown", e => { if (e.key === "Escape") $("lightbox").hidden = true; });

/* refresh when the app comes back to the foreground */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.user && !S.loading) loadEntries(true);
});

/* ---------- copy for AI ---------- */
$("copyBtn").onclick = async () => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data, error } = await sb.from("entries").select("ts, body, tags, weight_lb, mood, severity, rested, source, entry_photos(id)").gte("ts", since).order("ts", { ascending: true }).limit(2000);
  if (error) { toast("Couldn't read your log. Try again."); return; }
  if (!data.length) { toast("Nothing from the last 30 days yet."); return; }
  const lines = ["My personal log, last 30 days (local time):"];
  for (const e of data) {
    const d = new Date(e.ts);
    const stamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    const bits = [stamp, "[" + (e.tags || []).map(t => TAGMAP[t]?.label || t).join(", ") + "]"];
    if (e.body) bits.push(e.body.replace(/\s+/g, " "));
    const v = valChips(e); if (v.length) bits.push("(" + v.join("; ") + ")");
    const n = (e.entry_photos || []).length; if (n) bits.push(`[${n} photo${n > 1 ? "s" : ""}]`);
    if (e.source && e.source !== "me") bits.push("source: " + e.source);
    lines.push(bits.join(" "));
  }
  const txt = lines.join("\n");
  try { await navigator.clipboard.writeText(txt); toast("Copied " + data.length + " entries"); }
  catch {
    const ta = h("textarea", { style: "position:fixed;top:0;left:0;opacity:0" }); ta.value = txt; document.body.append(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied " + data.length + " entries"); } catch { toast("Copy was blocked on this device."); }
    ta.remove();
  }
};

/* ---------- boot ---------- */
renderTagChips(); renderExtras(); renderWhen(); renderFilters(); renderFeed();

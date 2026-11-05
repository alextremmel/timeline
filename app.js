"use strict";
/* Timeline of Me — a private, time-stamped personal log backed by Supabase.
   Chat-style: newest entries at the bottom, older ones further up, log box pinned below. */

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
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

/* ---------- supabase ---------- */
const cfg = window.TIMELINE_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

/* ---------- state ---------- */
const S = {
  user: null, entries: new Map(), oldestTs: null, hasMore: false, loading: false, loaded: false,
  draft: null, editing: null, lastAdded: null, openId: null, confirmId: null,
  urls: new Map(), // storage path -> {url, exp}
  pending: new Map(), // entries saved on the phone, waiting to send
  searching: false, searchQ: "", searchResults: null, flushing: false,
};
const freshDraft = () => ({ photos: [], whenMs: null });
S.draft = freshDraft();

/* ---------- scrolling + keyboard ---------- */
const scroller = $("scroller");
const shell = $("appView");
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

// Keep the app exactly the size of the visible screen so the log box sits right above the keyboard.
function fitViewport() {
  const vv = window.visualViewport;
  const stick = nearBottom();
  const hgt = vv ? vv.height : window.innerHeight;
  shell.style.height = hgt + "px";
  shell.style.top = (vv ? vv.offsetTop : 0) + "px";
  document.body.classList.toggle("kb", !!vv && window.innerHeight - vv.height > 120);
  if (stick) toBottom();
}
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitViewport);
  visualViewport.addEventListener("scroll", fitViewport);
}
window.addEventListener("resize", fitViewport);

// Load older entries when scrolled near the top.
scroller.addEventListener("scroll", () => {
  if (scroller.scrollTop < 300 && S.hasMore && !S.loading && S.user && !S.searching) loadEntries(false);
}, { passive: true });

/* ---------- auth ---------- */
async function showForSession(session) {
  S.user = session?.user || null;
  $("signinView").hidden = !!S.user;
  shell.hidden = !S.user;
  document.body.classList.toggle("app-on", !!S.user);
  if (S.user) fitViewport();
  if (S.user && !S.loaded) { S.loaded = true; await loadOutbox(); await loadEntries(true); flushOutbox(); syncAll(); }
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
// Sign out needs two taps so it can't happen by accident.
$("signOutBtn").onclick = async () => {
  const b = $("signOutBtn");
  if (b.dataset.armed !== "1") {
    b.dataset.armed = "1"; b.querySelector(".sheet-title").textContent = "Tap again to sign out";
    setTimeout(() => { b.dataset.armed = ""; b.querySelector(".sheet-title").textContent = "Sign out"; }, 4000);
    return;
  }
  b.dataset.armed = ""; b.querySelector(".sheet-title").textContent = "Sign out";
  closeSheet(); await sb.auth.signOut(); resetComposer();
};
sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "INITIAL_SESSION") setTimeout(() => showForSession(session), 0);
});

/* ---------- outside connections ---------- */
const SOURCE_LABEL = { strava: "Strava", google_health: "Fitbit", apple_health: "Apple Health" };
function ago(ts) {
  if (!ts) return "not yet";
  const m = Math.round((Date.now() - ms(ts)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const hr = Math.round(m / 60);
  return hr < 24 ? hr + " hr ago" : Math.round(hr / 24) + " d ago";
}
const PROVIDERS = {
  google_health: { name: "Google Health", start: "gh-start", sync: "gh-sync", alwaysShow: true },
  strava: { name: "Strava", start: "strava-start", sync: "strava-sync", alwaysShow: false },
};
async function loadConnections() {
  const { data } = await sb.from("connections").select("provider, status, last_sync_at, last_error");
  const rows = data || [];
  const box = $("stravaConn"); box.replaceChildren();
  const line = (label, right) => h("div", { class: "status-line" }, h("span", { text: label }), right);
  const ah = rows.find(r => r.provider === "apple_health");
  box.append(line("Strava (iPhone shortcut)", h("span", { class: "muted", text: ah ? "synced " + ago(ah.last_sync_at) : "not synced yet" })));
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const c = rows.find(r => r.provider === key);
    if (!c && !p.alwaysShow) continue;
    const label = key === "google_health" ? "Fitbit (Google Health)" : p.name + " (direct)";
    if (!c) box.append(line(label, h("button", { type: "button", class: "link", onclick: () => connect(key) }, "Connect")));
    else if (c.status === "needs_reconnect" || c.status === "error" && !c.last_sync_at)
      box.append(line(label, h("button", { type: "button", class: "link warn", title: c.last_error || "", onclick: () => connect(key) }, "Reconnect")));
    else box.append(line(label, h("span", { class: c.last_error ? "warn" : "muted", title: c.last_error || "", text: (c.last_error ? "problem · " : "synced ") + ago(c.last_sync_at) })));
  }
}
async function connect(key) {
  const { data, error } = await sb.functions.invoke(PROVIDERS[key].start, { body: {} });
  if (error || !data?.url) { toast(data?.error || "Couldn't start connecting " + PROVIDERS[key].name + ". Try again."); return; }
  location.href = data.url;
}
async function syncAll() {
  const { data } = await sb.from("connections").select("provider");
  const keys = (data || []).map(r => r.provider).filter(k => PROVIDERS[k]);
  let changed = false;
  await Promise.all(keys.map(async k => {
    try {
      const { data: r } = await sb.functions.invoke(PROVIDERS[k].sync, { body: {} });
      if ((r?.results || []).some(x => (x.imported || x.entries || 0) > 0)) changed = true;
    } catch { /* the hourly sync will catch up */ }
  }));
  if (changed) await loadEntries(true);
  loadConnections();
}
(function handleReturn() {
  const p = new URLSearchParams(location.search);
  const key = p.has("google") ? "google" : p.has("strava") ? "strava" : null;
  if (!key) return;
  const s = p.get(key);
  const name = key === "google" ? "Google Health" : "Strava";
  history.replaceState(null, "", location.pathname);
  const msg = {
    connected: name + " connected. Importing your data…",
    cancelled: name + " wasn't connected.",
    expired: "That took too long. Tap Connect " + name + " again.",
    "needs-activity-access": "Strava needs permission to read your activities. Try again and leave that box checked.",
    "not-linked": "Your Google account isn't linked to Google Health yet. Open the Google Health app and sign in with Google, then try again.",
    "no-refresh-token": "Google didn't grant lasting access. Tap Connect Google Health again.",
    failed: name + " didn't accept the connection. Try again.",
  }[s] || name + ": " + s;
  setTimeout(() => toast(msg), 600);
  if (s === "connected") setTimeout(() => { if (S.user) { loadEntries(true); loadConnections(); } }, 15000);
})();

/* ---------- data ---------- */
const SELECT = "id, ts, tz, body, source, source_id, details, created_at, entry_photos(id, path, width, height, created_at)";
async function loadEntries(reset) {
  if (S.loading) return;
  S.loading = true;
  if (reset) S.oldestTs = null;
  if (!S.entries.size) renderFeed();
  let q = sb.from("entries").select(SELECT).order("ts", { ascending: false }).limit(PAGE);
  if (!reset && S.oldestTs) q = q.lt("ts", S.oldestTs);
  const { data, error } = await q;
  S.loading = false;
  if (error) { showStatus("Your log couldn't load. Check your connection and reopen the app."); renderFeed(); return; }
  $("status").hidden = true;
  if (reset) S.entries.clear();
  for (const e of data) S.entries.set(e.id, e);
  if (data.length) S.oldestTs = data[data.length - 1].ts;
  S.hasMore = data.length === PAGE;
  await signPhotos([...S.entries.values()]);
  if (reset) { renderFeed(); toBottom(); }
  else {
    // keep the entry you were looking at in place while older ones appear above it
    const before = scroller.scrollHeight - scroller.scrollTop;
    renderFeed();
    scroller.scrollTop = scroller.scrollHeight - before;
  }
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
const textEl = $("text");
function autoGrow() {
  const stick = nearBottom();
  textEl.style.height = "auto";
  textEl.style.height = textEl.scrollHeight + 2 + "px";
  if (stick) toBottom();
}
textEl.addEventListener("input", autoGrow);
textEl.addEventListener("focus", () => setTimeout(() => { fitViewport(); toBottom(); }, 300));

function renderThumbs() {
  const box = $("thumbs"); box.replaceChildren(); box.hidden = !S.draft.photos.length;
  S.draft.photos.forEach((p, i) => box.append(h("div", { class: "thumb" },
    p.preview ? h("img", { src: p.preview, alt: "Photo to attach" }) : null,
    h("button", { type: "button", "aria-label": "Remove photo", onclick: () => { if (p.blob) URL.revokeObjectURL(p.preview); S.draft.photos.splice(i, 1); renderThumbs(); } }, "×"))));
}
function renderWhen() {
  const changed = S.draft.whenMs != null;
  $("whenBtn").classList.toggle("changed", changed);
  $("whenBtn").setAttribute("aria-label", changed ? "Time: " + new Date(S.draft.whenMs).toLocaleString() : "Change time (now)");
  if (changed) { $("whenRow").hidden = false; $("whenInput").value = toLocalInput(S.draft.whenMs); }
}
$("whenBtn").onclick = () => {
  const row = $("whenRow");
  if (row.hidden) { row.hidden = false; $("whenInput").value = toLocalInput(S.draft.whenMs ?? Date.now()); $("whenInput").focus(); }
  else if (S.draft.whenMs == null) row.hidden = true;
};
$("whenInput").addEventListener("change", e => { const v = e.target.value; S.draft.whenMs = v ? new Date(v).getTime() : null; renderWhen(); });
$("whenNow").onclick = () => { S.draft.whenMs = null; $("whenRow").hidden = true; renderWhen(); };

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
  S.draft = freshDraft(); S.editing = null; textEl.value = ""; textEl.style.height = ""; $("whenRow").hidden = true;
  $("editFlag").hidden = true; $("composer").classList.remove("editing"); $("saveBtn").setAttribute("aria-label", "Log entry");
  renderThumbs(); renderWhen();
}
$("cancelEdit").onclick = () => { resetComposer(); renderFeed(); };

function startEdit(id) {
  const e = S.entries.get(id); if (!e) return;
  resetComposer(); S.editing = id; S.openId = null;
  textEl.value = e.body || "";
  S.draft.photos = (e.entry_photos || []).map(p => ({ existing: p, preview: S.urls.get(p.path)?.url || "" }));
  S.draft.whenMs = ms(e.ts);
  $("editFlag").hidden = false; $("composer").classList.add("editing"); $("saveBtn").setAttribute("aria-label", "Save changes");
  renderThumbs(); renderWhen(); renderFeed();
  textEl.focus(); autoGrow();
}

$("composer").addEventListener("submit", async ev => {
  ev.preventDefault();
  if (S.searching) return;
  const text = textEl.value.trim();
  if (!text && !S.draft.photos.length) { toast("Write something or add a photo first."); return; }
  if (!S.editing) { await queueNew(text); return; }

  // Editing an existing entry needs a connection
  const btn = $("saveBtn"), id = S.editing;
  btn.disabled = true; btn.classList.add("busy");
  try {
    const row = { ts: new Date(S.draft.whenMs ?? Date.now()).toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, body: text || null };
    const { error } = await sb.from("entries").update(row).eq("id", id);
    if (error) throw error;
    const kept = new Set(S.draft.photos.filter(p => p.existing).map(p => p.existing.id));
    const removed = (S.entries.get(id)?.entry_photos || []).filter(p => !kept.has(p.id));
    if (removed.length) {
      await sb.from("entry_photos").delete().in("id", removed.map(p => p.id));
      await sb.storage.from(BUCKET).remove(removed.map(p => p.path));
    }
    for (const p of S.draft.photos.filter(p => p.blob)) {
      const path = `${S.user.id}/${id}/${uuid()}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      const { error: e2 } = await sb.from("entry_photos").insert({ entry_id: id, path, width: p.w, height: p.h });
      if (e2) throw e2;
    }
    await reloadOne(id);
    S.lastAdded = id;
    resetComposer(); renderFeed(); toast("Saved");
  } catch (e) {
    console.error(e);
    toast(navigator.onLine === false ? "You're offline. Edits need a connection, so try again when you're back online." : "Couldn't save. Check your connection and try again.");
  } finally {
    btn.disabled = false; btn.classList.remove("busy");
  }
});

/* ---------- saving with no signal: everything new goes to an outbox on the phone first ---------- */
const outbox = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("timeline", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("outbox", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("outbox", mode); const req = fn(t.objectStore("outbox"));
      t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error);
    });
  };
  return { put: o => run("readwrite", st => st.put(o)), del: id => run("readwrite", st => st.delete(id)), all: () => run("readonly", st => st.getAll()) };
})();
function pendingEntry(item) {
  return { id: item.id, ts: item.row.ts, tz: item.row.tz, body: item.row.body, source: "me", details: {}, pending: true,
    entry_photos: item.photos.map(p => ({ id: p.id, preview: p.preview || (p.preview = URL.createObjectURL(p.blob)) })) };
}
async function loadOutbox() {
  try { for (const item of await outbox.all() || []) if (item.userId === S.user?.id) S.pending.set(item.id, item); } catch { /* storage unavailable */ }
}
async function queueNew(text) {
  const id = uuid();
  const item = {
    id, userId: S.user.id, createdAt: Date.now(),
    row: { id, ts: new Date(S.draft.whenMs ?? Date.now()).toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, body: text || null },
    photos: S.draft.photos.filter(p => p.blob).map(p => ({ id: uuid(), blob: p.blob, w: p.w, h: p.h })),
  };
  try { await outbox.put({ ...item, photos: item.photos.map(({ preview, ...rest }) => rest) }); } catch { /* kept in memory for this session */ }
  S.pending.set(id, item);
  S.lastAdded = id;
  resetComposer(); renderFeed(); toBottom();
  flushOutbox(true);
}
const already = e => e && (e.code === "23505" || /duplicate|already exists/i.test(e.message || "") || e.statusCode === "409");
async function sendItem(item) {
  const { error } = await sb.from("entries").insert(item.row);
  if (error && !already(error)) throw error;
  for (const p of item.photos) {
    const path = `${item.userId}/${item.id}/${p.id}.jpg`;
    const up = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
    if (up.error && !already(up.error)) throw up.error;
    const { error: e2 } = await sb.from("entry_photos").insert({ id: p.id, entry_id: item.id, path, width: p.w, height: p.h });
    if (e2 && !already(e2)) throw e2;
  }
}
async function flushOutbox(fresh) {
  if (S.flushing || !S.user || !S.pending.size) return;
  S.flushing = true;
  let sent = 0, failed = false;
  try {
    for (const item of [...S.pending.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        await sendItem(item);
        try { await outbox.del(item.id); } catch { /* fine */ }
        S.pending.delete(item.id);
        for (const p of item.photos) if (p.preview) URL.revokeObjectURL(p.preview);
        await reloadOne(item.id);
        sent++;
      } catch (e) { console.warn("still waiting to send", e); failed = true; break; }
    }
  } finally { S.flushing = false; }
  renderFeed();
  if (fresh) toast(failed ? "Saved on your phone. It'll send when you're back online." : "Logged");
  else if (sent) toast(sent === 1 ? "Sent 1 saved entry" : `Sent ${sent} saved entries`);
}
window.addEventListener("online", () => flushOutbox());
setInterval(() => { if (S.pending.size && navigator.onLine !== false) flushOutbox(); }, 30000);

/* ---------- the ⋯ panel ---------- */
function openSheet() { $("sheet").hidden = false; $("sheetBackdrop").hidden = false; loadConnections(); }
function closeSheet() { $("sheet").hidden = true; $("sheetBackdrop").hidden = true; }
$("moreMenuBtn").onclick = openSheet;
$("sheetBackdrop").onclick = closeSheet;
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
$("syncStravaBtn").onclick = () => {
  closeSheet();
  // Opens the Shortcuts app and runs the shortcut; swipe back to Timeline afterwards.
  location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent("Timeline Health");
};

/* ---------- search ---------- */
$("searchBtn").onclick = () => { closeSheet(); enterSearch(); };
function enterSearch() {
  if (S.editing) resetComposer();
  S.searching = true; S.searchQ = ""; S.searchResults = null;
  $("logBar").hidden = true; $("thumbs").hidden = true; $("whenRow").hidden = true; $("editFlag").hidden = true;
  $("searchBar").hidden = false; $("searchInput").value = "";
  $("searchInput").focus(); renderFeed();
}
function exitSearch() {
  S.searching = false; S.searchQ = ""; S.searchResults = null;
  $("searchBar").hidden = true; $("logBar").hidden = false; renderThumbs();
  renderFeed(); toBottom();
}
$("searchDone").onclick = exitSearch;
let searchTimer;
$("searchInput").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 300);
});
async function runSearch(q) {
  S.searchQ = q;
  if (q.length < 2) { S.searchResults = null; renderFeed(); return; }
  const like = "%" + q.replace(/[\\%_]/g, m => "\\" + m) + "%";
  const { data, error } = await sb.from("entries").select(SELECT).ilike("body", like).order("ts", { ascending: false }).limit(200);
  if (q !== S.searchQ || !S.searching) return;
  if (error) { toast("Search didn't work. Check your connection."); return; }
  S.searchResults = data || [];
  await signPhotos(S.searchResults);
  renderFeed(); toBottom();
}
function highlighted(text) {
  const q = S.searching ? S.searchQ : "";
  if (!q || q.length < 2 || !text) return document.createTextNode(text || "");
  const frag = document.createDocumentFragment(), lower = text.toLowerCase(), ql = q.toLowerCase();
  let i = 0, j;
  while ((j = lower.indexOf(ql, i)) !== -1) {
    frag.append(text.slice(i, j), h("mark", { text: text.slice(j, j + q.length) }));
    i = j + q.length;
  }
  frag.append(text.slice(i));
  return frag;
}

/* ---------- tap to log again, press and hold to edit ---------- */
function pressable(el, onTap, onHold) {
  let timer, held = false, sx = 0, sy = 0;
  el.addEventListener("pointerdown", e => {
    held = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { held = true; if (navigator.vibrate) navigator.vibrate(10); onHold(); }, 500);
  });
  el.addEventListener("pointermove", e => { if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) clearTimeout(timer); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, () => clearTimeout(timer));
  el.addEventListener("contextmenu", e => e.preventDefault());
  el.addEventListener("click", e => { if (held) { e.preventDefault(); held = false; return; } onTap(); });
}
function logAgain(e) {
  if (S.searching) exitSearch();
  resetComposer();
  textEl.value = e.body || "";
  autoGrow(); textEl.focus();
  toast("Copied to the log box. Edit it or tap the arrow to log it now.");
}

/* ---------- feed (oldest at top, newest at bottom) ---------- */
function dayLabel(key) {
  const today = dayKey(Date.now()), yest = dayKey(Date.now() - 864e5);
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const short = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: y === new Date().getFullYear() ? undefined : "numeric" });
  if (key === today) return "Today · " + short;
  if (key === yest) return "Yesterday · " + short;
  return short;
}
const STAGE_COLOR = { AWAKE: "var(--st-awake)", REM: "var(--st-rem)", LIGHT: "var(--st-light)", DEEP: "var(--st-deep)" };
function clock(sec) {
  const s = Math.round(sec || 0), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
function hmText(min) { min = Math.round(min || 0); const hh = Math.floor(min / 60), mm = min % 60; return hh ? `${hh}h ${pad(mm)}m` : `${mm}m`; }
const num = n => Number(n).toLocaleString("en-US");
function boxHead(label, title, right) {
  return h("div", { class: "box-head" },
    h("span", { class: "box-label", text: label }),
    h("span", { class: "box-title", text: title }),
    right ? h("span", { class: "box-right", text: right }) : null);
}
function stat(value, unit) {
  return h("span", { class: "stat" }, h("b", { text: value }), unit ? h("span", { class: "unit", text: unit }) : null);
}
function stravaBox(e) {
  const d = e.details || {};
  const box = h("div", { class: "box strava" });
  if (d.distance_mi == null) { box.append(boxHead("STRAVA", "Activity", fmtTime(e.ts)), h("p", { class: "body", text: e.body || "" })); return box; }
  const kind = d.kind || "Activity";
  const range = d.end ? `${fmtTime(d.start || e.ts)} – ${fmtTime(d.end)}` : fmtTime(e.ts);
  const miles = Number(d.distance_mi), secs = Number(d.duration_s || 0);
  const stats = h("div", { class: "stats" }, stat(miles < 10 ? miles.toFixed(2) : miles.toFixed(1), "mi"), stat(clock(secs)));
  if (miles >= 0.1 && secs > 0) stats.append(kind === "Bike" ? stat((miles / (secs / 3600)).toFixed(1), "mph") : stat(clock(secs / miles), "/mi"));
  box.append(boxHead("STRAVA", kind, range), stats);
  return box;
}
function sleepBox(e) {
  const d = e.details || {};
  const start = d.start || e.ts, end = d.end || e.ts;
  const box = h("div", { class: "box fitbit" },
    boxHead("FITBIT", d.kind === "nap" ? "Nap" : "Sleep", `${fmtTime(start)} – ${fmtTime(end)}`));
  box.querySelector(".box-head").append(h("span", { class: "box-big", text: hmText(d.minutes_asleep) }));
  const t0 = ms(start), span = Math.max(1, ms(end) - t0);
  if (Array.isArray(d.stages) && d.stages.length) {
    const strip = h("div", { class: "stages", role: "img", "aria-label": "Sleep stages through the night" });
    for (const [type, a, b] of d.stages) {
      const left = (ms(a) - t0) / span * 100, width = Math.max(0.35, (ms(b) - ms(a)) / span * 100);
      strip.append(h("span", { style: `left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${STAGE_COLOR[type] || "var(--line)"}` }));
    }
    box.append(strip);
  }
  const hrv = d.hrv?.averageHeartRateVariabilityMilliseconds;
  if (d.resting_hr != null || hrv != null) {
    box.append(h("div", { class: "vitals" },
      d.resting_hr != null ? stat(String(d.resting_hr), "resting HR") : null,
      hrv != null ? stat(Math.round(hrv) + " ms", "HRV") : null));
  }
  return box;
}
function dayBox(e) {
  const d = e.details || {};
  const stats = h("div", { class: "stats" });
  if (d.steps != null) stats.append(stat(num(d.steps), "steps"));
  if (d.active_kcal != null) stats.append(stat(num(d.active_kcal), "active cal"));
  return h("div", { class: "box fitbit" }, boxHead("FITBIT", "Day total", fmtTime(e.ts)), stats);
}
function renderEntry(e) {
  const li = h("div", { class: "item" + (S.lastAdded === e.id ? " new" : "") });
  if (e.source === "strava") { li.append(stravaBox(e)); return li; }
  if (e.source === "google_health") { li.append(e.details?.kind === "day" ? dayBox(e) : sleepBox(e)); return li; }
  if (e.source && e.source !== "me") { li.append(h("div", { class: "box" }, boxHead((SOURCE_LABEL[e.source] || e.source).toUpperCase(), "", fmtTime(e.ts)), h("p", { class: "body", text: e.body || "" }))); return li; }

  // your own entry: time · text · small photos on the right
  // tap = log again, press and hold = edit / delete
  const photos = e.entry_photos || [];
  const row = h("div", { class: "note" + (S.openId === e.id ? " open" : "") + (S.editing === e.id ? " editing" : "") + (e.pending ? " pending" : "") });
  const body = h("span", { class: "body" }); body.append(highlighted(e.body || ""));
  const main = h("button", { type: "button", class: "note-main", "aria-label": e.pending ? undefined : "Log this again. Press and hold to edit or delete." },
    h("span", { class: "time", text: fmtTime(e.ts) }), body);
  if (!e.pending) pressable(main, () => logAgain(e), () => { S.openId = e.id; S.confirmId = null; renderFeed(); });
  row.append(main);
  if (photos.length) row.append(h("div", { class: "thumbs-r" }, photos.map(p => {
    const u = p.preview || S.urls.get(p.path)?.url;
    const img = u ? h("img", { src: u, alt: "", loading: "lazy" }) : null;
    if (img) img.addEventListener("load", () => { if (nearBottom()) toBottom(); }, { once: true });
    return h("button", { type: "button", class: "thumb-r", "aria-label": "Open photo", onclick: () => u && openPhoto(u) }, img);
  })));
  li.append(row);
  if (e.pending) li.append(h("div", { class: "pending-note", text: S.flushing ? "Sending…" : "Saved on your phone · waiting to send" }));
  if (S.openId === e.id && !e.pending) {
    li.append(S.confirmId === e.id
      ? h("div", { class: "entry-tools" },
          h("span", { text: "Delete" + (photos.length ? " this and its photos?" : " this entry?") }),
          h("button", { type: "button", class: "yes", onclick: () => del(e) }, "Delete"),
          h("button", { type: "button", onclick: () => { S.confirmId = null; renderFeed(); } }, "Keep"))
      : h("div", { class: "entry-tools" },
          h("button", { type: "button", onclick: () => startEdit(e.id) }, "Edit"),
          h("button", { type: "button", class: "danger", onclick: () => { S.confirmId = e.id; renderFeed(); } }, "Delete"),
          h("button", { type: "button", onclick: () => { S.openId = null; renderFeed(); } }, "Done")));
  }
  return li;
}
async function del(e) {
  S.confirmId = null; S.openId = null;
  const paths = (e.entry_photos || []).map(p => p.path);
  const { error } = await sb.from("entries").delete().eq("id", e.id);
  if (error) { toast("Couldn't delete. Try again."); renderFeed(); return; }
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  S.entries.delete(e.id);
  if (S.editing === e.id) resetComposer();
  renderFeed(); toast("Deleted");
}
function renderFeed() {
  const feed = $("feed");
  feed.replaceChildren();
  let list;
  if (S.searching) {
    if (!S.searchResults) {
      feed.append(h("div", { class: "empty" }, h("strong", { text: "Search your log" }), "Type at least two letters to find every entry that mentions them."));
      $("moreBtn").hidden = true;
      return;
    }
    list = [...S.searchResults].sort((a, b) => ms(a.ts) - ms(b.ts));
    feed.append(h("div", { class: "search-count", text: list.length ? `${list.length}${list.length === 200 ? "+" : ""} ${list.length === 1 ? "entry mentions" : "entries mention"} “${S.searchQ}”` : `Nothing mentions “${S.searchQ}”` }));
  } else {
    list = [...S.entries.values(), ...[...S.pending.values()].filter(it => !S.entries.has(it.id)).map(pendingEntry)]
      .sort((a, b) => ms(a.ts) - ms(b.ts));
  }
  if (!list.length && !S.searching) {
    if (S.loading) feed.append(h("div", { class: "empty" }, "Loading your log…"));
    else if (S.user) feed.append(h("div", { class: "empty" }, h("strong", { text: "Nothing logged yet" }), "Type anything below or add a photo, then tap the arrow. The time is stamped for you."));
  } else {
    let curDay = null, box;
    for (const e of list) {
      const k = dayKey(e.ts);
      if (k !== curDay) {
        curDay = k;
        const sec = h("section", { class: "day" }, h("h2", { text: dayLabel(k) }));
        box = h("div", { class: "items" }); sec.append(box); feed.append(sec);
      }
      box.append(renderEntry(e));
    }
  }
  $("moreBtn").hidden = S.searching || !S.hasMore || S.loading;
  S.lastAdded = null;
}
function openPhoto(url) { $("lightImg").src = url; $("lightbox").hidden = false; }
$("lightbox").onclick = () => { $("lightbox").hidden = true; $("lightImg").removeAttribute("src"); };
document.addEventListener("keydown", e => { if (e.key === "Escape") $("lightbox").hidden = true; });

/* refresh when the app comes back to the foreground */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.user && !S.loading && !S.editing && !S.searching) { flushOutbox(); loadEntries(true); syncAll(); }
});

/* ---------- boot ---------- */
renderThumbs(); renderWhen(); renderFeed();

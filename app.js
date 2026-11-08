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
// "Bottom" is the Now line: planned events sit below it and stay out of view until you scroll down.
function nowTarget() {
  const up = $("upcoming");
  if (up.hidden || !up.firstChild) return scroller.scrollHeight - scroller.clientHeight;
  const line = up.querySelector(".now-line");
  const y = scroller.scrollTop + line.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
  return Math.max(0, y - scroller.clientHeight + 8);
}
const nearBottom = () => Math.abs(nowTarget() - scroller.scrollTop) < 80;
const toBottom = () => { scroller.scrollTop = nowTarget(); };

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
  if (S.user && !S.loaded) { S.loaded = true; await loadOutbox(); await loadEntries(true); flushOutbox(); syncAll(); loadRefs(); loadUpcoming(); }
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
  const calText = { ok: "connected", no_calendar: "no calendar named “Exercise”", error: "couldn't load" }[S.upcomingStatus];
  if (S.upcomingStatus === "needs_calendar_access" || S.upcomingStatus === "needs_reconnect")
    box.append(line("Exercise calendar", h("button", { type: "button", class: "link", onclick: () => connect("google_health") }, "Connect")));
  else if (calText) box.append(line("Exercise calendar", h("span", { class: S.upcomingStatus === "ok" ? "muted" : "warn", text: calText })));
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
textEl.addEventListener("input", () => { autoGrow(); updateTyping(); updateRefChips(); });
function updateTyping() {
  $("composer").classList.toggle("typing", document.activeElement === textEl || textEl.value.trim() !== "");
}
textEl.addEventListener("blur", () => setTimeout(updateTyping, 0));
textEl.addEventListener("focus", () => { updateTyping(); setTimeout(() => { fitViewport(); toBottom(); }, 300); });

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
  S.draft = freshDraft(); S.editing = null; textEl.value = ""; textEl.style.height = ""; $("whenRow").hidden = true; updateTyping(); updateRefChips();
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
  return { id: item.id, ts: item.row.ts, tz: item.row.tz, body: item.row.body, source: "me", details: item.row.details || {}, pending: true,
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
  resetComposer();
  await queueItem(item);
}
async function queueItem(item) {
  try { await outbox.put({ ...item, photos: item.photos.map(({ preview, ...rest }) => rest) }); } catch { /* kept in memory for this session */ }
  S.pending.set(item.id, item);
  S.lastAdded = item.id;
  renderFeed(); toBottom();
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
  const { data, error } = await sb.from("entries").select(SELECT).ilike("body", like).neq("source", "weather").order("ts", { ascending: false }).limit(200);
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
function dayHeading(key, w) {
  const h2 = h("h2", { text: dayLabel(key) });
  if (w && w.temp_max_f != null && w.temp_min_f != null) {
    h2.append(h("span", { class: "wx", title: "High / low that day", text: `${Math.round(w.temp_max_f)}° / ${Math.round(w.temp_min_f)}°` }));
  }
  return h2;
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
  box.append(...hrBits(d.hr));
  return box;
}
// Fitbit heart rate during the workout: average, max and a small line graph.
function hrBits(hr) {
  if (!hr) return [];
  if (hr.status === "pending") return [h("p", { class: "hr-note", text: "Heart rate syncing…" })];
  if (hr.status !== "ok") return [h("p", { class: "hr-note", text: "No heart rate recorded" })];
  const row = h("div", { class: "vitals hr-row" },
    stat(String(hr.avg_bpm), "avg HR"), stat(String(hr.max_bpm), "max HR"));
  const g = Array.isArray(hr.graph) ? hr.graph : [];
  const vals = g.filter((v) => v != null);
  if (vals.length < 2) return [row];
  const lo = Math.min(...vals) - 4, hi = Math.max(...vals) + 4, W = 300, H = 44;
  const x = (i) => (i / (g.length - 1)) * W, y = (v) => H - ((v - lo) / (hi - lo)) * H;
  let d = "", pen = false;
  g.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
  });
  const avgY = y(hr.avg_bpm).toFixed(1);
  const graph = h("div", { class: "hr-graph", role: "img", "aria-label": `Heart rate during the workout, ${hr.min_bpm} to ${hr.max_bpm} beats per minute` });
  graph.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="0" x2="${W}" y1="${avgY}" y2="${avgY}" class="hr-avg"/><path d="${d}" class="hr-line"/></svg>`;
  return [row, graph];
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

  if (e.details?.kind === "checkin") return checkinEntry(e, li);

  // your own entry: time · text · small photos on the right
  // tap = log again, press and hold = edit / delete
  const photos = e.entry_photos || [];
  const row = h("div", { class: "note" + (S.openId === e.id ? " open" : "") + (S.editing === e.id ? " editing" : "") + (e.pending ? " pending" : "") });
  const body = h("span", { class: "body" }); body.append(bodyWithTags(e.body || ""));
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
/* ---------- check-in: mood, skin, soreness (each optional, 1–10, higher is better) ---------- */
const CHECKIN = [
  { key: "mood", label: "Mood", scale: "1 awful · 3 rough · 5 okay · 7 good · 10 great" },
  { key: "skin", label: "Skin", scale: "1 bad breakout · 3 several active spots · 5 a few spots · 7 one or two small spots · 10 completely clear" },
  { key: "soreness", label: "Soreness", scale: "1 very sore · 3 clearly sore · 5 a bit sore · 7 barely noticeable · 10 not sore at all" },
  { key: "eye", label: "Eye", scale: "Right eye: 1 completely bloodshot · 3 very red · 5 noticeably red · 7 slightly red or dry · 10 completely normal" },
];
function checkinBody(d) {
  const top = "Check-in · " + CHECKIN.map(c => `${c.key} ${d[c.key]?.rating ?? "–"}`).join(" · ");
  const lines = CHECKIN.filter(c => d[c.key]?.note).map(c => `${c.label}: ${d[c.key].note}`);
  if (d.note) lines.push(`Notes: ${d.note}`);
  return [top, ...lines].join("\n");
}
function checkinEntry(e, li) {
  const d = e.details;
  const rows = h("div", { class: "ci-rows" }, CHECKIN.filter(c => d[c.key]?.rating != null || d[c.key]?.note).map(c =>
    h("div", { class: "ci-row" },
      h("span", { class: "ci-k", text: c.label }),
      h("span", { class: "ci-v" + (d[c.key]?.rating == null ? " blank" : ""), text: d[c.key]?.rating == null ? "–" : `${d[c.key].rating}/10` }),
      h("span", { class: "ci-n", text: d[c.key]?.note || "" }))));
  const box = h("div", { class: "box checkin" + (e.pending ? " pending" : "") }, boxHead("CHECK-IN", "", fmtTime(e.ts)), rows);
  if (d.note) box.append(h("p", { class: "ci-extra", text: d.note }));
  if (!e.pending) pressable(box, () => {}, () => { S.openId = e.id; S.confirmId = null; renderFeed(); });
  li.append(box);
  if (e.pending) li.append(h("div", { class: "pending-note", text: S.flushing ? "Sending…" : "Saved on your phone · waiting to send" }));
  if (S.openId === e.id && !e.pending) {
    li.append(S.confirmId === e.id
      ? h("div", { class: "entry-tools" },
          h("span", { text: "Delete this check-in?" }),
          h("button", { type: "button", class: "yes", onclick: () => del(e) }, "Delete"),
          h("button", { type: "button", onclick: () => { S.confirmId = null; renderFeed(); } }, "Keep"))
      : h("div", { class: "entry-tools" },
          h("button", { type: "button", onclick: () => { S.openId = null; openCheckin(e); } }, "Edit"),
          h("button", { type: "button", class: "danger", onclick: () => { S.confirmId = e.id; renderFeed(); } }, "Delete"),
          h("button", { type: "button", onclick: () => { S.openId = null; renderFeed(); } }, "Done")));
  }
  return li;
}
const localInput = (t) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function openCheckin(entry) {
  closeSheet();
  S.ci = { editId: entry?.id || null, ratings: {} };
  const d = entry?.details || {};
  const wrap = $("ciSections"); wrap.replaceChildren();
  for (const c of CHECKIN) {
    S.ci.ratings[c.key] = d[c.key]?.rating ?? null;
    const picks = h("div", { class: "ci-picks", role: "group", "aria-label": `${c.label} rating, 1 to 10` });
    for (let n = 1; n <= 10; n++) {
      picks.append(h("button", { type: "button", "aria-pressed": String(S.ci.ratings[c.key] === n), onclick: () => {
        S.ci.ratings[c.key] = S.ci.ratings[c.key] === n ? null : n; // tap the same number again to clear it
        picks.querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(S.ci.ratings[c.key] === i + 1)));
      } }, String(n)));
    }
    const note = h("textarea", { id: `ci_${c.key}`, rows: "2", placeholder: "Notes (optional)" });
    note.value = d[c.key]?.note || "";
    wrap.append(h("div", { class: "ci-sec" },
      h("span", { class: "ci-name", text: c.label }), h("p", { class: "ci-scale", text: c.scale }), picks, note));
  }
  $("ciNote").value = d.note || "";
  $("ciWhen").value = localInput(entry ? entry.ts : Date.now());
  $("checkinTitle").textContent = entry ? "Edit check-in" : "Check-in";
  $("ciSave").textContent = entry ? "Save changes" : "Save check-in";
  $("checkinView").hidden = false;
  $("checkinView").querySelector(".refs-scroll").scrollTop = 0;
}
function closeCheckin() { $("checkinView").hidden = true; S.ci = null; }
$("checkinBtn").onclick = () => openCheckin();
$("checkinCancel").onclick = closeCheckin;
$("checkinForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const details = { kind: "checkin", version: 1 };
  let any = false;
  for (const c of CHECKIN) {
    const rating = S.ci.ratings[c.key], note = $(`ci_${c.key}`).value.trim() || null;
    details[c.key] = { rating, note };
    if (rating != null || note) any = true;
  }
  details.note = $("ciNote").value.trim() || null;
  if (details.note) any = true;
  if (!any) { toast("Pick a number or write a note first."); return; }
  const when = $("ciWhen").value ? new Date($("ciWhen").value) : new Date();
  const row = { ts: (isNaN(when) ? new Date() : when).toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, body: checkinBody(details), details };
  if (S.ci.editId) {
    const btn = $("ciSave"); btn.disabled = true;
    try {
      const { error } = await sb.from("entries").update(row).eq("id", S.ci.editId);
      if (error) throw error;
      await reloadOne(S.ci.editId);
      closeCheckin(); renderFeed(); toast("Saved");
    } catch { toast(navigator.onLine === false ? "You're offline. Edits need a connection." : "Couldn't save. Try again."); }
    finally { btn.disabled = false; }
    return;
  }
  const id = uuid();
  closeCheckin();
  await queueItem({ id, userId: S.user.id, createdAt: Date.now(), row: { id, ...row }, photos: [] });
});

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
/* ---------- coming up (Exercise calendar, read live, never saved) ---------- */
async function loadUpcoming() {
  let r;
  try {
    const { data, error } = await sb.functions.invoke("calendar-upcoming", { body: {} });
    if (error) return;
    r = data;
  } catch { return; }
  S.upcomingStatus = r?.status || "error";
  const stick = nearBottom();
  const top = scroller.scrollTop;
  renderUpcoming(r?.status === "ok" ? r.days : []);
  scroller.scrollTop = stick ? nowTarget() : top;
}
function calendarItem(ev) {
  return h("div", { class: "item" }, h("div", { class: "box calendar" }, boxHead("CALENDAR", ev.title, "")));
}
// Today's plan sits inside today's section, right after the night's sleep card (or at the top).
function placeTodayPlans() {
  document.querySelectorAll(".today-plan").forEach((el) => el.remove());
  const plans = S.todayPlans || [];
  if (!plans.length || S.searching) return;
  const sec = document.querySelector(`#feed section.day[data-day="${dayKey(Date.now())}"]`);
  if (!sec) return;
  const items = sec.querySelector(".items");
  const sleeps = items.querySelectorAll("[data-sleep]");
  let after = sleeps.length ? sleeps[sleeps.length - 1] : null;
  for (const ev of plans) {
    const el = calendarItem(ev);
    el.classList.add("today-plan");
    if (after) after.after(el); else items.prepend(el);
    after = el;
  }
}
function renderUpcoming(days) {
  const up = $("upcoming");
  const today = dayKey(Date.now());
  days = (days || []).filter((d) => d.date >= today && d.events?.length);
  // Today's plans go in today's section above the Now line, unless today has no section yet.
  const todayDay = days.find((d) => d.date === today);
  const hasTodaySection = !!document.querySelector(`#feed section.day[data-day="${today}"]`);
  S.todayPlans = todayDay && hasTodaySection ? todayDay.events : [];
  if (S.todayPlans.length) days = days.filter((d) => d.date !== today);
  placeTodayPlans();
  up.replaceChildren();
  up.hidden = !days.length;
  if (!days.length) return;
  up.append(h("div", { class: "now-line", role: "separator" }, "Now"));
  for (const d of days) {
    const items = h("div", { class: "items" });
    for (const ev of d.events) items.append(calendarItem(ev));
    up.append(h("section", { class: "day" }, h("h2", { text: upcomingLabel(d.date) }), items));
  }
}
function upcomingLabel(key) {
  const tomorrow = dayKey(Date.now() + 864e5);
  const [y, m, d] = key.split("-").map(Number);
  const short = new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  if (key === dayKey(Date.now())) return "Today · " + short;
  if (key === tomorrow) return "Tomorrow · " + short;
  return short;
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
    // Weather isn't a card: it shows as a small high/low tag next to its day's date.
    const weather = new Map();
    for (const e of list) if (e.source === "weather" && e.details?.date) weather.set(e.details.date, e.details);
    let curDay = null, box;
    for (const e of list) {
      const k = e.source === "weather" && e.details?.date ? e.details.date : dayKey(e.ts);
      if (k !== curDay) {
        curDay = k;
        const sec = h("section", { class: "day" }, dayHeading(k, weather.get(k)));
        sec.dataset.day = k;
        box = h("div", { class: "items" }); sec.append(box); feed.append(sec);
      }
      if (e.source !== "weather") {
        const el = renderEntry(e);
        if (e.details?.kind === "sleep") el.dataset.sleep = "1";
        box.append(el);
      }
    }
  }
  placeTodayPlans();
  $("moreBtn").hidden = S.searching || !S.hasMore || S.loading;
  S.lastAdded = null;
}
function openPhoto(url) { $("lightImg").src = url; $("lightbox").hidden = false; }
$("lightbox").onclick = () => { $("lightbox").hidden = true; $("lightImg").removeAttribute("src"); };
document.addEventListener("keydown", e => { if (e.key === "Escape") $("lightbox").hidden = true; });

/* refresh when the app comes back to the foreground */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.user && !S.loading && !S.editing && !S.searching) { flushOutbox(); loadEntries(true); syncAll(); loadUpcoming(); }
});

/* ---------- references ---------- */
// An entry links a reference by writing [[Name]]. Each change to a reference is a new dated version.
S.refs = [];          // [{id, archived_at, versions:[...newest first], cur}]
S.refEdit = null;     // {ref|null, photo:{blob,w,h,preview}|null, removePhoto:bool}

async function loadRefs() {
  const [{ data: refs }, { data: vers }] = await Promise.all([
    sb.from("refs").select("id, archived_at, created_at"),
    sb.from("ref_versions").select("id, ref_id, valid_from, name, description, photo_path, photo_w, photo_h, created_at").order("valid_from", { ascending: false }),
  ]);
  const by = new Map((refs || []).map(r => [r.id, { ...r, versions: [] }]));
  for (const v of vers || []) by.get(v.ref_id)?.versions.push(v);
  S.refs = [...by.values()].filter(r => r.versions.length).map(r => ({ ...r, cur: r.versions[0] }))
    .sort((a, b) => a.cur.name.localeCompare(b.cur.name));
  const paths = S.refs.map(r => r.cur.photo_path).filter(Boolean).filter(p => !S.urls.get(p));
  if (paths.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    for (const r of data || []) if (r.signedUrl) S.urls.set(r.path, { url: r.signedUrl, exp: Date.now() + 3600e3 });
  }
  if (!$("refsView").hidden && $("refForm").hidden) renderRefs();
}

/* tags in entries */
function bodyWithTags(text) {
  const frag = document.createDocumentFragment();
  const re = /\[\[([^\]\n]{1,80})\]\]/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    frag.append(highlighted(text.slice(i, m.index)));
    frag.append(h("span", { class: "ref-tag", text: m[1] }));
    i = m.index + m[0].length;
  }
  frag.append(highlighted(text.slice(i)));
  return frag;
}

/* suggestion chips while typing */
function updateRefChips() {
  const box = $("refChips");
  const active = S.refs.filter(r => !r.archived_at);
  const caret = textEl.selectionStart ?? textEl.value.length;
  const before = textEl.value.slice(0, caret);
  // nothing to match: no references, empty, just typed a space, or inside an existing [[link]]
  if (!active.length || !before || /\s$/.test(before) || /\[\[[^\]]*$/.test(before)) { box.hidden = true; return; }
  const hits = new Map();
  // the last 1, 2 or 3 words typed, matched against the start of each name
  for (let n = 1; n <= 3; n++) {
    const m = before.match(new RegExp(`(?:^|\\s)(\\S+(?:\\s+\\S+){${n - 1}})$`));
    if (!m) break;
    const frag = m[1], q = frag.toLowerCase();
    if (q.length < 2 || q.includes("]]")) continue;
    for (const r of active) if (r.cur.name.toLowerCase().startsWith(q) && !hits.has(r.id)) hits.set(r.id, { r, fragLen: frag.length });
  }
  box.replaceChildren(...[...hits.values()].slice(0, 3).map(({ r, fragLen }) =>
    h("button", { type: "button", class: "ref-chip", onmousedown: ev => ev.preventDefault(), onclick: () => insertRef(r.cur.name, fragLen) },
      h("span", { class: "ref-chip-mark", "aria-hidden": "true", text: "↳" }), r.cur.name)));
  box.hidden = !hits.size;
}
function insertRef(name, fragLen) {
  const caret = textEl.selectionStart ?? textEl.value.length;
  const v = textEl.value;
  const start = caret - fragLen;
  const lead = start > 0 && !/\s/.test(v[start - 1]) ? " " : "";
  const ins = `${lead}[[${name}]] `;
  textEl.value = v.slice(0, start) + ins + v.slice(caret).replace(/^\s+/, "");
  const pos = start + ins.length;
  textEl.focus(); textEl.setSelectionRange(pos, pos);
  autoGrow(); updateTyping(); updateRefChips();
}
textEl.addEventListener("click", updateRefChips);
textEl.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== textEl) $("refChips").hidden = true; }, 150));

/* references screen */
const fmtDate = t => new Date(t).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
function openRefs() { closeSheet(); $("refsView").hidden = false; showRefList(); loadRefs(); }
function closeRefs() { $("refsView").hidden = true; S.refEdit = null; }
$("refsBtn").onclick = openRefs;
$("refsDone").onclick = closeRefs;
function showRefList() {
  $("refForm").hidden = true; $("refsList").hidden = false; $("refsFoot").hidden = false;
  document.querySelector(".refs-intro").hidden = false;
  renderRefs();
}
let showArchived = false;
function refRow(r) {
  const u = r.cur.photo_path ? S.urls.get(r.cur.photo_path)?.url : null;
  const since = r.versions.length > 1 ? "changed " + fmtDate(r.cur.valid_from) : "since " + fmtDate(r.cur.valid_from);
  return h("button", { type: "button", class: "ref-row" + (r.archived_at ? " archived" : ""), onclick: () => editRef(r) },
    h("span", { class: "ref-text" },
      h("span", { class: "ref-name", text: r.cur.name }),
      r.cur.description ? h("span", { class: "ref-desc", text: r.cur.description }) : null,
      h("span", { class: "ref-since", text: r.archived_at ? "archived " + fmtDate(r.archived_at) : since })),
    u ? h("span", { class: "thumb-r" }, h("img", { src: u, alt: "" })) : null);
}
function renderRefs() {
  const list = $("refsList"); list.replaceChildren();
  const active = S.refs.filter(r => !r.archived_at), archived = S.refs.filter(r => r.archived_at);
  if (!active.length) list.append(h("div", { class: "empty" }, h("strong", { text: "No references yet" }),
    "Add the things you mention often, like your usual milk or a supplement, so the AI knows exactly what you mean."));
  for (const r of active) list.append(refRow(r));
  if (archived.length) {
    list.append(h("button", { type: "button", class: "link refs-archived-toggle", onclick: () => { showArchived = !showArchived; renderRefs(); } },
      (showArchived ? "Hide" : "Show") + ` archived (${archived.length})`));
    if (showArchived) for (const r of archived) list.append(refRow(r));
  }
}
function setRefPhoto(url) {
  const t = $("refPhotoThumb"); t.replaceChildren();
  if (url) {
    t.append(h("img", { src: url, alt: "Reference photo" }),
      h("button", { type: "button", "aria-label": "Remove photo", onclick: () => { S.refEdit.photo = null; S.refEdit.removePhoto = true; setRefPhoto(null); } }, "×"));
  }
  t.hidden = !url; $("refPhotoLabel").textContent = url ? "Change photo" : "Add photo";
}
function editRef(r) {
  S.refEdit = { ref: r || null, photo: null, removePhoto: false };
  $("refsList").hidden = true; $("refsFoot").hidden = true; document.querySelector(".refs-intro").hidden = true;
  $("refForm").hidden = false;
  $("refName").value = r ? r.cur.name : "";
  $("refDesc").value = r ? (r.cur.description || "") : "";
  setRefPhoto(r && r.cur.photo_path ? S.urls.get(r.cur.photo_path)?.url : null);
  $("refChangeBox").hidden = !r;
  $("refWhen").value = toLocalInput(Date.now()); $("refTypo").checked = false;
  $("refArchive").hidden = !r; $("refArchive").textContent = r?.archived_at ? "Unarchive" : "Archive";
  const hist = $("refHistory");
  if (r && r.versions.length > 1) {
    hist.hidden = false;
    hist.textContent = "Earlier versions: " + r.versions.slice(1).map(v => `${v.name} (from ${fmtDate(v.valid_from)}): ${v.description || "no description"}`).join(" · ");
  } else hist.hidden = true;
  $("refName").focus();
}
$("refAdd").onclick = () => editRef(null);
$("refCancel").onclick = showRefList;
$("refPhotoInput").addEventListener("change", async ev => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  try { const r = await shrink(f); S.refEdit.photo = { ...r, preview: URL.createObjectURL(r.blob) }; S.refEdit.removePhoto = false; setRefPhoto(S.refEdit.photo.preview); }
  catch { toast("That photo couldn't be read. Try a different one."); }
});
$("refArchive").onclick = async () => {
  const r = S.refEdit?.ref; if (!r) return;
  const { error } = await sb.from("refs").update({ archived_at: r.archived_at ? null : new Date().toISOString() }).eq("id", r.id);
  if (error) { toast("Couldn't update. Check your connection."); return; }
  toast(r.archived_at ? "Unarchived" : "Archived. Old entries still point to it.");
  await loadRefs(); showRefList();
};
$("refForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const name = $("refName").value.trim().replace(/[\[\]]/g, "");
  const description = $("refDesc").value.trim() || null;
  if (!name) { toast("Give it a name first."); return; }
  const clash = S.refs.find(r => !r.archived_at && r.cur.name.toLowerCase() === name.toLowerCase() && r.id !== S.refEdit?.ref?.id);
  if (clash) { toast(`You already have “${clash.cur.name}”. Pick a different name.`); return; }
  const btn = $("refSave"); btn.disabled = true;
  try {
    const r = S.refEdit.ref;
    let refId = r?.id;
    if (!refId) {
      const { data, error } = await sb.from("refs").insert({}).select("id").single();
      if (error) throw error;
      refId = data.id;
    }
    const versionId = uuid();
    let photo_path = r?.cur.photo_path || null, photo_w = r?.cur.photo_w || null, photo_h = r?.cur.photo_h || null;
    if (S.refEdit.removePhoto) photo_path = photo_w = photo_h = null;
    if (S.refEdit.photo) {
      photo_path = `${S.user.id}/refs/${versionId}.jpg`;
      const up = await sb.storage.from(BUCKET).upload(photo_path, S.refEdit.photo.blob, { contentType: "image/jpeg", upsert: false });
      if (up.error) throw up.error;
      photo_w = S.refEdit.photo.w; photo_h = S.refEdit.photo.h;
    }
    const unchanged = r && r.cur.name === name && (r.cur.description || null) === description && photo_path === r.cur.photo_path;
    if (unchanged) { showRefList(); return; }
    if (r && $("refTypo").checked) {
      const { error } = await sb.from("ref_versions").update({ name, description, photo_path, photo_w, photo_h }).eq("id", r.cur.id);
      if (error) throw error;
    } else {
      const when = r ? new Date($("refWhen").value || Date.now()).toISOString() : new Date().toISOString();
      const { error } = await sb.from("ref_versions").insert({ id: versionId, ref_id: refId, valid_from: when, name, description, photo_path, photo_w, photo_h });
      if (error) throw error;
    }
    toast(r ? "Saved. The earlier version is kept with its dates." : "Added");
    await loadRefs(); showRefList();
  } catch (e) {
    console.error(e); toast("Couldn't save. Check your connection and try again.");
  } finally { btn.disabled = false; }
});

/* ---------- boot ---------- */
renderThumbs(); renderWhen(); renderFeed();

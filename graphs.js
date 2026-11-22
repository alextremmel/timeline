/* ---------- Graphs: look-only charts, opened from the ⋯ menu ----------
   Trends: resting HR, HRV and each check-in score, stacked so they share one time axis.
           Touch and drag across any chart to read every chart on that day.
   Workouts: runs and rides as dots, average heart rate (across) against pace (up = faster).
           The faint bar through each dot spans the middle 80% of that workout's heart rate.
   Uses globals from app.js: sb, h, $, closeSheet. Reads data only, never writes. */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const DAY = 86400_000;
  const RANGES = [["1M", 30], ["3M", 91], ["6M", 182], ["1Y", 365]];
  const G = { data: null, range: 91, end: null, cursor: null, tab: "trends", sport: "Run", spread: true, pick: null };

  const svg = (tag, attrs = {}, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k) el.append(k);
    return el;
  };
  const noon = ymd => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d, 12).getTime(); };
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const ymdOf = t => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const fmtDay = (t, long) => new Date(t).toLocaleDateString([], long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
  const mmss = s => { s = Math.round(s); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ---------- data ---------- */
  async function load() {
    const [daily, checks, works] = await Promise.all([
      sb.from("ai_daily").select("local_date, resting_hr_bpm, hrv_ms").order("local_date"),
      sb.from("entries").select("ts, details").eq("source", "me").eq("details->>kind", "checkin").order("ts"),
      sb.from("entries").select("id, ts, details").eq("source", "strava").order("ts"),
    ]);
    const err = daily.error || checks.error || works.error;
    if (err) throw err;
    const series = { rhr: [], hrv: [], mood: [], skin: [], upper: [], lower: [], eye: [] };
    for (const r of daily.data || []) {
      const t = noon(r.local_date);
      if (r.resting_hr_bpm != null) series.rhr.push({ t, v: Number(r.resting_hr_bpm) });
      if (r.hrv_ms != null) series.hrv.push({ t, v: Number(r.hrv_ms) });
    }
    for (const e of checks.data || []) {
      const d = e.details || {}, t = new Date(e.ts).getTime();
      const add = (key, v) => { if (v != null && v !== "") series[key].push({ t, v: Number(v) }); };
      add("mood", d.mood?.rating); add("skin", d.skin?.rating); add("eye", d.eye?.rating);
      add("upper", d.soreness?.upper); add("lower", d.soreness?.lower ?? d.soreness?.rating);
    }
    const workouts = (works.data || []).map(e => {
      const d = e.details || {}, hr = d.hr || {};
      const mi = Number(d.distance_mi) || 0, sec = Number(d.duration_s) || 0;
      const mins = (hr.by_minute || []).filter(v => v != null).sort((a, b) => a - b);
      const q = p => mins.length ? mins[Math.min(mins.length - 1, Math.floor(p * (mins.length - 1) + 0.5))] : null;
      return {
        id: e.id, t: new Date(e.ts).getTime(), kind: d.kind, mi, sec,
        avg: hr.status === "ok" ? hr.avg_bpm : null, max: hr.max_bpm ?? null, lo: q(0.1), hi: q(0.9),
        graph: hr.graph || null,
      };
    }).filter(w => w.mi > 0.05 && w.sec > 0);
    return { series, workouts };
  }

  /* ---------- open / close ---------- */
  async function open() {
    closeSheet();
    $("graphsView").hidden = false;
    G.cursor = null; G.pick = null;
    G.end = dayStart(Date.now()) + DAY;
    render();
    try {
      G.data = await load();
      render();
    } catch (e) {
      $("graphsBody").replaceChildren(h("div", { class: "notice", text: "Couldn't load your data. Check your connection and try again." }));
    }
  }
  const close = () => { $("graphsView").hidden = true; };
  $("graphsBtn").onclick = open;
  $("graphsDone").onclick = close;
  addEventListener("pointerup", () => { G.dragging = false; });
  addEventListener("pointercancel", () => { G.dragging = false; });
  let rw = 0;
  addEventListener("resize", () => { if ($("graphsView").hidden) return; clearTimeout(rw); rw = setTimeout(render, 150); });

  function render() {
    for (const b of $("graphsTabs").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.tab === G.tab));
    const body = $("graphsBody");
    if (!G.data) { body.replaceChildren(h("p", { class: "muted", text: "Loading…" })); return; }
    body.replaceChildren(G.tab === "trends" ? trends() : workouts());
  }
  $("graphsTabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; G.tab = b.dataset.tab; render(); };

  /* ---------- Trends ---------- */
  const PANELS = [
    { title: "Resting HR", unit: "bpm", lines: [{ key: "rhr", color: "--g-rhr" }], daily: true },
    { title: "HRV", unit: "ms", lines: [{ key: "hrv", color: "--g-hrv" }], daily: true },
    { title: "Mood", lines: [{ key: "mood", color: "--checkin" }], fixed: true },
    { title: "Skin", lines: [{ key: "skin", color: "--checkin" }], fixed: true },
    { title: "Soreness", lines: [{ key: "upper", color: "--checkin", label: "upper" }, { key: "lower", color: "--g-lower", label: "lower" }], fixed: true },
    { title: "Eye", lines: [{ key: "eye", color: "--checkin" }], fixed: true },
  ];
  // Average the points that fall on each calendar day (check-ins can happen several times a day).
  function byDay(pts) {
    const m = new Map();
    for (const p of pts) { const k = ymdOf(p.t); const a = m.get(k) || []; a.push(p.v); m.set(k, a); }
    return [...m].map(([k, a]) => ({ t: noon(k), k, v: a.reduce((s, x) => s + x, 0) / a.length, n: a.length }));
  }

  function trends() {
    const wrap = h("div", { class: "g-trends" });
    const start = G.end - G.range * DAY;
    // range chips + paging
    const nav = h("div", { class: "g-nav" },
      h("div", { class: "g-chips" }, RANGES.map(([label, days]) =>
        h("button", { type: "button", "aria-pressed": String(G.range === days), onclick: () => { G.range = days; G.cursor = null; render(); } }, label))),
      h("div", { class: "g-page" },
        h("button", { type: "button", "aria-label": "Earlier", onclick: () => { G.end -= Math.round(G.range / 2) * DAY; G.cursor = null; render(); } }, "‹"),
        h("span", { text: `${fmtDay(start)} – ${fmtDay(G.end - DAY)}` }),
        h("button", { type: "button", "aria-label": "Later", disabled: G.end >= dayStart(Date.now()) + DAY,
          onclick: () => { G.end = Math.min(dayStart(Date.now()) + DAY, G.end + Math.round(G.range / 2) * DAY); G.cursor = null; render(); } }, "›")));
    const readout = h("div", { class: "g-readout", text: "Touch a chart to compare one day across all of them" });
    wrap.append(nav, readout);

    const W = Math.max(280, $("graphsBody").clientWidth || 340);
    const L = 34, R = 10, H = 74, T = 6, B = 6;
    const x = t => L + (t - start) / (G.end - start) * (W - L - R);
    const ticks = timeTicks(start, G.end);
    const panels = [];

    for (const p of PANELS) {
      const lines = p.lines.map(l => {
        const raw = G.data.series[l.key].filter(d => d.t >= start - DAY && d.t <= G.end + DAY);
        return { ...l, raw, days: byDay(raw), col: css(l.color) || "#888" };
      });
      const all = lines.flatMap(l => l.days.map(d => d.v).concat(l.raw.map(d => d.v)));
      let lo, hi;
      if (p.fixed) { lo = 1; hi = 10; }
      else if (all.length) { lo = Math.min(...all); hi = Math.max(...all); const pad = Math.max(2, (hi - lo) * 0.15); lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad); }
      else { lo = 0; hi = 1; }
      const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

      const val = h("span", { class: "g-val" });
      const legend = lines.length > 1 ? h("span", { class: "g-legend" }, lines.map(l =>
        h("span", {}, h("i", { style: `background:${l.col}` }), l.label))) : null;
      const head = h("div", { class: "g-phead" }, h("span", { class: "g-ptitle", text: p.title }), legend, val);
      const s = svg("svg", { class: "g-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      // grid: time ticks and two value lines
      for (const tk of ticks) s.append(svg("line", { x1: x(tk.t), x2: x(tk.t), y1: T, y2: H - B, class: "g-grid" }));
      const yt = p.fixed ? [1, 5, 10] : [lo, Math.round((lo + hi) / 2), hi];
      for (const v of yt) {
        s.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "g-grid" }));
        const lab = svg("text", { x: L - 6, y: y(v) + 3.5, class: "g-ytick", "text-anchor": "end" }); lab.textContent = Math.round(v); s.append(lab);
      }
      if (!all.length) {
        const t = svg("text", { x: (L + W - R) / 2, y: H / 2 + 4, class: "g-none", "text-anchor": "middle" }); t.textContent = "No data in this range"; s.append(t);
      }
      for (const l of lines) {
        const pts = l.days.filter(d => d.t >= start && d.t <= G.end);
        // break the line where more than 4 days are missing
        let dpath = "", prev = null;
        for (const d of pts) { dpath += (prev && d.t - prev.t <= 4.5 * DAY ? "L" : "M") + x(d.t).toFixed(1) + " " + y(d.v).toFixed(1); prev = d; }
        if (dpath) s.append(svg("path", { d: dpath, fill: "none", stroke: l.col, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
        if (p.daily) {
          if (G.range <= 91) for (const d of pts) s.append(svg("circle", { cx: x(d.t), cy: y(d.v), r: 2.2, fill: l.col }));
        } else {
          // every single check-in as a small dot at the time it was made
          for (const d of l.raw) if (d.t >= start && d.t < G.end) s.append(svg("circle", { cx: x(d.t), cy: y(d.v), r: 3, fill: css("--surface"), stroke: l.col, "stroke-width": 1.6 }));
        }
      }
      const cur = svg("line", { y1: 0, y2: H, class: "g-cursor", visibility: "hidden" });
      s.append(cur);
      const box = h("div", { class: "g-panel" }, head, s);
      wrap.append(box);
      panels.push({ p, lines, val, cur, y });
      // latest value as the default readout
      const last = lines.map(l => { const d = l.days.filter(d => d.t < G.end).pop(); return d ? (lines.length > 1 ? `${l.label} ` : "") + fmtVal(d.v, p) : null; }).filter(Boolean);
      val.textContent = last.length ? last.join(" · ") : "";
      val.dataset.latest = val.textContent;
    }

    // shared time axis under the last chart
    const ax = svg("svg", { class: "g-svg", width: W, height: 18, viewBox: `0 0 ${W} 18` });
    for (const tk of ticks) { const t = svg("text", { x: x(tk.t), y: 13, class: "g-xtick", "text-anchor": "middle" }); t.textContent = tk.label; ax.append(t); }
    wrap.append(ax);

    // touch / drag anywhere on the charts to line up one day
    const setCursor = clientX => {
      const r = wrap.querySelector(".g-svg").getBoundingClientRect();
      const px = Math.max(L, Math.min(W - R, clientX - r.left));
      const t = start + (px - L) / (W - L - R) * (G.end - start);
      const k = ymdOf(t), tc = noon(k);
      G.cursor = k;
      readout.textContent = fmtDay(tc, true);
      readout.classList.add("on");
      for (const pn of panels) {
        pn.cur.setAttribute("x1", x(tc)); pn.cur.setAttribute("x2", x(tc)); pn.cur.setAttribute("visibility", "visible");
        const bits = pn.lines.map(l => { const d = l.days.find(d => d.k === k); return d ? (pn.lines.length > 1 ? `${l.label} ` : "") + fmtVal(d.v, pn.p) + (d.n > 1 ? ` (avg of ${d.n})` : "") : null; }).filter(Boolean);
        pn.val.textContent = bits.length ? bits.join(" · ") : "–";
        pn.val.classList.add("on");
      }
    };
    wrap.addEventListener("pointerdown", e => { if (!e.target.closest(".g-panel")) return; G.dragging = true; setCursor(e.clientX); });
    wrap.addEventListener("pointermove", e => { if (G.dragging) setCursor(e.clientX); });
    // horizontal drags read values; vertical swipes still scroll the page
    for (const s of wrap.querySelectorAll(".g-panel")) s.style.touchAction = "pan-y";
    return wrap;
  }
  const fmtVal = (v, p) => p.fixed ? (Math.round(v * 10) / 10) + "/10" : Math.round(v) + (p.unit ? " " + p.unit : "");

  function timeTicks(start, end) {
    const days = (end - start) / DAY, out = [];
    if (days <= 35) {
      // weekly, on Mondays
      const d = new Date(start); d.setHours(12, 0, 0, 0); while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
      for (; d.getTime() < end; d.setDate(d.getDate() + 7)) out.push({ t: d.getTime(), label: fmtDay(d.getTime()) });
    } else {
      const step = days > 200 ? 2 : 1;
      const d = new Date(start); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
      for (; d.getTime() < end; d.setMonth(d.getMonth() + step))
        out.push({ t: d.getTime(), label: d.toLocaleDateString([], d.getMonth() === 0 ? { month: "short", year: "2-digit" } : { month: "short" }) });
    }
    return out;
  }

  /* ---------- Workouts ---------- */
  const SPORTS = { Run: { label: "Runs", pace: true }, Bike: { label: "Rides", pace: false } };

  function workouts() {
    const wrap = h("div", { class: "g-works" });
    const sp = SPORTS[G.sport];
    const all = G.data.workouts.filter(w => w.kind === G.sport);
    const pts = all.filter(w => w.avg != null);
    wrap.append(h("div", { class: "g-nav" },
      h("div", { class: "g-chips" }, Object.entries(SPORTS).map(([k, s]) =>
        h("button", { type: "button", "aria-pressed": String(G.sport === k), onclick: () => { G.sport = k; G.pick = null; render(); } }, s.label))),
      h("button", { type: "button", class: "g-toggle", "aria-pressed": String(G.spread), onclick: () => { G.spread = !G.spread; render(); } }, "HR spread")));
    wrap.append(h("p", { class: "g-help", text: sp.pace
      ? "Each dot is a run. Further right = higher average heart rate; higher up = faster pace. Bigger dots are longer runs, faded dots are older. Tap a dot for details."
      : "Each dot is a ride. Further right = higher average heart rate; higher up = faster. Bigger dots are longer rides, faded dots are older. Tap a dot for details." }));
    if (!pts.length) { wrap.append(h("div", { class: "notice", text: `No ${sp.label.toLowerCase()} with heart rate yet.` })); return wrap; }

    // pace in seconds per mile for runs (smaller = faster), speed in mph for rides
    const yv = w => sp.pace ? w.sec / w.mi : w.mi / (w.sec / 3600);
    const W = Math.max(280, $("graphsBody").clientWidth || 340), H = Math.round(Math.min(420, W * 0.95));
    const L = 54, R = 12, T = 10, B = 34;
    const xs = pts.flatMap(w => G.spread && w.lo != null ? [w.lo, w.hi, w.avg] : [w.avg]);
    let x0 = Math.floor((Math.min(...xs) - 4) / 5) * 5, x1 = Math.ceil((Math.max(...xs) + 4) / 5) * 5;
    const ys = pts.map(yv);
    let y0 = Math.min(...ys), y1 = Math.max(...ys); const yp = Math.max(sp.pace ? 20 : 0.8, (y1 - y0) * 0.12); y0 -= yp; y1 += yp;
    const x = v => L + (v - x0) / (x1 - x0) * (W - L - R);
    // faster at the top: for pace that means small numbers up top
    const y = v => sp.pace ? T + (v - y0) / (y1 - y0) * (H - T - B) : T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

    const s = svg("svg", { class: "g-svg g-scatter", width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    // grid + axis labels
    for (let v = x0; v <= x1; v += x1 - x0 > 50 ? 10 : 5) {
      s.append(svg("line", { x1: x(v), x2: x(v), y1: T, y2: H - B, class: "g-grid" }));
      const t = svg("text", { x: x(v), y: H - B + 14, class: "g-xtick", "text-anchor": "middle" }); t.textContent = v; s.append(t);
    }
    const yStep = sp.pace ? (y1 - y0 > 240 ? 60 : 30) : (y1 - y0 > 8 ? 2 : 1);
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) {
      s.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "g-grid" }));
      const t = svg("text", { x: L - 6, y: y(v) + 3.5, class: "g-ytick", "text-anchor": "end" }); t.textContent = sp.pace ? mmss(v) : v; s.append(t);
    }
    const xl = svg("text", { x: (L + W - R) / 2, y: H - 4, class: "g-axis", "text-anchor": "middle" }); xl.textContent = "Average heart rate (bpm)"; s.append(xl);
    const yl = svg("text", { x: 11, y: (T + H - B) / 2, class: "g-axis", "text-anchor": "middle", transform: `rotate(-90 11 ${(T + H - B) / 2})` });
    yl.textContent = sp.pace ? "Pace (min/mi) · faster ↑" : "Speed (mph) · faster ↑"; s.append(yl);

    const col = css(G.sport === "Run" ? "--strava" : "--g-hrv") || "#E8590C";
    const tMin = Math.min(...pts.map(w => w.t)), tMax = Math.max(...pts.map(w => w.t));
    const maxMi = Math.max(...pts.map(w => w.mi));
    const latest = pts.reduce((a, b) => (b.t > a.t ? b : a));
    for (const w of [...pts].sort((a, b) => a.t - b.t)) {
      const age = tMax > tMin ? (w.t - tMin) / (tMax - tMin) : 1; // 0 oldest … 1 newest
      const op = 0.3 + 0.7 * age;
      const cy = y(yv(w)), cx = x(w.avg);
      if (G.spread && w.lo != null) s.append(svg("line", { x1: x(w.lo), x2: x(w.hi), y1: cy, y2: cy, stroke: col, "stroke-width": 2.5, "stroke-linecap": "round", opacity: op * 0.45 }));
      const r = 4 + 6 * Math.sqrt(w.mi / maxMi);
      const dot = svg("circle", { cx, cy, r, fill: col, "fill-opacity": op, stroke: G.pick === w.id ? css("--ink") : (w === latest ? css("--ink") : "none"),
        "stroke-width": G.pick === w.id ? 2.5 : 1.2, class: "g-dot" });
      dot.addEventListener("click", () => { G.pick = G.pick === w.id ? null : w.id; render(); });
      s.append(dot);
    }
    wrap.append(s);

    const skipped = all.length - pts.length;
    wrap.append(h("p", { class: "g-foot", text: `${pts.length} ${sp.label.toLowerCase()}` + (skipped ? ` · ${skipped} without heart rate not shown` : "") + " · outlined dot = most recent" }));

    const w = pts.find(w => w.id === G.pick);
    if (w) wrap.append(detail(w, sp, col));
    return wrap;
  }

  function detail(w, sp, col) {
    const pace = sp.pace ? `${mmss(w.sec / w.mi)} /mi` : `${(w.mi / (w.sec / 3600)).toFixed(1)} mph`;
    const card = h("div", { class: "box g-detail" },
      h("div", { class: "g-dhead" }, h("strong", { text: fmtDay(w.t, true) }), h("button", { type: "button", class: "link", onclick: () => { G.pick = null; render(); } }, "Close")),
      h("div", { class: "g-dstats" },
        stat(w.mi.toFixed(2), "mi"), w.sec >= 3600 ? stat(mmss(w.sec / 60), "h:mm") : stat(Math.round(w.sec / 60), "min"), stat(pace.split(" ")[0], pace.split(" ")[1]),
        stat(w.avg, "avg bpm"), stat(w.max ?? "–", "max bpm"), w.lo != null ? stat(`${w.lo}–${w.hi}`, "middle 80%") : null));
    if (w.graph && w.graph.some(v => v != null)) {
      const W = Math.max(260, $("graphsBody").clientWidth - 30), H = 70;
      const vals = w.graph.filter(v => v != null), lo = Math.min(...vals) - 3, hi = Math.max(...vals) + 3;
      let d = "", pen = false;
      w.graph.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + (i / (w.graph.length - 1) * W).toFixed(1) + " " + (4 + (1 - (v - lo) / (hi - lo)) * (H - 8)).toFixed(1); pen = true; });
      card.append(svg("svg", { class: "g-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` },
        svg("path", { d, fill: "none", stroke: col, "stroke-width": 2, "stroke-linejoin": "round" })));
      card.append(h("span", { class: "g-foot", text: "Heart rate from start to finish" }));
    }
    return card;
  }
  const stat = (v, unit) => h("div", { class: "g-stat" }, h("b", { text: String(v) }), h("span", { text: unit }));
})();

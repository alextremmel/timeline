/* ---------- Graphs: look-only charts, opened from the ⋯ menu ----------
   Runs and rides as dots: average heart rate (across) against pace or speed (up = faster).
   - Colour shows when: pale = older, deep = newer (key under the chart, with months).
   - Size shows distance.
   - The faint bar through each dot spans the middle 80% of that workout's heart rate.
   - The monthly trail joins each month's average position, so progress reads at a glance.
   Uses globals from app.js: sb, h, $, closeSheet. Reads data only, never writes. */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const G = { data: null, sport: "Run", spread: true, trail: true, pick: null };

  const svg = (tag, attrs = {}, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k) el.append(k);
    return el;
  };
  const fmtDay = t => new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const mmss = s => { s = Math.round(s); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

  // Colour ramps, old → new. In dark mode newer dots are brighter; in light mode, deeper.
  const RAMPS = {
    Run: { light: ["#F9D3B8", "#F08A4B", "#B83E00"], dark: ["#7A4A30", "#D06A30", "#FFA266"] },
    Bike: { light: ["#C6DBF8", "#5B95E6", "#0B4FAE"], dark: ["#33507D", "#4C86D9", "#9CC8FF"] },
  };
  const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  function ramp(stops, f) {
    f = Math.max(0, Math.min(1, f));
    const seg = f < 0.5 ? 0 : 1, local = seg ? (f - 0.5) * 2 : f * 2;
    const a = hex(stops[seg]), b = hex(stops[seg + 1]);
    return "rgb(" + a.map((v, i) => Math.round(v + (b[i] - v) * local)).join(",") + ")";
  }

  /* ---------- data ---------- */
  async function load() {
    const { data, error } = await sb.from("entries").select("id, ts, details").eq("source", "strava").order("ts");
    if (error) throw error;
    return (data || []).map(e => {
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
  }

  /* ---------- open / close ---------- */
  async function open() {
    closeSheet();
    $("graphsView").hidden = false;
    G.pick = null;
    render();
    try {
      G.data = await load();
      render();
    } catch (e) {
      $("graphsBody").replaceChildren(h("div", { class: "notice", text: "Couldn't load your workouts. Check your connection and try again." }));
    }
  }
  $("graphsBtn").onclick = open;
  $("graphsDone").onclick = () => { $("graphsView").hidden = true; };
  let rw = 0;
  addEventListener("resize", () => { if ($("graphsView").hidden) return; clearTimeout(rw); rw = setTimeout(render, 150); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (!$("graphsView").hidden) render(); });

  function render() {
    for (const b of $("graphsTabs").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.sport === G.sport));
    const body = $("graphsBody");
    if (!G.data) { body.replaceChildren(h("p", { class: "muted", text: "Loading…" })); return; }
    body.replaceChildren(chart());
  }
  $("graphsTabs").onclick = e => { const b = e.target.closest("button"); if (!b) return; G.sport = b.dataset.sport; G.pick = null; render(); };

  /* ---------- the scatter ---------- */
  const SPORTS = { Run: { label: "runs", one: "run", pace: true }, Bike: { label: "rides", one: "ride", pace: false } };

  function chart() {
    const wrap = h("div", { class: "g-works" });
    const sp = SPORTS[G.sport];
    const stops = RAMPS[G.sport][dark() ? "dark" : "light"];
    const all = G.data.filter(w => w.kind === G.sport);
    const pts = all.filter(w => w.avg != null);
    wrap.append(h("div", { class: "g-nav" },
      h("button", { type: "button", class: "g-toggle", "aria-pressed": String(G.trail), onclick: () => { G.trail = !G.trail; render(); } }, "Monthly trail"),
      h("button", { type: "button", class: "g-toggle", "aria-pressed": String(G.spread), onclick: () => { G.spread = !G.spread; render(); } }, "HR spread")));
    if (!pts.length) { wrap.append(h("div", { class: "notice", text: `No ${sp.label} with heart rate yet.` })); return wrap; }

    // pace in seconds per mile for runs (smaller = faster), speed in mph for rides
    const yv = w => sp.pace ? w.sec / w.mi : w.mi / (w.sec / 3600);
    const W = Math.max(280, $("graphsBody").clientWidth || 340), H = Math.round(Math.min(440, W * 1.0));
    const L = 54, R = 12, T = 10, B = 34;
    const xs = pts.flatMap(w => G.spread && w.lo != null ? [w.lo, w.hi, w.avg] : [w.avg]);
    const x0 = Math.floor((Math.min(...xs) - 4) / 5) * 5, x1 = Math.ceil((Math.max(...xs) + 4) / 5) * 5;
    const ys = pts.map(yv);
    let y0 = Math.min(...ys), y1 = Math.max(...ys); const yp = Math.max(sp.pace ? 20 : 0.8, (y1 - y0) * 0.12); y0 -= yp; y1 += yp;
    const x = v => L + (v - x0) / (x1 - x0) * (W - L - R);
    // faster at the top: for pace that means small numbers up top
    const y = v => sp.pace ? T + (v - y0) / (y1 - y0) * (H - T - B) : T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

    const tMin = Math.min(...pts.map(w => w.t)), tMax = Math.max(...pts.map(w => w.t));
    const age = t => tMax > tMin ? (t - tMin) / (tMax - tMin) : 1; // 0 oldest … 1 newest
    const colorAt = t => ramp(stops, age(t));

    const s = svg("svg", { class: "g-svg g-scatter", width: W, height: H, viewBox: `0 0 ${W} ${H}` });
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

    const maxMi = Math.max(...pts.map(w => w.mi));
    const latest = pts.reduce((a, b) => (b.t > a.t ? b : a));
    const ordered = [...pts].sort((a, b) => a.t - b.t); // newest drawn last, on top
    if (G.spread) for (const w of ordered) if (w.lo != null)
      s.append(svg("line", { x1: x(w.lo), x2: x(w.hi), y1: y(yv(w)), y2: y(yv(w)), stroke: colorAt(w.t), "stroke-width": 2.5, "stroke-linecap": "round", opacity: 0.5 }));
    for (const w of ordered) {
      const picked = G.pick === w.id;
      const dot = svg("circle", { cx: x(w.avg), cy: y(yv(w)), r: 4 + 6 * Math.sqrt(w.mi / maxMi), fill: colorAt(w.t), "fill-opacity": 0.92,
        stroke: picked || w === latest ? css("--ink") : css("--surface"), "stroke-width": picked ? 2.5 : w === latest ? 1.6 : 0.8, class: "g-dot" });
      dot.addEventListener("click", () => { G.pick = picked ? null : w.id; render(); });
      s.append(dot);
    }

    // Monthly trail: each month's average heart rate and pace, joined oldest → newest.
    if (G.trail) {
      const months = new Map();
      for (const w of ordered) {
        const d = new Date(w.t), k = d.getFullYear() * 12 + d.getMonth();
        const m = months.get(k) || { ws: [], k }; m.ws.push(w); months.set(k, m);
      }
      const trail = [...months.values()].filter(m => m.ws.length >= 2).map(m => {
        const n = m.ws.length;
        return {
          hr: m.ws.reduce((a, w) => a + w.avg, 0) / n, yv: m.ws.reduce((a, w) => a + yv(w), 0) / n,
          t: m.ws.reduce((a, w) => a + w.t, 0) / n, label: new Date(m.ws[0].t).toLocaleDateString([], { month: "short" }), n,
        };
      });
      if (trail.length) {
        const ink = css("--ink");
        s.append(svg("defs", {}, svg("marker", { id: "g-arrow", viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
          svg("path", { d: "M1 1 L9 5 L1 9", fill: "none", stroke: ink, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }))));
        for (let i = 1; i < trail.length; i++) {
          const a = trail[i - 1], b = trail[i];
          const ax = x(a.hr), ay = y(a.yv), bx = x(b.hr), by = y(b.yv), len = Math.hypot(bx - ax, by - ay);
          if (len < 14) continue;
          const ux = (bx - ax) / len, uy = (by - ay) / len;
          s.append(svg("line", { x1: ax + ux * 8, y1: ay + uy * 8, x2: bx - ux * 9, y2: by - uy * 9, stroke: ink, "stroke-width": 1.6, opacity: 0.75, "marker-end": "url(#g-arrow)" }));
        }
        trail.forEach((m, i) => {
          const cx = x(m.hr), cy = y(m.yv);
          s.append(svg("rect", { x: cx - 5.5, y: cy - 5.5, width: 11, height: 11, transform: `rotate(45 ${cx} ${cy})`, fill: colorAt(m.t), stroke: ink, "stroke-width": 1.6, "pointer-events": "none" }));
          // alternate sides so labels of months that sit close together don't overlap
          const left = i % 2 === 1;
          const lab = svg("text", { x: cx + (left ? -10 : 10), y: cy + 4, class: "g-trail-label", "text-anchor": left ? "end" : "start", "pointer-events": "none" });
          lab.textContent = m.label; s.append(lab);
        });
      }
    }
    wrap.append(s);
    wrap.append(legend(stops, tMin, tMax, W));

    const skipped = all.length - pts.length;
    wrap.append(h("p", { class: "g-help", text:
      `Each dot is a ${sp.one}: further right = higher average heart rate, higher up = faster. Bigger dots are longer ${sp.label}. ` +
      (G.trail ? "◆ marks each month's average, with arrows showing which way you're heading (up and to the left = fitter). " : "") +
      "The outlined dot is your latest. Tap any dot for details." }));
    wrap.append(h("p", { class: "g-foot", text: `${pts.length} ${sp.label}` + (skipped ? ` · ${skipped} without heart rate not shown` : "") }));

    const w = pts.find(w => w.id === G.pick);
    if (w) wrap.insertBefore(detail(w, sp, colorAt(w.t)), wrap.children[3]);
    return wrap;
  }

  // Colour key: a gradient bar from the oldest workout to the newest, ticked at each month.
  function legend(stops, tMin, tMax, W) {
    const L = 54, R = 12, bw = W - L - R, H = 46;
    const id = "g-grad-" + G.sport;
    const s = svg("svg", { class: "g-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` },
      svg("defs", {}, svg("linearGradient", { id }, stops.map((c, i) => svg("stop", { offset: i / (stops.length - 1), "stop-color": c })))),
      svg("rect", { x: L, y: 18, width: bw, height: 8, rx: 4, fill: `url(#${id})` }));
    const xt = t => L + (tMax > tMin ? (t - tMin) / (tMax - tMin) : 1) * bw;
    const d = new Date(tMin); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= tMax; d.setMonth(d.getMonth() + 1)) {
      const px = xt(d.getTime());
      s.append(svg("line", { x1: px, x2: px, y1: 16, y2: 28, stroke: css("--bg"), "stroke-width": 1.5 }));
      const t = svg("text", { x: px, y: 41, class: "g-xtick", "text-anchor": "middle" }); t.textContent = d.toLocaleDateString([], { month: "short" }); s.append(t);
    }
    const ends = [[L, "start", "older"], [L + bw, "end", "newer"]];
    for (const [px, anchor, word] of ends) { const t = svg("text", { x: px, y: 11, class: "g-axis", "text-anchor": anchor }); t.textContent = word; s.append(t); }
    return h("div", { class: "g-legend-row" }, s);
  }

  function detail(w, sp, col) {
    const pace = sp.pace ? [mmss(w.sec / w.mi), "/mi"] : [(w.mi / (w.sec / 3600)).toFixed(1), "mph"];
    const card = h("div", { class: "box g-detail" },
      h("div", { class: "g-dhead" }, h("strong", { text: fmtDay(w.t) }), h("button", { type: "button", class: "link", onclick: () => { G.pick = null; render(); } }, "Close")),
      h("div", { class: "g-dstats" },
        stat(w.mi.toFixed(2), "mi"), w.sec >= 3600 ? stat(mmss(w.sec / 60), "h:mm") : stat(Math.round(w.sec / 60), "min"), stat(pace[0], pace[1]),
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

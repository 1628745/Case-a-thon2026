/* Shelf-Life Guard site. Everything is read from data/*.json and models/*.json. */
(function () {
  "use strict";
  var D = {};          // loaded data
  var M = {};          // models
  var COND = ["reference", "stale", "low_quality", "combined", "unseen"];
  var CNAME = { reference: "reference", stale: "stale", low_quality: "low quality", combined: "combined", unseen: "unseen (early scans)" };
  var CCOL = { reference: "--ref", stale: "--accent", low_quality: "--off", combined: "--bad", unseen: "--warn" };
  var METRICS = [
    ["mae_min", "MAE (min)"], ["mae_trim_min", "MAE, packages <= 24 h (min)"], ["p90_err_min", "P90 absolute error (min)"],
    ["miss_rate", "Promise-miss rate"], ["promise_width_min", "Promise width (min)"], ["defer_rate", "Deferral rate"],
    ["rare_mae_min", "Rare-area MAE (min)"]];
  var lastInferMs = null;

  // ------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function col(c) { return css(CCOL[c] || "--ink"); }
  function f1(x) { return x === null || x === undefined || isNaN(x) ? "–" : Number(x).toFixed(1); }
  function f0(x) { return x === null || x === undefined || isNaN(x) ? "–" : Math.round(x).toLocaleString(); }
  function pct(x, d) { return x === null || x === undefined || isNaN(x) ? "–" : (100 * x).toFixed(d === undefined ? 1 : d) + "%"; }
  function hm(min) { if (min === null || isNaN(min)) return "–"; var h = Math.floor(min / 60), m = Math.round(min % 60); return h + " h " + (m < 10 ? "0" : "") + m + " min"; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function getJSON(p) { return fetch(p).then(function (r) { if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }); }
  function cell(block, c, g) {
    var b = (D.summary[block] || {}).cells || [];
    for (var i = 0; i < b.length; i++) if (b[i].condition === c && b[i].guard === g) return b[i];
    return null;
  }
  function blockName() { return D.summary.final ? "final" : "dev"; }

  function layout(extra) {
    var ink = css("--ink"), muted = css("--muted"), line = css("--line");
    var l = {
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { color: ink, size: 12, family: css("--sans") || "sans-serif" },
      margin: { l: 52, r: 12, t: 26, b: 40 }, showlegend: true,
      legend: { orientation: "h", y: -0.22, font: { size: 11, color: muted } },
      xaxis: { gridcolor: line, zerolinecolor: line, linecolor: line, tickfont: { color: muted } },
      yaxis: { gridcolor: line, zerolinecolor: line, linecolor: line, tickfont: { color: muted } }
    };
    extra = extra || {};
    Object.keys(extra).forEach(function (k) {
      if (typeof extra[k] === "object" && !Array.isArray(extra[k]) && l[k]) Object.assign(l[k], extra[k]); else l[k] = extra[k];
    });
    return l;
  }
  var PCFG = { displayModeBar: false, responsive: true };
  function plot(id, traces, lay) { Plotly.react($(id), traces, layout(lay), PCFG); }

  // ------------------------------------------------------------ theme + nav
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("theme"); } catch (e) { /* storage blocked */ }
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("theme").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var dark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = dark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
      renderCharts();
    });
  }
  function initNav() {
    var links = document.querySelectorAll("nav.top a");
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + e.target.id); });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("section.slide").forEach(function (s) { io.observe(s); });
  }

  // ------------------------------------------------------------ 1 overview
  function renderOverview() {
    var S = D.summary, blk = blockName(), B = S[blk];
    var rq = B.recovery.low_quality, rc = B.recovery.combined;
    var sc = B.scorecard || [];
    var passed = sc.filter(function (r) { return r.passed; }).length;
    var on = cell(blk, "low_quality", true), off = cell(blk, "low_quality", false), ref = cell(blk, "reference", false);
    var cards = [
      ["MAE gap recovered, low quality", rq && rq.recovery !== null ? pct(rq.recovery, 0) : "–",
        off && on && ref ? "MAE " + f1(off.mae) + " → " + f1(on.mae) + " min (reference " + f1(ref.mae) + ")" : ""],
      ["MAE gap recovered, combined", rc && rc.recovery !== null ? pct(rc.recovery, 0) : "–",
        rc ? "stale + low quality; degraded " + f1(rc.degraded) + " → guarded " + f1(rc.guarded) + " min" : ""],
      ["Scorecard lines passed", passed + " / " + sc.length,
        sc.filter(function (r) { return !r.passed; }).map(function (r) { return r.criterion; }).join(", ") ? "Failed: " + sc.filter(function (r) { return !r.passed; }).map(function (r) { return r.criterion; }).join(", ") : "all lines pass"]
    ];
    $("ov-headline").innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="muted">' + esc(c[0]) + '</div><div class="stat">' + esc(c[1]) + '</div><small class="muted">' + esc(c[2]) + "</small></div>";
    }).join("");
    $("ov-block").textContent = (blk === "final" ? "Held-out weeks 22-25 (Oct 2-29, 2022), Guard settings frozen before scoring" : "Development weeks 4-21") +
      "; mean over 3 seeds; " + f0(S.retrains) + " weekly retrains in total." + (S.mock ? " (MOCK DATA: site skeleton)" : "");
  }

  // ------------------------------------------------------------ 2 console
  function vec(inp) {
    return D.console.features.map(function (k) { var v = inp[k]; return LGBTrees.f32(v === null ? NaN : v); });
  }
  function guardOn(sc) {
    var C = D.console, g = C.guard, x = vec(sc.inputs_on), feats = C.features, notes = [];
    var maxAge = g.l2.hist_max_age_days, nulled = maxAge !== null && sc.meta.hist_age_days > maxAge;
    if (nulled) { ["courier_hist_mean", "area_hist_mean"].forEach(function (k) { x[feats.indexOf(k)] = NaN; }); }
    var t0 = performance.now();
    var p50 = LGBTrees.predict(M.on_p50, x), q80 = LGBTrees.predict(M.on_p80, x);
    var t1 = performance.now();
    var ty = String(sc.meta.aoi_type);
    var off = C.offsets[ty] !== undefined ? C.offsets[ty] : C.offset_global;
    var p80 = q80 + off, width = p80 - p50;
    var wref = C.width_med[ty] !== undefined ? C.width_med[ty] : C.width_glob;
    var nullingOn = maxAge !== null && maxAge <= g.l3.defer_hist_age_days;
    var rules = [
      { name: "History-feature age", val: sc.meta.hist_age_days + " d", lim: "> " + g.l3.defer_hist_age_days + " d and cannot be dropped",
        fired: sc.meta.hist_age_days > g.l3.defer_hist_age_days && !nullingOn, note: nulled ? "stale history dropped: fallback used" : "" },
      { name: "GPS fix age", val: f1(sc.meta.gps_age_min) + " min", lim: "> " + g.l3.defer_gps_age_min + " min", fired: sc.meta.gps_age_min > g.l3.defer_gps_age_min },
      { name: "Area support (training rows)", val: f0(sc.meta.area_rows), lim: "< " + g.l3.defer_min_area_rows, fired: sc.meta.area_rows < g.l3.defer_min_area_rows },
      { name: "Interval width (P80 − P50)", val: f0(width) + " min", lim: "> " + g.l3.defer_width_k + " × " + f0(wref) + " min", fired: width > g.l3.defer_width_k * wref }
    ];
    return { p50: p50, p80: p80, width: width, rules: rules, ms: t1 - t0, nulled: nulled, defer: rules.some(function (r) { return r.fired; }) };
  }
  function guardOff(sc) {
    var x = vec(sc.inputs_off);
    var t0 = performance.now();
    var p50 = LGBTrees.predict(M.off_p50, x), p80 = LGBTrees.predict(M.off_p80, x);
    return { p50: p50, p80: p80, width: p80 - p50, ms: performance.now() - t0 };
  }
  function clock(hour, addMin) {
    var t = hour * 60 + 15 + addMin, day = Math.floor(t / 1440), m = t % 1440;
    var hh = Math.floor(m / 60), mm = Math.round(m % 60);
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm + (day > 0 ? " (+" + day + " d)" : "");
  }
  function renderConsole() {
    var C = D.console, pick = $("sc-pick");
    if (!pick.options.length) {
      C.scenarios.forEach(function (s, i) { var o = document.createElement("option"); o.value = i; o.textContent = s.name; pick.appendChild(o); });
      pick.addEventListener("change", renderConsole);
    }
    var sc = C.scenarios[+pick.value || 0];
    $("sc-desc").textContent = sc.description + " (median over " + f0(sc.n_packages) + " packages)";
    var a = guardOff(sc), b = guardOn(sc);
    lastInferMs = (a.ms + b.ms) / 4;
    var hr = sc.inputs_off.hour;
    function health(rows) {
      return '<div class="kv health">' + rows.map(function (r) {
        return '<span class="k ' + r[2] + '">' + esc(r[0]) + "</span><span>" + esc(r[1]) + "</span>";
      }).join("") + "</div>";
    }
    var hOff = [["Feature age", sc.meta.hist_age_days + " d", "na"], ["GPS fix age", f1(sc.meta.gps_age_min) + " min", "na"],
      ["Area support", f0(sc.meta.area_rows) + " rows", "na"], ["Interval width", f0(a.width) + " min", "na"]];
    var hOn = b.rules.map(function (r) { return [r.name, r.val, r.fired ? "bad" : "ok"]; });
    hOn.push(["Source reputation", (sc.meta.reputation || 0).toFixed(2), sc.meta.reputation < 0.5 ? "bad" : "ok"]);
    $("sc-off").innerHTML = "<h3>Guard off</h3>" +
      '<div class="kv"><span class="k">Expected duration (P50)</span><span class="big">' + hm(a.p50) + "</span>" +
      '<span class="k">Promise (P80)</span><span class="big">' + hm(a.p80) + "</span>" +
      '<span class="k">Promise if accepted at ' + clock(hr, 0) + '</span><span>by ' + clock(hr, a.p80) + "</span></div>" +
      '<p class="muted" style="margin-top:10px">Health card (not checked without the Guard)</p>' + health(hOff) +
      '<div class="decision approve">Auto-approved: no checks run</div>';
    var reasons = b.rules.filter(function (r) { return r.fired; }).map(function (r) { return r.name + " " + r.val + " (" + r.lim + ")"; });
    $("sc-on").innerHTML = "<h3>Guard on</h3>" +
      '<div class="kv"><span class="k">Expected duration (P50)</span><span class="big">' + hm(b.p50) + "</span>" +
      '<span class="k">Promise (conformal P80)</span><span class="big">' + hm(b.p80) + "</span>" +
      '<span class="k">Promise if accepted at ' + clock(hr, 0) + '</span><span>by ' + clock(hr, b.p80) + "</span></div>" +
      '<p class="muted" style="margin-top:10px">Health card</p>' + health(hOn) +
      (b.nulled ? '<p class="warnc">History features are ' + sc.meta.hist_age_days + " days old: dropped, model uses its fallback.</p>" : "") +
      (b.defer ? '<div class="decision defer">Defer to dispatcher: ' + esc(reasons.join("; ")) + "</div>" : '<div class="decision approve">Approve: all checks pass</div>');
    $("sc-rules").innerHTML = "<table><tr><th class='l'>Check</th><th>Value</th><th class='l'>Defers when</th><th>Result</th></tr>" +
      b.rules.map(function (r) {
        return "<tr><td class='l'>" + esc(r.name) + "</td><td>" + esc(r.val) + "</td><td class='l'>" + esc(r.lim) + "</td><td class='" + (r.fired ? "fail'>defer" : "pass'>ok") + "</td></tr>";
      }).join("") + "</table>";
    $("sc-timing").textContent = "In-browser inference: " + lastInferMs.toFixed(3) + " ms per model call (" + M.on_p50.n_trees + " trees each). Models: week-" +
      C.week + " retrain of the " + (CNAME[C.condition] || C.condition) + " feed, seed " + C.seed + ".";
    if (document.activeElement !== $("cx-promise")) $("cx-promise").value = Math.round(b.p80);
    renderEffort();
  }
  var corrections = [];
  function initCorrections() {
    $("cx-log").addEventListener("click", function () {
      var sc = D.console.scenarios[+$("sc-pick").value || 0];
      var b = guardOn(sc);
      corrections.push({ t: new Date().toLocaleTimeString(), sc: sc.name, model: Math.round(b.p80), over: +$("cx-promise").value,
        flag: $("cx-flag").checked, note: $("cx-note").value, decision: b.defer ? "deferred" : "approved" });
      var rs = D.console.review_seconds;
      $("cx-out").innerHTML = corrections.map(function (c) {
        return esc(c.t + "  " + c.sc + "  [" + c.decision + "]  model " + c.model + " min -> override " + c.over + " min" +
          (c.flag ? "  FLAG SOURCE" : "") + (c.note ? "  note: " + c.note : ""));
      }).join("<br>") + "<br><b>" + corrections.length + " correction(s) logged; estimated review time " +
        Math.round(corrections.length * rs) + " s (assumes " + rs + " s per deferred package).</b>";
      $("cx-note").value = "";
    });
  }

  // ------------------------------------------------------------ 3 timeline
  function bandTraces(c, key, color, dash, name) {
    var x = c.week, m = c[key];
    if (!m) return [];
    return [
      { x: x.concat(x.slice().reverse()), y: m.hi.concat(m.lo.slice().reverse()), fill: "toself", fillcolor: color, opacity: 0.15,
        line: { width: 0 }, hoverinfo: "skip", showlegend: false, type: "scatter" },
      { x: x, y: m.mean, name: name, mode: "lines", line: { color: color, width: 2, dash: dash }, type: "scatter" }
    ];
  }
  function markerShapes(ymax) {
    var sh = [{ type: "rect", xref: "x", yref: "paper", x0: 21.5, x1: 25.5, y0: 0, y1: 1, fillcolor: css("--chip"), opacity: 0.5, line: { width: 0 }, layer: "below" }];
    var ann = [];
    D.timeline.markers.forEach(function (m, i) {
      sh.push({ type: "line", xref: "x", yref: "paper", x0: m.week - 0.5, x1: m.week - 0.5, y0: 0, y1: 1, line: { color: css("--muted"), width: 1, dash: "dot" } });
      ann.push({ x: m.week - 0.5, y: 1 - 0.07 * (i % 3), xref: "x", yref: "paper", text: m.label, showarrow: false, xanchor: "left", font: { size: 10, color: css("--muted") } });
    });
    return { shapes: sh, annotations: ann };
  }
  function renderTimeline() {
    var mSel = $("tl-metric");
    if (!mSel.options.length) {
      METRICS.forEach(function (m) { var o = document.createElement("option"); o.value = m[0]; o.textContent = m[1]; mSel.appendChild(o); });
      $("tl-conds").innerHTML = COND.map(function (c) {
        return '<label><input type="checkbox" value="' + c + '" ' + (c === "unseen" ? "" : "checked") + "> " + esc(CNAME[c]) + "</label>";
      }).join(" ");
      var tc = $("tl-track-cond");
      COND.forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = CNAME[c]; tc.appendChild(o); });
      tc.value = "low_quality";
      [mSel, $("tl-guard"), tc].forEach(function (e) { e.addEventListener("change", renderTimeline); });
      $("tl-conds").addEventListener("change", renderTimeline);
    }
    var key = mSel.value, gsel = $("tl-guard").value;
    var conds = Array.prototype.map.call($("tl-conds").querySelectorAll("input:checked"), function (i) { return i.value; });
    var traces = [];
    D.timeline.cells.forEach(function (c) {
      if (conds.indexOf(c.condition) < 0) return;
      if ((gsel === "off" && c.guard) || (gsel === "on" && !c.guard)) return;
      traces = traces.concat(bandTraces(c, key, col(c.condition), c.guard ? "dash" : "solid", CNAME[c.condition] + (c.guard ? ", Guard on" : ", Guard off")));
    });
    var al = D.timeline.alerts.filter(function (a) { return conds.indexOf(a.condition) >= 0 && (gsel === "both" || (gsel === "on") === a.guard); });
    if (al.length && key === "miss_rate") {
      traces.push({ x: al.map(function (a) { return a.week; }), y: al.map(function (a) { return a.guard ? 0.12 : 0.11; }), mode: "markers", name: "monitor alert",
        marker: { symbol: "triangle-up", size: 9, color: al.map(function (a) { return col(a.condition); }) }, type: "scatter",
        text: al.map(function (a) { return CNAME[a.condition] + (a.guard ? " Guard on" : " Guard off") + " seed " + a.seed; }), hoverinfo: "text+x" });
    }
    var mk = markerShapes();
    var lab = METRICS.filter(function (m) { return m[0] === key; })[0][1];
    var yax = { title: { text: lab, font: { size: 12 } } };
    if (key === "miss_rate" || key === "defer_rate") yax.tickformat = ".0%";
    if (key === "miss_rate") {
      mk.shapes.push({ type: "rect", xref: "paper", x0: 0, x1: 1, y0: D.timeline.monitor.miss_low || 0.15, y1: D.timeline.monitor.miss_high || 0.25,
        fillcolor: css("--good"), opacity: 0.06, line: { width: 0 }, layer: "below" });
    }
    plot("tl-main", traces, { xaxis: { title: { text: "test week (0 = 2022-05-01)", font: { size: 12 } }, dtick: 2 }, yaxis: yax, shapes: mk.shapes, annotations: mk.annotations, margin: { t: 40 } });
    var tcond = $("tl-track-cond").value;
    function track(id, k, title, fmt) {
      var tr = [];
      D.timeline.tracks.forEach(function (t) {
        if (t.condition !== tcond) return;
        tr.push({ x: t.week, y: t[k], name: t.guard ? "Guard on" : "Guard off", mode: "lines", line: { color: t.guard ? css("--on") : css("--off"), dash: t.guard ? "dash" : "solid" }, type: "scatter" });
      });
      plot(id, tr, { title: { text: title, font: { size: 12 } }, yaxis: { tickformat: fmt || "" }, margin: { l: 44, t: 30, b: 30 }, legend: { y: -0.3 } });
    }
    track("tl-age", "mean_train_age_days", "Training-row age (days, weight-avg)");
    track("tl-sloppy", "sloppy_share_train", "Sloppy-source share of training weight", ".0%");
    track("tl-feat", "feature_age_days", "History-feature age (days)");
    track("tl-vol", "n_test", "Packages per test week");
    $("tl-notes").textContent = "Shaded: held-out weeks 22-25 (scored once, after the freeze). Dotted lines: defect onsets and real events. " +
      "Monitor: two consecutive weeks with miss rate outside " + pct(D.timeline.monitor.miss_low || 0.15, 0) + "-" + pct(D.timeline.monitor.miss_high || 0.25, 0) + " raise an alert (triangles on the miss-rate view).";
  }

  // ------------------------------------------------------------ 4 mechanism
  function chainFor(c, g) { return D.mechanism.chain.filter(function (x) { return x.condition === c && x.guard === g; })[0]; }
  function renderMechanism() {
    var sel = $("mx-cond");
    if (!sel.options.length) {
      ["low_quality", "combined", "stale", "unseen"].forEach(function (c) { var o = document.createElement("option"); o.value = c; o.textContent = CNAME[c]; sel.appendChild(o); });
      sel.addEventListener("change", renderMechanism);
    }
    var c = sel.value, off = chainFor(c, false), on = chainFor(c, true), ref = chainFor("reference", false);
    if (!off) return;
    function two(id, key, title, fmt, refKey) {
      var tr = [{ x: off.week, y: off[key], name: "Guard off", mode: "lines", line: { color: css("--off") }, type: "scatter" }];
      if (on) tr.push({ x: on.week, y: on[key], name: "Guard on", mode: "lines", line: { color: css("--on"), dash: "dash" }, type: "scatter" });
      if (refKey && ref) tr.push({ x: ref.week, y: ref[refKey], name: "reference", mode: "lines", line: { color: css("--ref"), dash: "dot" }, type: "scatter" });
      plot(id, tr, { title: { text: title, font: { size: 11 } }, yaxis: { tickformat: fmt || "" }, margin: { l: 44, t: 30, b: 30 }, legend: { y: -0.3 } });
    }
    two("mx-data", c === "stale" ? "feature_age_days" : "injected_share_train", c === "stale" ? "History-feature age (days)" : "Injected share of training weight", c === "stale" ? "" : ".0%");
    two("mx-label", "train_label_ks_vs_ref", "KS distance: training labels vs. truth");
    two("mx-model", "probe_shift_p80", "Probe-grid P80 shift vs. reference (min)");
    var gapOff = off.week.map(function (w, i) { var j = ref.week.indexOf(w); return j < 0 ? null : off.mae_min[i] - ref.mae_min[j]; });
    var gapOn = on ? on.week.map(function (w, i) { var j = ref.week.indexOf(w); return j < 0 ? null : on.mae_min[i] - ref.mae_min[j]; }) : [];
    plot("mx-dec", [{ x: off.week, y: gapOff, name: "Guard off", mode: "lines", line: { color: css("--off") }, type: "scatter" },
      { x: on ? on.week : [], y: gapOn, name: "Guard on", mode: "lines", line: { color: css("--on"), dash: "dash" }, type: "scatter" }],
      { title: { text: "MAE gap vs. reference (min)", font: { size: 11 } }, margin: { l: 44, t: 30, b: 30 }, legend: { y: -0.3 } });
    $("mx-text").textContent = (D.mechText && D.mechText[c]) || "";
    var ct = D.mechanism.controls.map(function (s, i) {
      var cl = [css("--ref"), css("--off"), css("--on"), css("--accent"), css("--warn")][i % 5];
      return { x: s.week, y: s.mae, name: s.label, mode: "lines", line: { color: cl, dash: i === 3 ? "dot" : i === 4 ? "dashdot" : "solid" }, type: "scatter" };
    });
    plot("mx-ctrl", ct, { yaxis: { title: { text: "MAE (min)" } }, margin: { l: 48, t: 10, b: 30 }, legend: { y: -0.35, font: { size: 10 } } });
    var dose = D.mechanism.dose;
    var dx = {};
    dose.forEach(function (d) { (dx[d.guard ? "on" : "off"] = dx[d.guard ? "on" : "off"] || []).push(d); });
    var dt = ["off", "on"].filter(function (k) { return dx[k]; }).map(function (k) {
      var a = dx[k].sort(function (p, q) { return p.severity - q.severity; });
      return { x: a.map(function (d) { return d.severity; }), y: a.map(function (d) { return d.mae; }), name: "Guard " + k, mode: "lines+markers",
        line: { color: k === "on" ? css("--on") : css("--off"), dash: k === "on" ? "dash" : "solid" }, type: "scatter" };
    });
    plot("mx-dose", dt, { xaxis: { title: { text: "share of couriers bulk-scanning" }, tickformat: ".0%" }, yaxis: { title: { text: "mean MAE (min)" } }, margin: { l: 48, t: 10, b: 44 }, legend: { y: -0.4 } });
    var ft = D.mechanism.frozen.map(function (s, i) {
      return { x: s.week, y: s.mae, name: s.label, mode: "lines", line: { color: [css("--ref"), css("--off"), css("--accent"), css("--bad")][i % 4], dash: i === 0 ? "dot" : "solid" }, type: "scatter" };
    });
    plot("mx-frozen", ft, { yaxis: { title: { text: "MAE (min)" } }, margin: { l: 48, t: 10, b: 30 }, legend: { y: -0.35, font: { size: 10 } } });
    $("mx-ctrl-t").textContent = (D.mechText && D.mechText.controls) || "";
    $("mx-dose-t").textContent = (D.mechText && D.mechText.dose) || "";
    $("mx-frozen-t").textContent = (D.mechText && D.mechText.frozen) || "";
    var sh = D.mechanism.shap, feats = [];
    sh.forEach(function (r) { if (feats.indexOf(r.feature) < 0) feats.push(r.feature); });
    function shv(cond, g) { return feats.map(function (f) { var r = sh.filter(function (x) { return x.condition === cond && x.guard === g && x.feature === f; })[0]; return r ? r.mean_abs_shap : null; }); }
    var cc = c === "unseen" ? "low_quality" : c;
    plot("mx-shap", [
      { y: feats, x: shv("reference", false), name: "reference", type: "bar", orientation: "h", marker: { color: css("--ref") } },
      { y: feats, x: shv(cc, false), name: CNAME[cc] + ", Guard off", type: "bar", orientation: "h", marker: { color: css("--off") } },
      { y: feats, x: shv(cc, true), name: CNAME[cc] + ", Guard on", type: "bar", orientation: "h", marker: { color: css("--on") } }],
      { barmode: "group", margin: { l: 130, t: 10, b: 40 }, xaxis: { title: { text: "mean |SHAP| (min)" } }, legend: { y: -0.15 } });
  }

  // ------------------------------------------------------------ 5 countermeasure
  function renderDiagram() {
    var boxes = [["Delivery feed", "scans, GPS, ids"], ["L1 Ingest checks", "flag + quarantine"], ["L2 Training weights", "recency × reputation × flag"],
      ["Weekly retrain", "P50 + P80 LightGBM"], ["L3 Serve-time check", "conformal promise, defer"], ["Dispatcher", "approve / override / flag"]];
    var w = 140, gap = 28, x0 = 10, s = "";
    boxes.forEach(function (b, i) {
      var x = x0 + i * (w + gap);
      s += '<rect class="box" x="' + x + '" y="40" width="' + w + '" height="70" rx="8"/>' +
        '<text x="' + (x + w / 2) + '" y="70" text-anchor="middle" font-size="14" font-weight="600">' + b[0] + "</text>" +
        '<text class="muted" x="' + (x + w / 2) + '" y="92" text-anchor="middle" font-size="11">' + b[1] + "</text>";
      if (i < boxes.length - 1) s += '<path d="M' + (x + w + 3) + " 75 L" + (x + w + gap - 5) + ' 75" stroke="currentColor" stroke-width="1.5" marker-end="url(#ah)"/>';
    });
    s += '<path d="M' + (x0 + 5 * (w + gap) + w / 2) + " 112 L" + (x0 + 5 * (w + gap) + w / 2) + " 150 L" + (x0 + w / 2) + " 150 L" + (x0 + w / 2) + ' 114" fill="none" stroke="currentColor" stroke-dasharray="4 4" marker-end="url(#ah)"/>' +
      '<text class="muted" x="500" y="170" text-anchor="middle" font-size="12">corrections and flags return to the data steward → reputation at the next retrain · monitor: weekly miss rate, alert after 2 weeks outside 15-25%</text>';
    $("cm-diagram").innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>' + s;
    $("cm-diagram").style.color = css("--muted");
  }
  function renderCounter() {
    var bsel = $("cm-block");
    if (!bsel.dataset.init) {
      bsel.dataset.init = 1;
      if (!D.summary.final) bsel.querySelector('option[value="final"]').disabled = true; else bsel.value = "final";
      bsel.addEventListener("change", renderCounter);
    }
    var blk = bsel.value, B = D.summary[blk];
    var hdr = "<tr><th class='l'>Condition</th><th class='l'>Guard</th><th>MAE (min)</th><th>± seed spread</th><th>P90 err</th><th>Miss rate</th><th>Promise width</th><th>Deferral</th><th>Down-weighted</th><th>Rare-area MAE</th></tr>";
    var rows = COND.map(function (c) {
      return [false, true].map(function (g) {
        var x = cell(blk, c, g);
        if (!x) return "";
        return "<tr><td class='l'>" + CNAME[c] + "</td><td class='l'>" + (g ? "on" : "off") + "</td><td>" + f1(x.mae) + "</td><td>" + f1(x.mae_spread) + "</td><td>" + f1(x.p90) +
          "</td><td>" + pct(x.miss) + "</td><td>" + f0(x.width) + "</td><td>" + pct(x.defer) + "</td><td>" + pct(x.downweighted, 0) + "</td><td>" + f1(x.rare_mae) + "</td></tr>";
      }).join("");
    }).join("");
    $("cm-table").innerHTML = hdr + rows;
    $("cm-recovery").innerHTML = "<table><tr><th class='l'>Condition</th><th>Gap (min)</th><th>Recovered</th><th class='l'>gap > seed spread</th></tr>" +
      Object.keys(B.recovery).map(function (k) {
        var r = B.recovery[k];
        if (!r) return "";
        return "<tr><td class='l'>" + CNAME[k] + "</td><td>" + f1(r.gap) + "</td><td>" + (r.recovery === null ? "–" : pct(r.recovery, 0)) + "</td><td class='l'>" + (r.gap_exceeds_seed_spread ? "yes" : "no") + "</td></tr>";
      }).join("") + "</table><p class='muted'>Recovery = (degraded − guarded) / (degraded − reference), MAE.</p>";
    $("cm-detector").innerHTML = Object.keys(B.detector || {}).map(function (k) {
      var d = B.detector[k];
      return "<p><b>" + CNAME[k] + "</b></p><table><tr><th></th><th>injected</th><th>clean</th></tr><tr><td class='l'>flagged</td><td>" + f0(d.tp) + "</td><td>" + f0(d.fp) +
        "</td></tr><tr><td class='l'>not flagged</td><td>" + f0(d.fn) + "</td><td>" + f0(d.tn) + "</td></tr></table><p class='muted'>precision " + pct(d.precision) +
        " · recall " + pct(d.recall) + " · false-positive rate " + pct(d.fpr, 2) + "</p>";
    }).join("") || "<p class='muted'>No guarded degraded runs in this block.</p>";
    var sl = D.shelf, tr = [];
    ["reference", "low_quality"].forEach(function (c) {
      var a = sl.filter(function (r) { return r.condition === c; });
      tr.push({ x: a.map(function (r) { return r.window_weeks === "all" ? "all" : r.window_weeks + " wk"; }), y: a.map(function (r) { return r.mae; }), name: CNAME[c],
        mode: "lines+markers", line: { color: col(c) }, type: "scatter" });
    });
    plot("cm-shelf", tr, { xaxis: { type: "category", title: { text: "training window" } }, yaxis: { title: { text: "mean MAE (min)" } }, margin: { l: 48, t: 10, b: 44 }, legend: { y: -0.4 } });
    var dev = D.summary.dev.scorecard, fin = D.summary.final ? D.summary.final.scorecard : null;
    $("cm-score").innerHTML = "<tr><th class='l'>Criterion</th><th class='l wrap'>Pass if</th><th class='l'>Dev weeks</th><th class='l wrap'>Dev value</th>" + (fin ? "<th class='l'>Held-out</th><th class='l wrap'>Held-out value</th>" : "") + "</tr>" +
      dev.map(function (r) {
        var f = fin ? fin.filter(function (x) { return x.criterion === r.criterion; })[0] : null;
        return "<tr><td class='l'>" + esc(r.criterion) + "</td><td class='l wrap'>" + esc(r.rule) + "</td><td class='l " + (r.passed ? "pass'>PASS" : "fail'>FAIL") + "</td><td class='l wrap mono'>" + esc(fmtVal(r.value)) + "</td>" +
          (fin ? (f ? "<td class='l " + (f.passed ? "pass'>PASS" : "fail'>FAIL") + "</td><td class='l wrap mono'>" + esc(fmtVal(f.value)) + "</td>" : "<td>–</td><td>–</td>") : "") + "</tr>";
      }).join("");
  }
  function fmtVal(v) {
    if (v === null || v === undefined) return "–";
    if (typeof v !== "object") return String(v);
    return Object.keys(v).map(function (k) {
      var x = v[k];
      if (x && typeof x === "object") return k + ": " + Object.keys(x).map(function (j) { return j + " " + x[j]; }).join(", ");
      return k + " " + x;
    }).join("; ");
  }

  // ------------------------------------------------------------ 6 stress
  function renderStress() {
    var F = D.summary.final;
    if (!F) { $("st-table").innerHTML = "<tr><td>Held-out evaluation not run yet.</td></tr>"; return; }
    $("st-table").innerHTML = "<tr><th class='l'>Condition</th><th>MAE off</th><th>MAE on</th><th>Recovered</th><th>Miss on</th><th>Defer on</th></tr>" +
      COND.map(function (c) {
        var a = cell("final", c, false), b = cell("final", c, true), r = F.recovery[c];
        if (!a || !b) return "";
        return "<tr><td class='l'>" + CNAME[c] + "</td><td>" + f1(a.mae) + "</td><td>" + f1(b.mae) + "</td><td>" + (r && r.recovery !== null ? pct(r.recovery, 0) : "–") + "</td><td>" + pct(b.miss) + "</td><td>" + pct(b.defer) + "</td></tr>";
      }).join("");
    var tr = [];
    D.timeline.cells.forEach(function (c) {
      var idx = c.week.map(function (w, i) { return w >= 22 ? i : -1; }).filter(function (i) { return i >= 0; });
      if (!idx.length) return;
      tr.push({ x: idx.map(function (i) { return c.week[i]; }), y: idx.map(function (i) { return c.mae_min.mean[i]; }), name: CNAME[c.condition] + (c.guard ? " on" : " off"),
        mode: "lines+markers", line: { color: col(c.condition), dash: c.guard ? "dash" : "solid" }, type: "scatter" });
    });
    plot("st-chart", tr, { xaxis: { dtick: 1, title: { text: "held-out week" } }, yaxis: { title: { text: "MAE (min)" } }, margin: { l: 48, t: 10, b: 44 }, legend: { y: -0.45, font: { size: 10 } } });
    var items = (D.stressText || []);
    var fails = F.scorecard.filter(function (r) { return !r.passed; });
    fails.forEach(function (r) { items.push({ kind: "bad", text: "Held-out scorecard line failed: " + r.criterion + " (" + r.rule + "). Value: " + fmtVal(r.value) + "." }); });
    $("st-findings").innerHTML = items.map(function (i) { return '<div class="callout ' + (i.kind || "") + '">' + esc(i.text) + "</div>"; }).join("");
    var on = cell("final", "combined", true) || cell("dev", "combined", true), off = cell("final", "combined", false) || cell("dev", "combined", false);
    var rOn = cell("final", "reference", true), rOff = cell("final", "reference", false);
    var trade = [];
    if (on && off) trade.push("Effective training size: the Guard down-weights " + pct(on.downweighted, 0) + " of combined-feed rows (reputation, quarantine and the per-courier cap); effective sample " + f0(on.eff_n) + " vs " + f0(off.eff_n) + " rows.");
    if (on) trade.push("Deferral costs people: " + pct(on.defer) + " of combined-feed packages go to a dispatcher.");
    if (rOn && rOff) trade.push("On clean data the Guard costs " + f1(rOn.mae - rOff.mae) + " min MAE and changes the promise width from " + f0(rOff.width) + " to " + f0(rOn.width) + " min.");
    if (on && off) trade.push("Compute: " + f1(on.secs) + " s vs " + f1(off.secs) + " s per weekly retrain (Guard on vs off, 3 threads).");
    $("st-trade").innerHTML = trade.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("");
  }

  // ------------------------------------------------------------ 7 oversight effort
  function renderEffort() {
    var blk = blockName(), on = cell(blk, "combined", true) || cell(blk, "reference", true);
    var tl = D.timeline.tracks.filter(function (t) { return t.condition === "reference" && !t.guard; })[0];
    if (!on || !tl) return;
    var weeks = tl.week.map(function (w, i) { return [w, tl.n_test[i]]; }).filter(function (p) { return blk === "final" ? p[0] >= 22 : p[0] < 22; });
    var perDay = weeks.reduce(function (s, p) { return s + p[1]; }, 0) / Math.max(1, weeks.length) / 7;
    var rs = D.console.review_seconds, defDay = on.defer * perDay, hrs = defDay * rs / 3600;
    $("ov-effort").innerHTML = '<div class="kv"><span class="k">Packages per day (city, ' + (blk === "final" ? "held-out" : "dev") + ' weeks)</span><span>' + f0(perDay) + "</span>" +
      '<span class="k">Deferred per day (combined feed, Guard on: ' + pct(on.defer) + ")</span><span>" + f0(defDay) + "</span>" +
      '<span class="k">Review time at ' + rs + " s each <i>(assumption)</i></span><span>" + f1(hrs) + " person-hours/day</span>" +
      '<span class="k">Dispatchers at 6 review-hours/shift</span><span>' + f1(hrs / 6) + "</span>" +
      '<span class="k">Model inference in this browser</span><span>' + (lastInferMs === null ? "–" : lastInferMs.toFixed(3) + " ms/package") + "</span>" +
      '<span class="k">Weekly retrain (Guard on)</span><span>' + f1(on.secs) + " s</span></div>" +
      "<p class='muted'>The pilot is one district, so its load is a fraction of the city figure. The 45 s review time is an assumption to be measured in the pilot.</p>";
  }

  // ------------------------------------------------------------ 8 methods
  function renderMethods() {
    var m = D.manifest;
    var rows = [["Dataset", m.name], ["Sources", m.sources.join(" , ")], ["Retrieved", m.retrieved], ["File", m.file + " (" + f0(m.bytes) + " bytes)"],
      ["SHA-256", m.sha256], ["Raw rows", f0(m.rows_raw)], ["Couriers / areas / regions", f0(m.couriers) + " / " + f0(m.areas) + " / " + f0(m.regions)],
      ["Accept dates", m.date_range.join(" to ")], ["Time format", m.time_format], ["Filters", m.filters],
      ["Observed issues (kept)", Object.keys(m.observed_issues).filter(function (k) { return typeof m.observed_issues[k] !== "object"; }).map(function (k) { return k + " " + m.observed_issues[k]; }).join("; ")],
      ["Licenses", "repository metadata " + m.licenses.repository_metadata + "; paper " + m.licenses.paper]];
    $("me-manifest").innerHTML = rows.map(function (r) { return "<tr><td class='l'>" + esc(r[0]) + "</td><td class='l wrap mono'>" + esc(r[1]) + "</td></tr>"; }).join("");
    $("me-runs").textContent = f0(D.summary.runs) + " runs, " + f0(D.summary.retrains) + " weekly retrains; config hash " + D.summary.config_hash + ", code " + D.summary.git_sha + ".";
    var ml = D.modlog || [];
    $("me-modlog").innerHTML = ml.length ? "<tr><th class='l'>Condition</th><th class='l'>Mechanism</th><th>Dose</th><th>Weeks</th><th>Rows changed</th><th>Couriers</th></tr>" +
      ml.map(function (r) {
        return "<tr><td class='l'>" + esc(CNAME[r.condition] || r.condition) + "</td><td class='l'>" + esc(r.mechanism) + "</td><td>" + (r.severity === null || r.severity === undefined ? "" : pct(r.severity, 0)) + "</td><td>" + esc(r.weeks) + "</td><td>" + f0(r.rows) + "</td><td>" + f0(r.couriers) + "</td></tr>";
      }).join("") : "<tr><td>Modification log appears after the runs.</td></tr>";
    var v = D.summary.versions || {};
    $("me-versions").textContent = Object.keys(v).map(function (k) { return k + " " + v[k]; }).join(" · ");
    $("ft-build").textContent = "results generated " + (D.summary.generated || "");
    document.querySelectorAll("[data-k]").forEach(function (e) {
      var g = D.summary.guard_config || {};
      var k = e.getAttribute("data-k");
      if (k === "h") e.textContent = g.l2 && g.l2.half_life_weeks !== null ? g.l2.half_life_weeks : "∞";
      if (k === "k") e.textContent = g.l3 ? g.l3.defer_width_k : "k";
    });
  }

  function renderCharts() {
    renderConsole(); renderTimeline(); renderMechanism(); renderDiagram(); renderCounter(); renderStress(); renderEffort();
  }

  // ------------------------------------------------------------ boot
  initTheme(); initNav(); initCorrections();
  Promise.all(["summary", "timeline", "mechanism", "shelf", "console", "manifest", "modlog", "text"].map(function (n) {
    return getJSON("data/" + n + ".json").catch(function (e) { if (n === "text") return {}; throw e; });
  })).then(function (r) {
    D.summary = r[0]; D.timeline = r[1]; D.mechanism = r[2]; D.shelf = r[3]; D.console = r[4]; D.manifest = r[5]; D.modlog = r[6];
    D.mechText = r[7].mechanism || {}; D.stressText = r[7].stress || [];
    if (r[7].video) { $("video-link").href = r[7].video; $("video-link").textContent = "Fallback video"; }
    return Promise.all(["off_p50", "off_p80", "on_p50", "on_p80"].map(function (n) { return getJSON("models/" + n + ".json"); }));
  }).then(function (ms) {
    M.off_p50 = ms[0]; M.off_p80 = ms[1]; M.on_p50 = ms[2]; M.on_p80 = ms[3];
    renderOverview(); renderMethods(); renderCharts();
  }).catch(function (e) {
    document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="callout bad">Could not load site data: ' + esc(e.message) + "</div>");
    console.error(e);
  });
})();

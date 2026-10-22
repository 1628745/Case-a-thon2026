/* Data Shelf-Life Guard site. Every number is read from data/*.json and models/*.json. */
(function () {
  "use strict";
  var D = {}, M = {}, V = {};
  var RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var CONDS = ["reference", "stale", "low_quality", "combined", "unseen"];
  var CNAME = { reference: "reference", stale: "stale", low_quality: "low quality", combined: "combined", unseen: "early scanner (unseen)" };
  var CVAR = { reference: "var(--ref)", stale: "var(--stale)", low_quality: "var(--lq)", combined: "var(--comb)", unseen: "var(--unseen)" };
  var revealed = {};

  // ------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bad(x) { return x === null || x === undefined || (typeof x === "number" && isNaN(x)); }
  function sign(x) { return x > 0 ? "+" : x < 0 ? "−" : "±"; }
  var F = {
    int: function (x) { return Math.round(x).toLocaleString("en-US"); },
    f0: function (x) { return Math.round(x).toLocaleString("en-US"); },
    f1: function (x) { return Number(x).toFixed(1); },
    f2: function (x) { return Number(x).toFixed(2); },
    pct0: function (x) { return (100 * x).toFixed(0) + "%"; },
    pct1: function (x) { return (100 * x).toFixed(1) + "%"; },
    pct2: function (x) { return (100 * x).toFixed(2) + "%"; },
    spct1: function (x) { return sign(x) + Math.abs(100 * x).toFixed(1) + "%"; },
    spct2: function (x) { return sign(x) + Math.abs(100 * x).toFixed(2) + "%"; },
    sgn1: function (x) { return sign(x) + Math.abs(x).toFixed(1); },
    raw: function (x) { return String(x); }
  };
  function fmt(x, f) { return bad(x) ? "–" : (F[f] || F.raw)(x); }
  function get(path) {
    return path.split(".").reduce(function (o, k) { return o === null || o === undefined ? undefined : o[k]; }, V);
  }
  function getJSON(p) { return fetch(p, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(p + " returned " + r.status); return r.json(); }); }
  function hm(min) { if (bad(min)) return "–"; var h = Math.floor(min / 60), m = Math.round(min % 60); if (m === 60) { h++; m = 0; } return h + " h " + (m < 10 ? "0" : "") + m + " min"; }
  function clock(minOfDay, add) {
    var t = Math.round(minOfDay + add), day = Math.floor(t / 1440), m = ((t % 1440) + 1440) % 1440;
    var hh = Math.floor(m / 60), mm = m % 60;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm + (day > 0 ? " (+" + day + " d)" : "");
  }
  function onView(el, fn, margin) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(); } });
    }, { rootMargin: margin || "0px 0px -15% 0px" });
    io.observe(el);
  }
  function seg(attr, cb) {
    document.querySelectorAll("[data-" + attr + "]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.parentNode.querySelectorAll("button").forEach(function (o) { o.setAttribute("aria-pressed", o === b ? "true" : "false"); });
        cb(b.getAttribute("data-" + attr));
      });
    });
  }
  function fill(sel, opts, value) {
    sel.innerHTML = opts.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + "</option>"; }).join("");
    if (value) sel.value = value;
  }

  // ------------------------------------------------------------ derived values
  function blockView(B) {
    if (!B) return null;
    var cells = {};
    B.cells.forEach(function (c) { (cells[c.condition] = cells[c.condition] || {})[c.guard ? "on" : "off"] = c; });
    return { cells: cells, recovery: B.recovery, detector: B.detector, scorecard: B.scorecard };
  }
  function track(c, g) { return D.timeline.tracks.filter(function (t) { return t.condition === c && t.guard === g; })[0]; }
  function last(a) { return a[a.length - 1]; }
  function mod(cond, mech, sev) {
    return D.modlog.filter(function (r) { return r.condition === cond && r.mechanism === mech && (sev === undefined || r.severity === sev); })[0] || {};
  }
  function buildV() {
    var S = D.summary, cfg = S.config;
    V = { final: blockView(S.final), dev: blockView(S.dev), cfg: cfg, console: D.console, headline: S.headline, x: {} };
    var x = V.x, sev = cfg.degrade.low_quality.sloppy_share;
    var st = track("stale", false), rf = track("reference", false), lq = track("low_quality", false);
    x.staleAgeEnd = last(st.mean_train_age_days);
    x.refAgeEnd = last(rf.mean_train_age_days);
    x.featAgeEnd = last(st.feature_age_days);
    x.lqInjPeak = Math.max.apply(null, lq.injected_share_train);
    var fin = lq.week.map(function (w, i) { return w >= cfg.splits.heldout[0] ? lq.injected_share_train[i] : null; }).filter(function (v) { return v !== null; });
    x.lqInjFinal = fin.reduce(function (a, b) { return a + b; }, 0) / fin.length;
    x.mod = {
      stale_features: mod("stale", "stale_features").rows,
      bulk: mod("low_quality", "bulk_scan", sev).rows,
      dup: mod("low_quality", "duplicate_upload", sev).rows,
      lq_couriers: mod("low_quality", "bulk_scan", sev).couriers,
      early: mod("unseen", "early_scan").rows,
      early_couriers: mod("unseen", "early_scan").couriers
    };
    var ref4 = S.shelf_life.filter(function (r) { return r.condition === "reference" && r.window_weeks === String(cfg.splits.window_weeks); })[0];
    var ctl = {};
    S.controls.forEach(function (r) { ctl[r.control] = r; });
    x.ref4 = ref4.mae;
    x.frozenFeatGap = ctl.frozen_features.mae - ref4.mae;
    x.frozenModelGap = ctl.frozen_model.mae - ref4.mae;
    var F4 = ["reference", "stale", "low_quality", "combined"];
    var fd = F4.map(function (c) { return V.final.cells[c].on.defer; });
    x.deferMin = Math.min.apply(null, fd); x.deferMax = Math.max.apply(null, fd);
    var fr = V.final.cells.reference, fs = V.final.cells.stale, dr = V.dev.cells.reference;
    x.noHarm = fr.on.mae / fr.off.mae - 1;
    x.wRefFinal = fr.on.width / fr.off.width - 1;
    x.wStaleFinal = fs.on.width / fs.off.width - 1;
    x.wRefDev = dr.on.width / dr.off.width - 1;
  }
  function bindAll() {
    document.querySelectorAll("[data-v]").forEach(function (e) {
      e.textContent = fmt(get(e.getAttribute("data-v")), e.getAttribute("data-f") || "raw");
    });
    document.querySelectorAll("[data-count]").forEach(function (e) {
      var v = get(e.getAttribute("data-count")), f = e.getAttribute("data-f") || "raw";
      e.textContent = fmt(v, f);
      if (RM || bad(v)) return;
      e.textContent = fmt(0, f);
      onView(e, function () {
        var t0 = performance.now(), dur = 1300;
        (function step(now) {
          var p = Math.min(1, (now - t0) / dur), k = 1 - Math.pow(1 - p, 3);
          e.textContent = fmt(v * k, f);
          if (p < 1) requestAnimationFrame(step);
        })(t0);
      });
    });
  }

  // ------------------------------------------------------------ nav: tracking bar
  function initNav() {
    var ids = ["poisons", "built", "analysis"], stops = document.querySelectorAll(".stop"), fillEl = $("route-fill");
    function update() {
      var mid = window.innerHeight * 0.4, tops = ids.map(function (id) { return $(id).getBoundingClientRect().top; });
      var anaBottom = $("analysis").getBoundingClientRect().bottom;
      var active = -1;
      tops.forEach(function (t, i) { if (t <= mid) active = i; });
      var p;
      if (active < 0) p = 0;
      else if (active < 2) p = (active + Math.min(1, (mid - tops[active]) / (tops[active + 1] - tops[active]))) / 2;
      else p = 1;
      if (anaBottom < mid) active = 2;
      fillEl.style.width = (100 * Math.max(0, Math.min(1, p))) + "%";
      stops.forEach(function (s, i) {
        s.classList.toggle("active", i === active);
        s.classList.toggle("passed", i < active);
        if (i === active) s.setAttribute("aria-current", "true"); else s.removeAttribute("aria-current");
      });
    }
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
  }
  function initTheme() {
    $("theme").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var dark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = dark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* storage blocked */ }
    });
  }

  // ------------------------------------------------------------ chart kit (D3)
  function base(el, opts) {
    var w = Math.max(240, el.clientWidth), h = +el.getAttribute("data-h") || 240;
    var m = Object.assign({ l: 50, r: 16, t: 26, b: 40 }, opts.margin || {});
    el.innerHTML = "";
    var svg = d3.select(el).append("svg").attr("width", w).attr("height", h).attr("role", "img")
      .attr("aria-label", opts.aria || opts.yLabel || "chart");
    return { svg: svg, g: svg.append("g").attr("transform", "translate(" + m.l + "," + m.t + ")"), w: w - m.l - m.r, h: h - m.t - m.b, m: m };
  }
  function yLabel(c, text) {
    if (text) c.g.append("text").attr("class", "axis-label").attr("x", -c.m.l + 4).attr("y", -12).text(text);
  }
  function xLabel(c, text) {
    if (text) c.g.append("text").attr("class", "axis-label").attr("x", c.w).attr("y", c.h + 34).attr("text-anchor", "end").text(text);
  }
  function tickFmt(f) { return f ? function (v) { return fmt(v, f); } : null; }
  function drawReveal(id, c, paths) {
    if (RM || revealed[id]) return;
    paths.each(function () { var L = this.getTotalLength(); d3.select(this).attr("stroke-dasharray", L + " " + L).attr("stroke-dashoffset", L); });
    var fades = c.svg.selectAll(".fadein").style("opacity", 0);
    onView(c.svg.node(), function () {
      revealed[id] = true;
      paths.classed("reveal-line", true);
      requestAnimationFrame(function () {
        paths.attr("stroke-dashoffset", 0);
        fades.classed("reveal-fade", true).style("opacity", 1);
      });
      setTimeout(function () { paths.attr("stroke-dasharray", function () { return d3.select(this).attr("data-dash"); }); }, 1500);
    });
  }
  /* series: {x, y, lo, hi, color, dash, name, w}. opts: xDomain, yFmt, xFmt, yLabel, xLabel, shade, hband, zero, markers, cat, endLabels, tipFmt */
  function lineChart(el, series, opts) {
    var c = base(el, opts);
    var xs = [], ys = [];
    series.forEach(function (s) {
      s.x.forEach(function (v, i) { if (!bad(s.y[i])) { xs.push(v); ys.push(s.y[i]); if (s.lo) { ys.push(s.lo[i]); ys.push(s.hi[i]); } } });
    });
    if (opts.zero) ys.push(0);
    if (opts.hband) ys = ys.concat(opts.hband);
    var X = opts.cat ? d3.scalePoint().domain(opts.cat).range([0, c.w]).padding(0.3)
      : d3.scaleLinear().domain(opts.xDomain || d3.extent(xs)).range([0, c.w]);
    var ext = d3.extent(ys); if (ext[0] === ext[1]) { ext[0] -= 1; ext[1] += 1; }
    var pad = (ext[1] - ext[0]) * 0.08;
    var Y = d3.scaleLinear().domain(opts.yDomain || [ext[0] - (opts.floor0 && ext[0] >= 0 ? 0 : pad), ext[1] + pad]).nice().range([c.h, 0]);
    if (opts.floor0 && Y.domain()[0] < 0 && ext[0] >= 0) Y.domain([0, Y.domain()[1]]);
    if (opts.shade) {
      c.g.append("rect").attr("x", X(opts.shade[0])).attr("width", Math.max(0, X(opts.shade[1]) - X(opts.shade[0])))
        .attr("y", 0).attr("height", c.h).style("fill", "var(--band)");
      c.g.append("text").attr("class", "axis-label").attr("x", X(opts.shade[0]) + 4).attr("y", c.h - 6).text("held out");
    }
    if (opts.hband) {
      c.g.append("rect").attr("x", 0).attr("width", c.w).attr("y", Y(opts.hband[1])).attr("height", Y(opts.hband[0]) - Y(opts.hband[1]))
        .style("fill", "var(--pass)").style("opacity", 0.09);
    }
    var nT = Math.max(3, Math.round(c.h / 45));
    c.g.append("g").attr("class", "grid").call(d3.axisLeft(Y).ticks(nT).tickSize(-c.w).tickFormat(""));
    c.g.append("g").attr("class", "axis").call(d3.axisLeft(Y).ticks(nT).tickFormat(tickFmt(opts.yFmt)));
    var xa = opts.cat ? d3.axisBottom(X) : d3.axisBottom(X).ticks(Math.min(12, Math.round(c.w / 55))).tickFormat(opts.xFmt ? tickFmt(opts.xFmt) : d3.format("d"));
    c.g.append("g").attr("class", "axis").attr("transform", "translate(0," + c.h + ")").call(xa);
    if (opts.zero && Y.domain()[0] < 0) c.g.append("line").attr("x1", 0).attr("x2", c.w).attr("y1", Y(0)).attr("y2", Y(0)).style("stroke", "var(--muted)").attr("stroke-width", 1);
    (opts.markers || []).forEach(function (mk) {
      if (X(mk.x) === undefined || X(mk.x) < 0 || X(mk.x) > c.w) return;
      c.g.append("line").attr("x1", X(mk.x)).attr("x2", X(mk.x)).attr("y1", 0).attr("y2", c.h).style("stroke", "var(--muted)").attr("stroke-dasharray", "2 4");
    });
    yLabel(c, opts.yLabel); xLabel(c, opts.xLabel);
    series.forEach(function (s) {
      if (!s.lo) return;
      var area = d3.area().defined(function (d) { return !bad(d[1]) && !bad(d[2]); }).x(function (d) { return X(d[0]); }).y0(function (d) { return Y(d[1]); }).y1(function (d) { return Y(d[2]); });
      c.g.append("path").attr("class", "fadein").attr("d", area(s.x.map(function (v, i) { return [v, s.lo[i], s.hi[i]]; }))).style("fill", s.color).style("opacity", 0.14);
    });
    var line = d3.line().defined(function (d) { return !bad(d[1]); }).x(function (d) { return X(d[0]); }).y(function (d) { return Y(d[1]); });
    var paths = c.g.selectAll(".ln").data(series).enter().append("path").attr("class", "ln")
      .attr("d", function (s) { return line(s.x.map(function (v, i) { return [v, s.y[i]]; })); })
      .attr("fill", "none").style("stroke", function (s) { return s.color; }).attr("stroke-width", function (s) { return s.w || 2.2; })
      .attr("data-dash", function (s) { return s.dash ? "6 4" : null; })
      .attr("stroke-dasharray", function (s) { return s.dash ? "6 4" : null; }).attr("stroke-linecap", "round");
    if (opts.dots) series.forEach(function (s) {
      c.g.selectAll(null).data(s.x.map(function (v, i) { return [v, s.y[i]]; }).filter(function (d) { return !bad(d[1]); })).enter().append("circle")
        .attr("class", "fadein").attr("cx", function (d) { return X(d[0]); }).attr("cy", function (d) { return Y(d[1]); }).attr("r", 3.5)
        .style("fill", s.dash ? "var(--panel)" : s.color).style("stroke", s.color).attr("stroke-width", 1.5);
    });
    if (opts.endLabels) {
      var placed = [];
      series.forEach(function (s) {
        var i = s.y.length - 1; while (i >= 0 && bad(s.y[i])) i--;
        if (i < 0) return;
        var y = Y(s.y[i]);
        placed.forEach(function (p) { if (Math.abs(p - y) < 14) y = p + (y >= p ? 14 : -14); });
        placed.push(y);
        c.g.append("text").attr("class", "direct fadein").attr("x", X(s.x[i]) + 8).attr("y", y + 4).style("fill", s.color).text(s.name);
      });
    }
    if (opts.tip !== false) hover(el, c, X, series, opts);
    drawReveal(el.id, c, paths);
    return c;
  }
  function hover(el, c, X, series, opts) {
    var tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; el.appendChild(tip);
    var rule = c.g.append("line").attr("y1", 0).attr("y2", c.h).style("stroke", "var(--ink)").style("opacity", 0);
    var xsAll = []; series.forEach(function (s) { s.x.forEach(function (v) { if (xsAll.indexOf(v) < 0) xsAll.push(v); }); });
    c.g.append("rect").attr("width", c.w).attr("height", c.h).style("fill", "transparent")
      .on("mousemove", function (ev) {
        var px = d3.pointer(ev)[0], best = null, bd = 1e9;
        xsAll.forEach(function (v) { var d = Math.abs(X(v) - px); if (d < bd) { bd = d; best = v; } });
        rule.attr("x1", X(best)).attr("x2", X(best)).style("opacity", 0.25);
        var rows = series.map(function (s) { var i = s.x.indexOf(best); return i < 0 || bad(s.y[i]) ? null : esc(s.name) + ": " + fmt(s.y[i], opts.tipFmt || opts.yFmt || "f1"); }).filter(Boolean);
        tip.innerHTML = "<b>" + esc((opts.tipX || "week ") + (opts.xFmt ? fmt(best, opts.xFmt) : best)) + "</b><br>" + rows.join("<br>");
        tip.hidden = false; tip.style.left = (c.m.l + X(best)) + "px"; tip.style.top = (c.m.t + 10) + "px";
      })
      .on("mouseleave", function () { tip.hidden = true; rule.style("opacity", 0); });
  }
  function legend(el, items) {
    el.innerHTML = items.map(function (it) {
      return '<span><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" style="stroke:' + it.color + '" stroke-width="2.5"' +
        (it.dash ? ' stroke-dasharray="5 3"' : "") + "/></svg>" + esc(it.name) + "</span>";
    }).join("");
  }
  function hbars(el, rows, opts) {
    var c = base(el, Object.assign({ margin: { l: opts.left || 190, r: 60, t: 22, b: 36 } }, opts));
    var vals = rows.map(function (r) { return r.v; }).concat([0]);
    var X = d3.scaleLinear().domain(d3.extent(vals)).nice().range([0, c.w]);
    var Y = d3.scaleBand().domain(rows.map(function (r) { return r.k; })).range([0, c.h]).padding(0.32);
    c.g.append("g").attr("class", "grid").attr("transform", "translate(0," + c.h + ")").call(d3.axisBottom(X).ticks(5).tickSize(-c.h).tickFormat(""));
    c.g.append("g").attr("class", "axis").attr("transform", "translate(0," + c.h + ")").call(d3.axisBottom(X).ticks(5));
    c.g.append("g").attr("class", "axis").call(d3.axisLeft(Y).tickSize(0)).select(".domain").remove();
    var bars = c.g.selectAll(null).data(rows).enter().append("rect")
      .attr("y", function (r) { return Y(r.k); }).attr("height", Y.bandwidth())
      .attr("x", function (r) { return X(Math.min(0, r.v)); }).attr("width", function (r) { return Math.abs(X(r.v) - X(0)); })
      .style("fill", function (r) { return r.color; }).attr("rx", 2);
    c.g.selectAll(null).data(rows).enter().append("text").attr("class", "direct")
      .attr("x", function (r) { return X(Math.max(0, r.v)) + 6; }).attr("y", function (r) { return Y(r.k) + Y.bandwidth() / 2 + 4; })
      .style("fill", "var(--ink)").text(function (r) { return r.label; });
    c.g.append("line").attr("x1", X(0)).attr("x2", X(0)).attr("y1", 0).attr("y2", c.h).style("stroke", "var(--ink)");
    xLabel(c, opts.xLabel);
    if (!RM && !revealed[el.id]) {
      bars.attr("width", 0).attr("x", X(0));
      onView(el, function () {
        revealed[el.id] = true;
        bars.transition().duration(900).delay(function (r, i) { return 120 * i; })
          .attr("x", function (r) { return X(Math.min(0, r.v)); }).attr("width", function (r) { return Math.abs(X(r.v) - X(0)); });
      });
    }
  }

  // ------------------------------------------------------------ 1 poison diagrams
  var NS = "http://www.w3.org/2000/svg";
  function mk(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else if (k === "style") e.setAttribute("style", attrs[k]); else e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function tween(dur, fn, done) {
    if (RM) { fn(1); if (done) done(); return; }
    var t0 = performance.now();
    (function step(now) { var p = Math.min(1, (now - t0) / dur); fn(p); if (p < 1) requestAnimationFrame(step); else if (done) done(); })(t0);
  }
  function ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  var T = "font: 12px var(--body); fill: var(--muted)";
  var TB = "font: 600 12px var(--body); fill: var(--ink)";

  var POISON = {
    history: function (svg) {
      var cfg = V.cfg, n = cfg.data.n_weeks, W = 340, cw = W / n, win = cfg.splits.window_weeks, dev = cfg.splits.dev;
      for (var i = 0; i < n; i++) mk("rect", { x: i * cw + 0.5, y: 52, width: cw - 1, height: 14, rx: 1.5, style: "fill: var(--line)" }, svg);
      [0, 4, 8, 12, 16, 20, 25].forEach(function (w) { mk("text", { x: w * cw + cw / 2, y: 82, "text-anchor": "middle", style: T, text: w }, svg); });
      mk("text", { x: W, y: 98, "text-anchor": "end", style: T, text: "week" }, svg);
      var rw = mk("rect", { y: 30, height: 10, rx: 2, style: "fill: var(--ref)" }, svg);
      var sw = mk("rect", { y: 10, height: 10, rx: 2, style: "fill: var(--stale)" }, svg);
      var tw = mk("rect", { y: 49, width: cw, height: 20, rx: 2, style: "fill: none; stroke: var(--ink); stroke-width: 2" }, svg);
      var lr = mk("text", { y: 39, style: TB, text: "reference: last " + win + " weeks" }, svg);
      var ls = mk("text", { y: 19, style: TB, text: "stale: every past week" }, svg);
      var tl = mk("text", { y: 114, "text-anchor": "middle", style: TB }, svg);
      function at(t) {
        var tt = Math.round(t);
        rw.setAttribute("x", Math.max(0, tt - win) * cw); rw.setAttribute("width", Math.min(win, tt) * cw);
        sw.setAttribute("x", 0); sw.setAttribute("width", tt * cw);
        tw.setAttribute("x", tt * cw);
        lr.setAttribute("x", tt * cw + cw + 4); ls.setAttribute("x", tt * cw + cw + 4);
        if (tt > n - 9) { lr.setAttribute("x", Math.max(0, tt - win) * cw - 4); lr.setAttribute("text-anchor", "end"); ls.setAttribute("x", 2); ls.setAttribute("text-anchor", "start"); ls.setAttribute("y", 8); }
        else { lr.setAttribute("text-anchor", "start"); ls.setAttribute("y", 19); }
        tl.setAttribute("x", tt * cw + cw / 2); tl.textContent = "test week " + tt;
      }
      return function (done) { tween(4200, function (p) { at(dev[0] + ease(p) * (dev[1] - dev[0])); }, done); };
    },
    frozen: function (svg) {
      var cfg = V.cfg, d0 = new Date(cfg.data.week0_start + "T00:00:00Z"), fz = new Date(cfg.degrade.stale.freeze_data_through + "T00:00:00Z");
      var nDays = cfg.data.n_weeks * 7, fd = Math.round((fz - d0) / 864e5), W = 340, dx = W / nDays;
      mk("line", { x1: 0, x2: W, y1: 70, y2: 70, style: "stroke: var(--line); stroke-width: 2" }, svg);
      var months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
      months.forEach(function (m, i) { var d = Math.round((Date.UTC(2022, 4 + i, 1) - d0) / 864e5); mk("text", { x: d * dx, y: 88, style: T, text: m }, svg); });
      var ticks = mk("g", {}, svg);
      mk("line", { x1: fd * dx, x2: fd * dx, y1: 42, y2: 74, style: "stroke: var(--stale); stroke-width: 2" }, svg);
      mk("text", { x: fd * dx + 4, y: 50, style: "font: 600 12px var(--body); fill: var(--stale)", text: "last refresh, " + cfg.degrade.stale.freeze_data_through }, svg);
      var cur = mk("circle", { cy: 70, r: 5, style: "fill: var(--ink)" }, svg);
      var age = mk("text", { x: 0, y: 22, style: "font: 800 22px var(--display); fill: var(--ink)" }, svg);
      mk("text", { x: 0, y: 112, style: T, text: "Each tick is a daily feature refresh." }, svg);
      var drawn = 0;
      function at(day) {
        while (drawn <= Math.min(day, fd)) { mk("line", { x1: drawn * dx, x2: drawn * dx, y1: 62, y2: 70, style: "stroke: var(--ref); stroke-width: 1" }, ticks); drawn++; }
        cur.setAttribute("cx", day * dx);
        var a = day <= fd ? 1 : day - fd;
        var dt = new Date(d0.getTime() + day * 864e5);
        age.textContent = months[dt.getUTCMonth() - 4] + " " + dt.getUTCDate() + ": features " + a + (a === 1 ? " day" : " days") + " old";
        age.style.fill = a > 7 ? "var(--stale)" : "var(--ink)";
      }
      return function (done) { ticks.innerHTML = ""; drawn = 0; tween(4500, function (p) { at(Math.round(p * (nDays - 1))); }, done); };
    },
    sloppy: function (svg) {
      var c = V.cfg.degrade.low_quality, W = 340, x0 = 8, x1 = W - 8;
      var t0 = 8, t1 = 20, X = function (h) { return x0 + (h - t0) / (t1 - t0) * (x1 - x0); };
      var times = [9.1, 9.8, 10.4, 11.2, 12.0, 13.1, 13.9, 14.8, 15.6, 16.5, 17.3, 18.2];
      var endT = times[times.length - 1];
      mk("line", { x1: x0, x2: x1, y1: 66, y2: 66, style: "stroke: var(--line); stroke-width: 2" }, svg);
      [8, 12, 16, 20].forEach(function (h) { mk("text", { x: X(h), y: 84, "text-anchor": "middle", style: T, text: (h < 10 ? "0" : "") + h + ":00" }, svg); });
      mk("line", { x1: X(endT), x2: X(endT), y1: 40, y2: 70, style: "stroke: var(--lq); stroke-dasharray: 3 3" }, svg);
      mk("text", { x: X(endT) + 4, y: 36, "text-anchor": "end", style: "font: 600 12px var(--body); fill: var(--lq)", text: "end-of-shift scan" }, svg);
      var dups = mk("g", {}, svg);
      var ticks = times.map(function (t) { return mk("rect", { x: X(t) - 3, y: 52, width: 6, height: 14, rx: 1.5, style: "fill: var(--ref)" }, svg); });
      var lab = mk("text", { x: 0, y: 112, style: TB }, svg);
      mk("text", { x: 0, y: 12, style: T, text: "One courier-day of delivery scans (illustrative)" }, svg);
      function place(k, p) { // first k scans (by a fixed order) slide toward the end of shift
        var order = [3, 7, 1, 10, 5, 0, 8, 2, 6, 4, 9, 11];
        times.forEach(function (t, i) {
          var hit = order.indexOf(i) < k && i !== times.length - 1;
          var tt = hit ? t + (endT - t) * p : t;
          ticks[i].setAttribute("x", X(tt) - 3);
          ticks[i].style.fill = hit && p > 0.5 ? "var(--lq)" : "var(--ref)";
        });
      }
      var n = times.length - 1;
      var kStart = Math.round(c.p_start * n), kMax = Math.round(c.p_max * n);
      return function (done) {
        dups.innerHTML = ""; place(0, 0);
        lab.textContent = "Week " + c.start_week + ": " + fmt(c.p_start, "pct0") + " of packages bulk-scanned";
        tween(1400, function (p) { place(kStart, ease(p)); }, function () {
          lab.textContent = "Week 21: " + fmt(c.p_max, "pct0") + " bulk-scanned, and re-uploads begin";
          tween(1800, function (p) { place(kStart, 1); place(kMax, ease(p)); }, function () {
            var k = Math.round(c.dup_prob * times.length);
            for (var i = 0; i < k; i++) mk("rect", { x: +ticks[i * 3 % times.length].getAttribute("x") + 2, y: 38, width: 6, height: 12, rx: 1.5, style: "fill: none; stroke: var(--lq); stroke-width: 1.5" }, dups);
            if (done) done();
          });
        });
      };
    },
    combined: function (svg, holder) {
      var R = V.dev.recovery, rows = [["stale", "stale"], ["low_quality", "low quality"], ["combined", "combined"]];
      var W = 340, max = Math.max(R.stale.gap, R.low_quality.gap, R.combined.gap), L = 92, bw = W - L - 70;
      mk("text", { x: 0, y: 12, style: T, text: "Extra MAE vs reference, min (dev weeks, Guard off)" }, svg);
      var bars = rows.map(function (r, i) {
        var y = 26 + i * 30;
        mk("text", { x: L - 8, y: y + 14, "text-anchor": "end", style: TB, text: r[1] }, svg);
        var b = mk("rect", { x: L, y: y, width: 0, height: 18, rx: 2, style: "fill: " + CVAR[r[0]] }, svg);
        var t = mk("text", { y: y + 14, style: TB }, svg);
        return [b, t, R[r[0]].gap];
      });
      return function (done) {
        tween(1100, function (p) {
          bars.forEach(function (b) { var w = bw * b[2] / max * ease(p); b[0].setAttribute("width", w); b[1].setAttribute("x", L + w + 6); b[1].textContent = "+" + (b[2] * ease(p)).toFixed(1); });
        }, done);
      };
    },
    early: function (svg) {
      var c = V.cfg.degrade.unseen, W = 340, L = 0, lens = [0.92, 0.6, 0.78, 1.0, 0.7], fr = [0.55, 0.42, 0.68, 0.48, 0.62];
      mk("text", { x: 0, y: 12, style: T, text: "Recorded delivery durations (illustrative)" }, svg);
      var bars = lens.map(function (l, i) {
        var y = 22 + i * 16;
        mk("rect", { x: L, y: y, width: l * (W - 10), height: 10, rx: 2, style: "fill: none; stroke: var(--line); stroke-width: 1.5" }, svg);
        return [mk("rect", { x: L, y: y, width: l * (W - 10), height: 10, rx: 2, style: "fill: var(--ref)" }, svg), l, fr[i]];
      });
      var lab = mk("text", { x: 0, y: 116, style: TB, text: "True duration" }, svg);
      return function (done) {
        bars.forEach(function (b) { b[0].setAttribute("width", b[1] * (W - 10)); b[0].style.fill = "var(--ref)"; });
        lab.textContent = "True duration";
        setTimeout(function () {
          lab.textContent = "Scanned at " + fmt(c.frac_low, "pct0") + "–" + fmt(c.frac_high, "pct0") + " of the true time";
          tween(1600, function (p) {
            bars.forEach(function (b) { b[0].setAttribute("width", b[1] * (W - 10) * (1 - (1 - b[2]) * ease(p))); b[0].style.fill = p > 0.3 ? "var(--unseen)" : "var(--ref)"; });
          }, done);
        }, RM ? 0 : 700);
      };
    }
  };
  function initPoisons() {
    document.querySelectorAll(".mini[data-anim]").forEach(function (el) {
      var svg = mk("svg", { viewBox: "0 0 340 120", "aria-hidden": "true", preserveAspectRatio: "xMinYMid meet" });
      el.appendChild(svg);
      var play = POISON[el.getAttribute("data-anim")](svg, el), busy = false;
      function run() { if (busy) return; busy = true; play(function () { busy = false; }); }
      if (RM) { play(); return; }
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "ghost replay"; btn.textContent = "Replay";
      btn.setAttribute("aria-label", "Replay animation");
      btn.addEventListener("click", run);
      el.appendChild(btn);
      onView(el, run, "0px 0px -25% 0px");
    });
  }
  function renderShelf() {
    var sl = D.summary.shelf_life, order = ["1", "2", "4", "8", "16", "all"];
    var cat = order.map(function (w) { return w === "all" ? "all" : w + " wk"; });
    var series = ["reference", "low_quality"].map(function (c) {
      return { name: CNAME[c], color: CVAR[c], x: cat, y: order.map(function (w) { var r = sl.filter(function (s) { return s.condition === c && s.window_weeks === w; })[0]; return r ? r.mae : null; }) };
    });
    lineChart($("ch-shelf"), series, { cat: cat, yLabel: "mean MAE (min)", xLabel: "training window", yFmt: "f0", tipFmt: "f1", dots: true, endLabels: true, tipX: "window ", margin: { r: 90 } });
  }

  // ------------------------------------------------------------ 2 sorting line (signature)
  function initSortline() {
    var host = $("sortline"), btn = $("line-pause");
    var W = 1000, H = 330, svg = mk("svg", { viewBox: "0 0 " + W + " " + H, "aria-hidden": "true" });
    host.appendChild(svg);
    var injRate = V.x.lqInjFinal, defRate = V.final.cells.low_quality.on.defer, qw = V.cfg.guard.l1.quarantine_weight;
    var Y1 = 95, Y2 = 235, MX0 = 600, MX1 = 760, L1X = 260, L2X = 430, L3X = 850;
    function belt(d) { mk("path", { d: d, class: "sl-belt" }, svg); mk("path", { d: d, class: "sl-belt-dash" }, svg); }
    belt("M120 " + Y1 + " L" + MX0 + " " + Y1);
    belt("M120 " + Y2 + " L" + MX0 + " " + Y2);
    belt("M" + MX1 + " " + Y2 + " L" + L3X + " " + Y2 + " L930 170");
    mk("path", { d: "M" + L3X + " " + Y2 + " L930 290", class: "sl-belt" }, svg);
    mk("path", { d: "M930 300 C 930 322, 900 322, 860 322 L" + L2X + " 322 L" + L2X + " " + (Y1 + 48), class: "sl-fb" }, svg);
    mk("text", { x: 444, y: 314, class: "sl-note", text: "corrections and escalations go to the data steward and into reputation at the next retrain" }, svg);
    var layer = mk("g", {}, svg);
    function station(x, y, w, h, t, s, guard) {
      var g = mk("g", { class: "sl-st" + (guard ? " guard" : "") }, svg);
      mk("rect", { x: x, y: y, width: w, height: h, rx: 8 }, g);
      mk("text", { x: x + w / 2, y: y + h / 2 - (s ? 3 : -5), "text-anchor": "middle", text: t }, g);
      if (s) mk("text", { x: x + w / 2, y: y + h / 2 + 15, "text-anchor": "middle", class: "s", text: s }, g);
      return g;
    }
    station(14, Y1 - 32, 106, 64, "Delivery feed", "scans, ids, GPS");
    station(14, Y2 - 32, 106, 64, "New package", "at acceptance");
    station(L1X - 52, Y1 - 40, 104, 80, "L1", "ingest checks", true);
    station(L2X - 52, Y1 - 40, 104, 80, "L2", "trust weights", true);
    var model = station(MX0, Y1 - 40, MX1 - MX0, Y2 - Y1 + 80, "Weekly retrain", "median + P80 LightGBM");
    station(L3X - 48, Y2 - 34, 96, 68, "L3", "promise check", true);
    station(930, 140, 66, 56, "Promise", "sent");
    station(930, 262, 66, 56, "Person", "dispatcher");
    mk("text", { x: 130, y: Y1 - 52, class: "sl-lane", text: "Every week: training records" }, svg);
    mk("text", { x: 130, y: Y2 - 50, class: "sl-lane", text: "Every package: a prediction" }, svg);
    mk("text", { x: L1X, y: Y1 + 62, "text-anchor": "middle", class: "sl-note", text: "flagged: weight × " + qw }, svg);
    mk("text", { x: L2X, y: Y1 + 62, "text-anchor": "middle", class: "sl-note", text: "recency × reputation" }, svg);
    var toks = [], acc1 = 0, acc2 = 0, spawn1 = 0, spawn2 = 0, last = null, running = false, paused = false, inView = false, pulse = 0;
    var modelRect = model.querySelector("rect");
    function addTok(lane) {
      var t = { lane: lane, x: 120, y: lane === 1 ? Y1 : Y2, r: 7, el: mk("rect", { class: "tok", width: 14, height: 11, rx: 2 }, layer) };
      if (lane === 1) { acc1 += injRate; t.bad = acc1 >= 1; if (t.bad) acc1 -= 1; t.el.style.fill = t.bad ? "var(--lq)" : "var(--ref)"; }
      else { acc2 += defRate; t.defer = acc2 >= 1; if (t.defer) acc2 -= 1; t.el.style.fill = "var(--ink)"; }
      toks.push(t);
      return t;
    }
    function draw(t) {
      var s = t.s === undefined ? 1 : t.s;
      t.el.setAttribute("x", t.x - 7 * s); t.el.setAttribute("y", t.y - 5.5 * s);
      t.el.setAttribute("width", 14 * s); t.el.setAttribute("height", 11 * s);
      t.el.style.opacity = t.o === undefined ? 1 : t.o;
    }
    function step(dt) {
      spawn1 += dt; spawn2 += dt;
      if (spawn1 > 0.32) { spawn1 = 0; addTok(1); }
      if (spawn2 > 0.75) { spawn2 = 0; addTok(2); }
      var v = 120;
      toks.forEach(function (t) {
        t.x += v * dt;
        if (t.lane === 1) {
          if (t.bad && t.x > L1X) { t.s = 0.45; t.el.style.fill = "transparent"; t.el.style.stroke = "var(--lq)"; t.el.style.strokeWidth = 2; }
          if (t.x > L2X && t.bad) t.o = 0.55;
          if (t.x > MX0 + 6) { t.dead = true; pulse = 1; }
        } else {
          if (t.x > MX0 + 6 && t.x < MX1) { t.o = 0; }
          if (t.x >= MX1) { t.o = 1; t.el.style.fill = t.defer ? "var(--tote)" : "var(--ref)"; }
          if (t.x > L3X) { var p = (t.x - L3X) / (930 - L3X); t.y = Y2 + (t.defer ? 55 : -65) * Math.min(1, p); }
          if (t.x > 935) t.dead = true;
        }
        draw(t);
      });
      toks = toks.filter(function (t) { if (t.dead) t.el.remove(); return !t.dead; });
      pulse = Math.max(0, pulse - dt * 3);
      modelRect.style.strokeWidth = 1.5 + 3 * pulse;
    }
    function frame(now) {
      if (!running) return;
      var dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000); last = now;
      step(dt);
      requestAnimationFrame(frame);
    }
    function sync() {
      var want = inView && !paused && !document.hidden;
      if (want && !running) { running = true; last = null; requestAnimationFrame(frame); }
      if (!want) running = false;
    }
    // warm the line so it starts full
    for (var i = 0; i < 900; i++) step(1 / 60);
    if (RM) { btn.hidden = true; return; }
    btn.addEventListener("click", function () {
      paused = !paused; btn.textContent = paused ? "Play" : "Pause"; btn.setAttribute("aria-pressed", paused ? "true" : "false"); sync();
    });
    document.addEventListener("visibilitychange", sync);
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { inView = es[0].isIntersecting; sync(); }).observe(host);
    else { inView = true; sync(); }
  }

  // ------------------------------------------------------------ 2 walkthrough (in-browser models)
  function vec(inp) { return D.console.features.map(function (k) { var v = inp[k]; return LGBTrees.f32(v === null ? NaN : v); }); }
  function timeIt(fn) { // repeat until 20 ms have passed: browsers coarsen performance.now()
    var n = 0, t0 = performance.now(), t1 = t0, r;
    while ((t1 - t0 < 20 && n < 2000) || n < 3) { r = fn(); n++; t1 = performance.now(); }
    return { r: r, ms: (t1 - t0) / n };
  }
  function guardOn(sc, inputs) {
    var C = D.console, g = C.guard, feats = C.features, x = vec(inputs || sc.inputs_on);
    var maxAge = g.l2.hist_max_age_days, nulled = maxAge !== null && sc.meta.hist_age_days > maxAge;
    if (nulled) ["courier_hist_mean", "area_hist_mean"].forEach(function (k) { x[feats.indexOf(k)] = NaN; });
    var t = timeIt(function () { return [LGBTrees.predict(M.on_p50, x), LGBTrees.predict(M.on_p80, x)]; });
    var p50 = t.r[0], ty = String(sc.meta.aoi_type);
    var off = C.offsets[ty] !== undefined ? C.offsets[ty] : C.offset_global;
    var p80 = t.r[1] + off, width = p80 - p50;
    var wref = C.width_med[ty] !== undefined ? C.width_med[ty] : C.width_glob;
    var dh = g.l3.defer_hist_age_days, nullingOn = maxAge !== null && (dh === null || maxAge <= dh);
    var rules = [
      { id: "age", name: "History-feature age", val: sc.meta.hist_age_days + (sc.meta.hist_age_days === 1 ? " day" : " days"), lim: dh === null ? "never (alert instead)" : "> " + dh + " days", fired: dh !== null && sc.meta.hist_age_days > dh && !nullingOn },
      { id: "gps", name: "GPS fix age", val: fmt(sc.meta.gps_age_min, "f1") + " min", lim: "> " + g.l3.defer_gps_age_min + " min", fired: sc.meta.gps_age_min > g.l3.defer_gps_age_min },
      { id: "area", name: "Area records in training window", val: fmt(sc.meta.area_rows, "int"), lim: "< " + g.l3.defer_min_area_rows, fired: sc.meta.area_rows < g.l3.defer_min_area_rows },
      { id: "width", name: "Interval width (P80 − median)", val: fmt(width, "f0") + " min", lim: "> " + g.l3.defer_width_k + " × " + fmt(wref, "f0") + " min", fired: width > g.l3.defer_width_k * wref }
    ];
    return { p50: p50, p80: p80, width: width, wref: wref, rules: rules, ms: t.ms, nulled: nulled, defer: rules.some(function (r) { return r.fired; }) };
  }
  function guardOff(sc) {
    var x = vec(sc.inputs_off);
    var t = timeIt(function () { return [LGBTrees.predict(M.off_p50, x), LGBTrees.predict(M.off_p80, x)]; });
    return { p50: t.r[0], p80: t.r[1], width: t.r[1] - t.r[0], ms: t.ms };
  }
  function renderSlip() {
    var sc = D.console.scenarios.filter(function (s) { return s.id === "sloppy"; })[0] || D.console.scenarios[0];
    var a = guardOff(sc), b = guardOn(sc), md = sc.inputs_off.minute_of_day;
    $("slip-pkg").textContent = "Accepted " + clock(md, 0) + ". Courier reputation " + fmt(sc.meta.reputation, "f2") + ": recent scans are bulk end-of-shift scans and re-uploads.";
    $("slip-off").innerHTML = esc(hm(a.p80)) + "<small>deliver by " + esc(clock(md, a.p80)) + "</small>";
    $("slip-on").innerHTML = esc(hm(b.p80)) + "<small>deliver by " + esc(clock(md, b.p80)) + "</small>";
  }
  var caseOpened = 0, actions = [], curModelMs = null;
  function scenario() { return D.console.scenarios[+$("sc-pick").value || 0]; }
  function initWalk() {
    var C = D.console, pick = $("sc-pick");
    fill(pick, C.scenarios.map(function (s, i) { return [i, s.name]; }));
    var first = 0;
    for (var i = 0; i < C.scenarios.length; i++) if (guardOn(C.scenarios[i]).defer) { first = i; break; }
    pick.value = first;
    pick.addEventListener("change", renderWalk);
    function act(kind) {
      var sc = scenario(), b = guardOn(sc), secs = (performance.now() - caseOpened) / 1000;
      var rec = { kind: kind, sc: sc.name, model: Math.round(b.p80), secs: secs, note: $("act-note").value.trim(), state: b.defer ? "deferred" : "auto-approved" };
      if (kind === "Corrected") rec.to = +$("act-min").value;
      actions.unshift(rec);
      $("ef-human").textContent = secs.toFixed(1) + " s";
      $("act-log").innerHTML = actions.map(function (r) {
        return "<div><b>" + esc(r.kind) + "</b>: " + esc(r.sc) + " (" + r.state + "), model promise " + r.model + " min" +
          (r.to !== undefined ? ", corrected to " + r.to + " min" : "") + (r.kind === "Escalated" ? ", sent to the data steward's queue" : "") +
          (r.note ? ". Note: " + esc(r.note) : "") + ". Review time " + r.secs.toFixed(1) + " s.</div>";
      }).join("");
      $("act-note").value = "";
      caseOpened = performance.now();
    }
    $("act-approve").addEventListener("click", function () { act("Approved"); });
    $("act-correct").addEventListener("click", function () { act("Corrected"); });
    $("act-escalate").addEventListener("click", function () { act("Escalated"); });
    renderWalk();
  }
  function renderWalk() {
    var sc = scenario(), C = D.console, g = C.guard, a = guardOff(sc), b = guardOn(sc), md = sc.inputs_off.minute_of_day;
    caseOpened = performance.now();
    $("sc-desc").textContent = sc.description + " Inputs are medians over " + fmt(sc.n_packages, "int") + " packages.";
    function side(title, r, sub) {
      return "<h5>" + title + "</h5><div class='p'>" + esc(hm(r.p80)) + "</div><div class='s'>promise: deliver by " + esc(clock(md, r.p80)) +
        "</div><div class='s'>expected (median) " + esc(hm(r.p50)) + "</div><div class='s'>" + sub + "</div>";
    }
    $("w-off").innerHTML = side("Guard off", a, "no checks run, sent automatically");
    $("w-on").innerHTML = side("Guard on", b, "calibrated P80, after the checks below");
    var reasons = b.rules.filter(function (r) { return r.fired; });
    $("w-decision").innerHTML = b.defer
      ? "<div class='verdict defer'>Deferred to the dispatcher: " + esc(reasons.map(function (r) { return r.name.toLowerCase() + " " + r.val + " (rule: " + r.lim + ")"; }).join("; ")) + ".</div>"
      : "<div class='verdict ok'>All serve-time checks pass, so the Guard sends this promise automatically.</div>";
    $("w-rules").innerHTML = "<tr><th class='l'>Check</th><th>Value</th><th class='l'>Defers when</th><th class='l'>Result</th></tr>" +
      b.rules.map(function (r) {
        return "<tr><td class='l'>" + esc(r.name) + "</td><td>" + esc(r.val) + "</td><td class='l'>" + esc(r.lim) + "</td><td class='l " + (r.fired ? "fail'>defer" : "pass'>pass") + "</td></tr>";
      }).join("") +
      "<tr><td class='l'>Courier reputation (L2)</td><td>" + fmt(sc.meta.reputation, "f2") + "</td><td class='l'>weights training, never defers</td><td class='l " + (sc.meta.reputation < 0.5 ? "fail'>down-weighted" : "pass'>full weight") + "</td></tr>";
    var age = sc.meta.hist_age_days, rep = sc.meta.reputation, ci = C.features.indexOf("courier_hist_mean");
    var gauges = [
      { k: "History-feature age", v: age + (age === 1 ? " day" : " days"), p: Math.min(1, age / 60), bad: age > 7, n: age > 7 ? "Older than 7 days: kept, and the data steward gets a feature-store alert." : "Refreshed daily." },
      { k: "Courier reputation", v: fmt(rep, "f2") + " of 1", p: rep, bad: rep < 0.5, n: rep < 0.5 ? "Their records disagree with peers in the same area and hour, and many were flagged." : "In line with peers." },
      { k: "Courier history, raw vs guarded", v: fmt(sc.inputs_off.courier_hist_mean, "f0") + " → " + fmt(sc.inputs_on.courier_hist_mean, "f0") + " min", p: Math.min(1, sc.inputs_on.courier_hist_mean / Math.max(1, sc.inputs_off.courier_hist_mean)), bad: rep < 0.5, n: "Mean recorded duration, last 14 days. Guarded = quarantined records removed." },
      { k: "Area support", v: fmt(sc.meta.area_rows, "int") + " records", p: Math.min(1, sc.meta.area_rows / 60), bad: sc.meta.area_rows < g.l3.defer_min_area_rows, n: "Training records from this area in the last " + V.cfg.splits.window_weeks + " weeks." },
      { k: "GPS fix age", v: fmt(sc.meta.gps_age_min, "f1") + " min", p: 1, bad: false, n: "Always 0 in LaDe, so this check can't fire on this data." }
    ];
    $("w-quality").innerHTML = gauges.map(function (q) {
      return "<div class='gauge" + (q.bad ? " bad" : "") + "'><span class='k'>" + esc(q.k) + "</span><span class='v'>" + esc(q.v) + "</span><div class='bar'><i style='width:" + (100 * Math.max(0.03, q.p)).toFixed(0) + "%'></i></div><span class='g-note'>" + esc(q.n) + "</span></div>";
    }).join("");
    var ex = [];
    var raw = Object.assign({}, sc.inputs_on, { courier_hist_mean: sc.inputs_off.courier_hist_mean, area_hist_mean: sc.inputs_off.area_hist_mean, open_workload: sc.inputs_off.open_workload });
    var wi = guardOn(sc, raw);
    reasons.forEach(function (r) {
      if (r.id === "area") ex.push("This area has no records in the last " + V.cfg.splits.window_weeks + " weeks of training data, so the model would be guessing from other areas. The Guard asks a person instead of promising.");
      if (r.id === "width") ex.push("The model is unsure: the gap between its median and its promise is " + fmt(b.width, "f0") + " min, more than " + g.l3.defer_width_k + "× the usual " + fmt(b.wref, "f0") + " min for this area type.");
      if (r.id === "gps") ex.push("The courier's GPS fix is " + fmt(sc.meta.gps_age_min, "f1") + " min old, so the distance input can't be trusted.");
    });
    if (rep < 0.5) ex.push("This courier's records look like bulk scans and re-uploads, so the Guard down-weights them in training and leaves them out of the history it serves.");
    if (Math.abs(wi.p80 - b.p80) >= 5) ex.push("What-if, computed live: feeding the Guard's own model the raw history (" + fmt(sc.inputs_off.courier_hist_mean, "f0") + " min for this courier) instead of the guarded history moves its promise from " + hm(b.p80) + " to " + hm(wi.p80) + "." + (rep < 0.5 ? " Most of the Guard-off promise comes from the inflated history, not from the package." : ""));
    if (age > 7) ex.push("The history features are " + age + " days old. In our tests stale history stayed informative, so the Guard keeps it and alerts the data steward instead of deferring every package.");
    if (!ex.length) ex.push("Nothing unusual: fresh history, a known area, a reliable courier and a normal interval. The Guard-on promise differs from Guard off only through calibration and trust weights.");
    $("w-explain").innerHTML = ex.map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("");
    if (document.activeElement !== $("act-min")) $("act-min").value = Math.round(b.p80);
    curModelMs = b.ms;
    $("ef-model").textContent = b.ms < 0.1 ? b.ms.toFixed(3) + " ms" : b.ms.toFixed(2) + " ms";
    $("ef-human").textContent = "starts now";
    renderScale();
  }
  function renderScale() {
    var on = V.final.cells.combined.on, tl = track("reference", false), h0 = V.cfg.splits.heldout[0];
    var wk = tl.week.map(function (w, i) { return [w, tl.n_test[i]]; }).filter(function (p) { return p[0] >= h0; });
    var perDay = wk.reduce(function (s, p) { return s + p[1]; }, 0) / wk.length / 7, rs = D.console.review_seconds;
    var defDay = on.defer * perDay, hrs = defDay * rs / 3600;
    $("ef-scale").innerHTML = "<p>At city scale in held-out weeks: about " + fmt(perDay, "int") + " packages a day; with the combined feed the Guard defers " + fmt(on.defer, "pct1") +
      ", about " + fmt(defDay, "int") + " a day. At " + rs + " s each that is " + fmt(hrs, "f1") + " person-hours of review a day, against " + (curModelMs === null ? "–" : curModelMs.toFixed(2)) +
      " ms of model time per package and " + fmt(on.secs, "f0") + " s per weekly retrain. A one-district pilot carries a fraction of that load.</p>";
  }

  // ------------------------------------------------------------ 3 matrix
  var mxBlock = "final";
  function renderMatrix() {
    var B = V[mxBlock], ref = B.cells.reference.off.mae;
    var conds = ["reference", "stale", "low_quality", "combined"].concat(B.cells.unseen ? ["unseen"] : []);
    function cellHtml(x) {
      var gap = x.mae - ref;
      return "<span class='m'>" + fmt(x.mae, "f1") + "</span> <span class='sp'>± " + fmt(x.mae_spread, "f1") + "</span><span class='gap'>" + (Math.abs(gap) < 0.005 ? "reference" : fmt(gap, "sgn1") + " min vs reference") + "</span>";
    }
    $("mx-table").innerHTML = "<caption class='sr'>MAE by condition and Guard, " + (mxBlock === "final" ? "held-out weeks" : "development weeks") + "</caption>" +
      "<tr><th class='l'>Condition</th><th>Guard off<br>MAE (min)</th><th>Guard on<br>MAE (min)</th><th>Gap recovered</th><th>Miss rate<br>off → on</th><th>Promise width (min)<br>off → on</th><th>Deferred<br>(on)</th></tr>" +
      conds.map(function (c) {
        var o = B.cells[c].off, n = B.cells[c].on, r = B.recovery[c];
        var rec = c === "reference" ? "<span class='sp'>cost " + fmt(n.mae / o.mae - 1, "spct2") + "</span>" : "<span class='rec'>" + fmt(r && r.recovery, "pct0") + "</span>";
        return "<tr" + (c === "unseen" ? " class='extra'" : "") + "><td class='l'><span class='cname' style='--c:" + CVAR[c] + "'><i></i>" + esc(CNAME[c]) + "</span>" +
          (c === "unseen" ? "<span class='gap'>held-out stress test, outside the 8 cells</span>" : "") + "</td><td>" + cellHtml(o) + "</td><td>" + cellHtml(n) + "</td><td>" + rec +
          "</td><td>" + fmt(o.miss, "pct1") + " → " + fmt(n.miss, "pct1") + "</td><td>" + fmt(o.width, "f0") + " → " + fmt(n.width, "f0") + "</td><td>" + fmt(n.defer, "pct1") + "</td></tr>";
      }).join("");
    renderDumbbell(B, conds, ref);
  }
  function renderDumbbell(B, conds, ref) {
    var el = $("ch-dumbbell"), c = base(el, { margin: { l: 170, r: 30, t: 24, b: 42 }, aria: "MAE with and without the Guard by condition" });
    var vals = []; conds.forEach(function (k) { vals.push(B.cells[k].off.mae, B.cells[k].on.mae); });
    var X = d3.scaleLinear().domain(d3.extent(vals.concat([ref]))).nice().range([0, c.w]);
    var Y = d3.scalePoint().domain(conds).range([0, c.h]).padding(0.5);
    c.g.append("g").attr("class", "grid").attr("transform", "translate(0," + c.h + ")").call(d3.axisBottom(X).ticks(6).tickSize(-c.h).tickFormat(""));
    c.g.append("g").attr("class", "axis").attr("transform", "translate(0," + c.h + ")").call(d3.axisBottom(X).ticks(6));
    c.g.append("g").attr("class", "axis").call(d3.axisLeft(Y).tickSize(0).tickFormat(function (k) { return CNAME[k]; })).select(".domain").remove();
    c.g.append("line").attr("x1", X(ref)).attr("x2", X(ref)).attr("y1", -8).attr("y2", c.h).style("stroke", "var(--ref)").attr("stroke-width", 2);
    c.g.append("text").attr("class", "direct").attr("x", X(ref)).attr("y", -12).attr("text-anchor", "middle").style("fill", "var(--ref)").text("reference " + fmt(ref, "f1"));
    xLabel(c, "MAE (min)");
    conds.forEach(function (k) {
      var o = B.cells[k].off.mae, n = B.cells[k].on.mae, y = Y(k), col = CVAR[k];
      var ln = c.g.append("line").attr("x1", X(o)).attr("x2", X(o)).attr("y1", y).attr("y2", y).style("stroke", col).attr("stroke-width", 3);
      c.g.append("circle").attr("cx", X(o)).attr("cy", y).attr("r", 6).style("fill", "var(--floor)").style("stroke", col).attr("stroke-width", 2.5);
      var dot = c.g.append("circle").attr("cx", X(o)).attr("cy", y).attr("r", 6).style("fill", col);
      function go(anim) {
        (anim ? ln.transition().duration(900) : ln).attr("x2", X(n));
        (anim ? dot.transition().duration(900) : dot).attr("cx", X(n));
      }
      if (RM || revealed[el.id]) go(false); else onView(el, function () { revealed[el.id] = true; go(true); });
    });
  }

  // ------------------------------------------------------------ 3 weekly
  var wkGuard = "both";
  var METRICS = [["gap", "MAE gap vs reference (min)", "sgn1"], ["mae_min", "MAE (min)", "f0"], ["mae_trim_min", "MAE, packages ≤ 24 h (min)", "f0"],
    ["p90_err_min", "90th-percentile error (min)", "f0"], ["miss_rate", "Promise-miss rate", "pct0"], ["promise_width_min", "Promise width (min)", "f0"],
    ["defer_rate", "Deferral rate", "pct0"], ["rare_mae_min", "Rare-area MAE (min)", "f0"]];
  function initWeekly() {
    fill($("wk-metric"), METRICS.map(function (m) { return [m[0], m[1]]; }), "gap");
    $("wk-conds").insertAdjacentHTML("beforeend", CONDS.map(function (c) {
      return "<label style='--c:" + CVAR[c] + "'><input type='checkbox' value='" + c + "'" + (c === "unseen" ? "" : " checked") + "><i></i>" + esc(CNAME[c]) + "</label>";
    }).join(""));
    fill($("wk-track"), CONDS.map(function (c) { return [c, CNAME[c]]; }), "low_quality");
    $("wk-metric").addEventListener("change", renderWeekly);
    $("wk-conds").addEventListener("change", renderWeekly);
    $("wk-track").addEventListener("change", renderTracks);
    seg("guard", function (v) { wkGuard = v; renderWeekly(); });
  }
  function renderWeekly() {
    var key = $("wk-metric").value, meta = METRICS.filter(function (m) { return m[0] === key; })[0];
    var conds = Array.prototype.map.call($("wk-conds").querySelectorAll("input:checked"), function (i) { return i.value; });
    var refOff = D.timeline.cells.filter(function (c) { return c.condition === "reference" && !c.guard; })[0];
    var series = [];
    D.timeline.cells.forEach(function (c) {
      if (conds.indexOf(c.condition) < 0) return;
      if ((wkGuard === "off" && c.guard) || (wkGuard === "on" && !c.guard)) return;
      if (key === "gap" && c.condition === "reference" && !c.guard) return;
      var src = c[key === "gap" ? "mae_min" : key];
      var sub = function (arr) {
        return c.week.map(function (w, i) {
          if (key !== "gap") return arr[i];
          var j = refOff.week.indexOf(w); return j < 0 ? null : arr[i] - refOff.mae_min.mean[j];
        });
      };
      series.push({ name: CNAME[c.condition] + (c.guard ? ", Guard on" : ", Guard off"), color: CVAR[c.condition], dash: c.guard, x: c.week, y: sub(src.mean), lo: sub(src.lo), hi: sub(src.hi) });
    });
    var h0 = V.cfg.splits.heldout[0], h1 = V.cfg.splits.heldout[1];
    lineChart($("ch-weekly"), series, {
      xDomain: [V.cfg.splits.dev[0], h1], shade: [h0 - 0.5, h1 + 0.5], zero: key === "gap", hband: key === "miss_rate" ? [D.timeline.monitor.miss_low, D.timeline.monitor.miss_high] : null,
      yLabel: meta[1], xLabel: "test week (week 0 starts " + V.cfg.data.week0_start + ")", yFmt: meta[2], tipFmt: meta[2] === "f0" ? "f1" : meta[2] === "pct0" ? "pct1" : meta[2],
      markers: D.timeline.markers.map(function (m) { return { x: m.week - 0.5, label: m.label }; }), aria: meta[1] + " by test week"
    });
    legend($("lg-weekly"), series.map(function (s) { return { name: s.name, color: s.color, dash: s.dash }; }).concat(key === "miss_rate" ? [] : []));
    var ev = D.timeline.markers.map(function (m) { return "week " + m.week + ": " + m.label; }).join("; ");
    $("lg-weekly").insertAdjacentHTML("beforeend", "<span class='note'>Dotted lines: " + esc(ev) + "." + (key === "miss_rate" ? " Green band: the monitor's normal range." : "") + "</span>");
  }
  function renderTracks() {
    var c = $("wk-track").value, col = CVAR[c];
    function tr(id, k, f) {
      var s = [false, true].map(function (g) { var t = track(c, g); return t ? { name: g ? "Guard on" : "Guard off", color: col, dash: g, x: t.week, y: t[k], w: 2 } : null; }).filter(Boolean);
      lineChart($(id), s, { yFmt: f, tipFmt: f === "pct0" ? "pct1" : f === "f0" ? "f1" : f, margin: { l: 46, t: 12, b: 26 }, floor0: true, shade: [V.cfg.splits.heldout[0] - 0.5, V.cfg.splits.heldout[1] + 0.5], xDomain: [V.cfg.splits.dev[0], V.cfg.splits.heldout[1]] });
    }
    tr("tk-inj", "injected_share_train", "pct0");
    tr("tk-age", "mean_train_age_days", "f0");
    tr("tk-feat", "feature_age_days", "f0");
    tr("tk-vol", "n_test", "int");
  }

  // ------------------------------------------------------------ 3 chain
  function chainFor(c, g) { return D.mechanism.chain.filter(function (x) { return x.condition === c && x.guard === g; })[0]; }
  function initChain() {
    var opts = ["low_quality", "combined", "stale", "unseen"].filter(function (c) { return chainFor(c, false); });
    fill($("chain-cond"), opts.map(function (c) { return [c, CNAME[c]]; }), "low_quality");
    $("chain-cond").addEventListener("change", renderChain);
  }
  function renderChain() {
    var c = $("chain-cond").value, off = chainFor(c, false), on = chainFor(c, true), ref = chainFor("reference", false), col = CVAR[c];
    var small = { margin: { l: 44, t: 12, b: 26 } };
    function two(id, key, f) {
      var s = [{ name: "Guard off", color: col, x: off.week, y: off[key] }];
      if (on) s.push({ name: "Guard on", color: col, dash: true, x: on.week, y: on[key] });
      lineChart($(id), s, Object.assign({ yFmt: f, tipFmt: f === "pct0" ? "pct1" : f === "f3" ? "f2" : "f1", zero: true }, small));
    }
    var stale = c === "stale";
    two("cn-data", stale ? "feature_age_days" : "injected_share_train", stale ? "f0" : "pct0");
    $("cn-data-c").textContent = stale ? "Data: history-feature age, days" : "Data: injected share of training weight";
    two("cn-label", "train_label_ks_vs_ref", "f2");
    two("cn-model", "probe_shift_p80", "f0");
    function gap(s) { return s.week.map(function (w, i) { var j = ref.week.indexOf(w); return j < 0 ? null : s.mae_min[i] - ref.mae_min[j]; }); }
    var g = [{ name: "Guard off", color: col, x: off.week, y: gap(off) }];
    if (on) g.push({ name: "Guard on", color: col, dash: true, x: on.week, y: gap(on) });
    lineChart($("cn-dec"), g, Object.assign({ yFmt: "f0", tipFmt: "sgn1", zero: true }, small));
    $("chain-text").textContent = (D.text.mechanism || {})[c] || "";
  }
  function renderControls() {
    var S = D.summary, ref = V.x.ref4, ctl = {};
    S.controls.forEach(function (r) { ctl[r.control] = r; });
    var lqOff = S.shelf_life.filter(function (r) { return r.condition === "low_quality" && r.window_weeks === String(V.cfg.splits.window_weeks); })[0].mae;
    var bc = V.dev.scorecard.filter(function (r) { return r.criterion === "Beats control"; })[0];
    var rows = [
      { k: "No fix", v: lqOff - ref, color: "var(--lq)" },
      { k: "Random removal, same count", v: ctl.random.mae - ref, color: "var(--muted)" },
      { k: "Oracle: drop injected rows", v: ctl.oracle.mae - ref, color: "var(--ref)" },
      { k: "Guard", v: bc.value.guard - ref, color: "var(--tote)" }
    ];
    rows.forEach(function (r) { r.label = fmt(r.v, "sgn1") + " min"; });
    hbars($("ch-ctrl"), rows, { xLabel: "MAE minus reference (min)", aria: "Low quality condition: extra MAE under each fix" });
    $("ch-ctrl-c").textContent = (D.text.mechanism || {}).controls || "";
    var dose = S.dose, sv = [];
    [false, true].forEach(function (g) {
      var a = dose.filter(function (d) { return d.guard === g; }).sort(function (p, q) { return p.severity - q.severity; });
      sv.push({ name: g ? "Guard on" : "Guard off", color: g ? "var(--tote-ink)" : "var(--lq)", dash: g, x: a.map(function (d) { return d.severity; }), y: a.map(function (d) { return d.mae; }) });
    });
    lineChart($("ch-dose"), sv, { yLabel: "mean MAE (min)", xLabel: "share of couriers bulk-scanning", xFmt: "pct0", yFmt: "f0", tipFmt: "f1", dots: true, endLabels: true, tipX: "share ", margin: { r: 80 } });
    // tooltip x labels for dose are fractions; acceptable as "share 0.35"
    $("ch-dose-c").textContent = (D.text.mechanism || {}).dose || "";
  }

  // ------------------------------------------------------------ 3 classifier
  var clBlock = "final";
  function initClassifier() {
    $("cl-cond").addEventListener("change", renderClassifier);
    seg("clblock", function (v) { clBlock = v; renderClassifier(); });
  }
  function renderClassifier() {
    var B = V[clBlock], keys = ["low_quality", "combined", "stale", "unseen"].filter(function (k) { return B.detector[k]; });
    var sel = $("cl-cond"), prev = sel.value;
    fill(sel, keys.map(function (k) { return [k, CNAME[k]]; }), keys.indexOf(prev) >= 0 ? prev : "low_quality");
    var k = sel.value, d = B.detector[k];
    var span = clBlock === "final" ? V.cfg.splits.heldout : V.cfg.splits.dev, nW = span[1] - span[0] + 1, nS = V.cfg.seeds.length;
    $("cl-unit").textContent = "One check of one training record in one weekly retrain. A record is checked again in every window it falls in (up to " + V.cfg.splits.window_weeks +
      " times; stale and combined train on all past weeks, so more), and counts are summed over " + nW * nS + " retrains (" + nW + " weeks × " + nS + " seeds).";
    var pos = d.tp + d.fn, neg = d.fp + d.tn;
    function cl(v, of, label, cc) {
      var share = of ? v / of : 0;
      return "<div class='c' style='--cc:" + cc + "'><div class='fill' style='height:" + (100 * share).toFixed(1) + "%'></div><b>" + fmt(v, "int") + "</b><span>" + label + (of ? ", " + fmt(share, share < 0.01 ? "pct2" : "pct1") + " of column" : "") + "</span></div>";
    }
    $("cl-matrix").innerHTML = "<div></div><div class='h'>Actually injected</div><div class='h'>Actually clean</div>" +
      "<div class='rh'>Flagged</div>" + cl(d.tp, pos, "true positives", "var(--pass)") + cl(d.fp, neg, "false positives", "var(--fail)") +
      "<div class='rh'>Not flagged</div>" + cl(d.fn, pos, "false negatives", "var(--fail)") + cl(d.tn, neg, "true negatives", "var(--pass)");
    function rate(v, name, how) { return "<div><b>" + (bad(v) ? "n/a" : fmt(v, v < 0.01 && v > 0 ? "pct2" : "pct1")) + "</b><span>" + name + "<br>" + how + "</span></div>"; }
    $("cl-rates").innerHTML = rate(pos ? d.precision : null, "Precision", "flags that were really injected") + rate(d.recall, "Recall", "injected records that got flagged") + rate(d.fpr, "False-positive rate", "clean records flagged");
    var note = {
      low_quality: "Bulk scans leave a same-minute burst and re-uploads repeat a package id, which is exactly what L1 looks for. That's also why we froze the Guard and tested a defect that leaves neither.",
      combined: "Same checks on the combined feed. Slightly lower precision: training on every past week puts more honest records in front of the checks.",
      stale: "No records were injected, so every flag here is a false positive on real data (mostly couriers more than " + V.cfg.guard.l1.dist_max_km + " km from the stop). Precision is undefined, not zero.",
      unseen: "The early scanner leaves no burst and no duplicate, so L1 is close to blind: this is the failure shown below."
    };
    $("cl-note").textContent = note[k] || "";
  }

  // ------------------------------------------------------------ 3 failures, scorecard, footer
  function renderFails() {
    var on = V.final.cells.combined.on, off = V.final.cells.combined.off, r = V.final.cells.reference;
    var items = [
      "Deferral needs people: " + fmt(V.x.deferMin, "pct1") + "–" + fmt(V.x.deferMax, "pct1") + " of packages go to a dispatcher.",
      "Less effective data: on the combined feed the Guard down-weights " + fmt(on.downweighted, "pct0") + " of training records (effective sample " + fmt(on.eff_n, "int") + " vs " + fmt(off.eff_n, "int") + ").",
      "Slower retrains: " + fmt(on.secs, "f1") + " s vs " + fmt(off.secs, "f1") + " s per weekly retrain on the combined feed.",
      "On clean data: " + fmt(r.on.mae - r.off.mae, "sgn1") + " min MAE (" + fmt(V.x.noHarm, "spct2") + ")."
    ];
    $("fl-trade").innerHTML = items.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("");
  }
  function scoreVal(r) {
    var v = r.value, n = function (k) { return CNAME[k] || k; };
    switch (r.criterion) {
      case "Recovery": return Object.keys(v).map(function (k) { return n(k) + " " + fmt(v[k], "pct1"); }).join(", ");
      case "No harm": return fmt(v, "spct2") + " MAE";
      case "Promise quality": return Object.keys(v).map(function (k) { var x = v[k]; return n(k) + ": miss " + fmt(x.miss_on, "pct1") + ", width " + fmt(x.width_off, "f1") + " → " + fmt(x.width_on, "f1") + " min" + (x.passed ? "" : " (fails)"); }).join("; ");
      case "Deferral": return Object.keys(v).map(function (k) { return n(k) + " " + fmt(v[k], "pct1"); }).join(", ");
      case "Rare areas": return Object.keys(v).map(function (k) { return n(k) + " " + fmt(v[k], "spct1"); }).join(", ");
      case "Detection": return "precision " + Object.keys(v.precision).map(function (k) { return n(k) + " " + fmt(v.precision[k], "pct1"); }).join(", ") + "; FPR " + Object.keys(v.fpr).map(function (k) { return n(k) + " " + fmt(v.fpr[k], "pct2"); }).join(", ");
      case "Beats control": return "Guard " + fmt(v.guard, "f1") + " vs random removal " + fmt(v.random_removal, "f1") + " min";
      default: return JSON.stringify(v);
    }
  }
  function renderScore() {
    var fin = V.final.scorecard, dev = V.dev.scorecard;
    var names = dev.map(function (r) { return r.criterion; });
    fin.forEach(function (r) { if (names.indexOf(r.criterion) < 0) names.push(r.criterion); });
    function res(r) { return r ? "<td class='l " + (r.passed ? "pass'>pass" : "fail'>fail") + "</td><td class='l wrap'>" + esc(scoreVal(r)) + "</td>" : "<td class='l'>–</td><td class='l wrap muted'>not scored in this block</td>"; }
    $("sc-table").innerHTML = "<tr><th class='l'>Line</th><th class='l'>Pass if</th><th class='l'>Held-out</th><th class='l'>Held-out value</th><th class='l'>Dev</th><th class='l'>Dev value</th></tr>" +
      names.map(function (nm) {
        var f = fin.filter(function (r) { return r.criterion === nm; })[0], d = dev.filter(function (r) { return r.criterion === nm; })[0];
        return "<tr><td class='l'><b>" + esc(nm) + "</b></td><td class='l wrap'>" + esc((f || d).rule) + "</td>" + res(f) + res(d) + "</tr>";
      }).join("");
  }
  function renderFooter() {
    var m = D.manifest, S = D.summary;
    $("ft-data").textContent = m.name + ". " + fmt(m.rows, "int") + " packages from " + fmt(m.couriers, "int") + " couriers, accepted " + m.date_range[0].slice(0, 10) + " to " + m.date_range[1].slice(0, 10) +
      ". Retrieved " + m.retrieved + " from " + m.sources[0] + "; file SHA-256 " + m.sha256.slice(0, 12) + "….";
    $("ft-runs").textContent = fmt(S.runs, "int") + " runs and " + fmt(S.retrains, "int") + " weekly retrains, seeds " + V.cfg.seeds.join(", ") + ". Config hash " + S.config_hash + ", code " + S.git_sha +
      ". " + Object.keys(S.versions).filter(function (k) { return k !== "platform"; }).map(function (k) { return k + " " + S.versions[k]; }).join(", ") + ".";
    $("ft-build").textContent = "Results generated " + (S.generated || "") + ".";
    if (D.text.video) { var v = $("video-link"); v.href = D.text.video; v.hidden = false; }
  }

  // ------------------------------------------------------------ boot
  var resizeT = null;
  function renderCharts() { renderShelf(); renderMatrix(); renderWeekly(); renderTracks(); renderChain(); renderControls(); }
  function fail(e) {
    document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="err">Some site data didn\'t load (' + esc(e.message) + "). Serve the docs folder over HTTP, for example <code>python -m http.server -d docs 8000</code>, then reload.</div>");
    console.error(e);
  }
  initTheme(); initNav();
  // results.json (a copy of results/results.json) is the source of every result; summary.json only adds the build time
  Promise.all(["results", "timeline", "mechanism", "console", "manifest", "modlog", "text", "summary"].map(function (n) {
    return getJSON("data/" + n + ".json").catch(function (e) { if (n === "text" || n === "summary") return {}; throw e; });
  })).then(function (r) {
    D.summary = r[0]; D.timeline = r[1]; D.mechanism = r[2]; D.console = r[3]; D.manifest = r[4]; D.modlog = r[5]; D.text = r[6];
    D.summary.generated = r[7].generated;
    if (typeof d3 === "undefined") throw new Error("the chart library (D3, from cdnjs) didn't load");
    buildV(); bindAll();
    initPoisons(); initSortline();
    initWeekly(); initChain(); initClassifier();
    seg("block", function (v) { mxBlock = v; renderMatrix(); });
    renderCharts(); renderClassifier(); renderFails(); renderScore(); renderFooter();
    window.addEventListener("resize", function () { clearTimeout(resizeT); resizeT = setTimeout(renderCharts, 200); });
    return Promise.all(["off_p50", "off_p80", "on_p50", "on_p80"].map(function (n) { return getJSON("models/" + n + ".json"); }));
  }).then(function (ms) {
    M.off_p50 = ms[0]; M.off_p80 = ms[1]; M.on_p50 = ms[2]; M.on_p80 = ms[3];
    renderSlip(); initWalk();
  }).catch(fail);
})();

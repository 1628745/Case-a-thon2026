/* Data Shelf-Life Guard site. Every number is read from data/*.json and models/*.json. */
(function () {
  "use strict";
  var D = {}, M = {}, V = {};
  var RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var CONDS = ["reference", "stale", "low_quality", "combined", "unseen"];
  var CNAME = { reference: "clean data", stale: "outdated data", low_quality: "sloppy scans", combined: "both at once", unseen: "surprise problem" };
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
    neg1: function (x) { return "−" + Math.abs(x).toFixed(1); },
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
    V = { final: blockView(S.final), dev: blockView(S.dev), cfg: cfg, console: D.console, manifest: D.manifest, headline: S.headline, x: {} };
    var x = V.x, sev = cfg.degrade.low_quality.sloppy_share;
    x.oneIn = "1 in " + Math.round(1 / sev);
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
    x.retrains = S.retrains; x.runs = S.runs;
    x.secsRef = V.final.cells.reference.off.secs;
    var FR = S.final.recovery;
    x.lqSaved = FR.low_quality.degraded - FR.low_quality.guarded;
    x.combSaved = FR.combined.degraded - FR.combined.guarded;
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
    var ids = ["poisons", "built", "analysis"], stops = document.querySelectorAll(".stop"), fillEl = $("route-fill"), van = $("route-van");
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
      p = Math.max(0, Math.min(1, p));
      fillEl.style.width = (100 * p) + "%";
      if (van) van.style.transform = "translateX(" + (p * van.parentNode.clientWidth - van.clientWidth / 2) + "px)";
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
      c.g.append("text").attr("class", "axis-label").attr("x", X(opts.shade[0]) + 4).attr("y", c.h - 6).text("final test");
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
    if (opts.between) {
      var A = series[opts.between[0]], Bs = series[opts.between[1]];
      var ar = d3.area().defined(function (d) { return !bad(d[1]) && !bad(d[2]); }).x(function (d) { return X(d[0]); }).y0(function (d) { return Y(d[1]); }).y1(function (d) { return Y(d[2]); });
      c.g.append("path").attr("class", "fadein").attr("d", ar(A.x.map(function (v, i) { var j = Bs.x.indexOf(v); return [v, A.y[i], j < 0 ? null : Bs.y[j]]; })))
        .style("fill", "var(--tote)").style("opacity", 0.38);
    }
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
  function use(parent, id, x, y, w, h, style) { return mk("use", { href: "#" + id, x: x, y: y, width: w, height: h, style: style || "color: var(--ink)" }, parent); }
  var TB = "font: 600 12px var(--body); fill: var(--ink)";

  var POISON = {
    history: function (svg) {
      var cfg = V.cfg, n = cfg.data.n_weeks, W = 340, cw = W / n, win = cfg.splits.window_weeks, dev = cfg.splits.dev;
      mk("rect", { x: 0, y: 3, width: 10, height: 8, rx: 2, style: "fill: var(--stale)" }, svg);
      mk("text", { x: 15, y: 11, style: TB, text: "outdated: learns from every past week" }, svg);
      mk("rect", { x: 0, y: 17, width: 10, height: 8, rx: 2, style: "fill: var(--ref)" }, svg);
      mk("text", { x: 15, y: 25, style: TB, text: "normal: learns from the last " + win + " weeks" }, svg);
      for (var i = 0; i < n; i++) mk("rect", { x: i * cw + 0.5, y: 60, width: cw - 1, height: 14, rx: 1.5, style: "fill: var(--line)" }, svg);
      [0, 4, 8, 12, 16, 20, 25].forEach(function (w) { mk("text", { x: w * cw + cw / 2, y: 88, "text-anchor": "middle", style: T, text: w }, svg); });
      var sw = mk("rect", { x: 0, y: 34, height: 9, rx: 2, style: "fill: var(--stale)" }, svg);
      var rw = mk("rect", { y: 46, height: 9, rx: 2, style: "fill: var(--ref)" }, svg);
      var tw = mk("rect", { y: 57, width: cw, height: 20, rx: 2, style: "fill: none; stroke: var(--ink); stroke-width: 2" }, svg);
      var tl = mk("text", { y: 106, "text-anchor": "middle", style: TB }, svg);
      function at(t) { // t is fractional, so everything glides instead of stepping a week at a time
        var x = t * cw;
        sw.setAttribute("width", x.toFixed(2));
        rw.setAttribute("x", (Math.max(0, t - win) * cw).toFixed(2)); rw.setAttribute("width", (Math.min(win, t) * cw).toFixed(2));
        tw.setAttribute("x", x.toFixed(2));
        tl.setAttribute("x", (x + cw / 2).toFixed(2)); tl.textContent = "learning for week " + Math.floor(t);
      }
      at(dev[0]);
      return function (done) { tween(5000, function (p) { at(dev[0] + p * (dev[1] + 1 - 1e-6 - dev[0])); }, done); };
    },
    frozen: function (svg) {
      var cfg = V.cfg, d0 = new Date(cfg.data.week0_start + "T00:00:00Z"), fz = new Date(cfg.degrade.stale.freeze_data_through + "T00:00:00Z");
      var nDays = cfg.data.n_weeks * 7, fd = Math.round((fz - d0) / 864e5), W = 340, dx = W / nDays;
      mk("line", { x1: 0, x2: W, y1: 70, y2: 70, style: "stroke: var(--line); stroke-width: 2" }, svg);
      var months = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];
      months.forEach(function (m, i) { var d = Math.round((Date.UTC(2022, 4 + i, 1) - d0) / 864e5); mk("text", { x: d * dx, y: 88, style: T, text: m }, svg); });
      var ticks = mk("g", {}, svg);
      mk("line", { x1: fd * dx, x2: fd * dx, y1: 42, y2: 74, style: "stroke: var(--stale); stroke-width: 2" }, svg);
      mk("text", { x: fd * dx + 4, y: 50, style: "font: 600 12px var(--body); fill: var(--stale)", text: "last update, " + cfg.degrade.stale.freeze_data_through }, svg);
      var cur = mk("circle", { cy: 70, r: 5, style: "fill: var(--ink)" }, svg);
      var age = mk("text", { x: 0, y: 22, style: "font: 800 22px var(--display); fill: var(--ink)" }, svg);
      mk("text", { x: 0, y: 112, style: T, text: "Each tick is a daily update." }, svg);
      var drawn = 0;
      function at(day) {
        while (drawn <= Math.min(day, fd)) { mk("line", { x1: drawn * dx, x2: drawn * dx, y1: 62, y2: 70, style: "stroke: var(--ref); stroke-width: 1" }, ticks); drawn++; }
        cur.setAttribute("cx", day * dx);
        var a = day <= fd ? 1 : day - fd;
        var dt = new Date(d0.getTime() + day * 864e5);
        age.textContent = months[dt.getUTCMonth() - 4] + " " + dt.getUTCDate() + ": stats " + a + (a === 1 ? " day" : " days") + " old";
        age.style.fill = a > 7 ? "var(--stale)" : "var(--ink)";
      }
      return function (done) { ticks.innerHTML = ""; drawn = 0; tween(4500, function (p) { at(Math.round(p * (nDays - 1))); }, done); };
    },
    sloppy: function (svg) {
      var xs = [44, 104, 164, 224, 284], care = ["09:40", "10:55", "12:10", "13:30", "14:45"], late = "18:10";
      var title = mk("text", { x: 0, y: 13, style: "font: 700 13px var(--body); fill: var(--ink)" }, svg);
      xs.forEach(function (x) { use(svg, "i-house", x - 14, 20, 28, 26); });
      use(svg, "i-depot", 306, 18, 34, 28, "color: var(--muted)");
      mk("rect", { x: 0, y: 50, width: 340, height: 14, rx: 3, style: "fill: var(--line)" }, svg);
      mk("line", { x1: 4, x2: 336, y1: 57, y2: 57, style: "stroke: var(--panel); stroke-width: 1.5; stroke-dasharray: 6 6" }, svg);
      mk("text", { x: 0, y: 84, style: T, text: "Recorded delivery time" }, svg);
      var cells = xs.map(function (x) {
        var r = mk("rect", { x: x - 26, y: 90, width: 52, height: 22, rx: 4, style: "fill: var(--floor); stroke: var(--line); stroke-width: 1.5" }, svg);
        var t = mk("text", { x: x, y: 105.5, "text-anchor": "middle", style: "font: 700 12px var(--body); fill: var(--muted)", text: "–" }, svg);
        return { r: r, t: t };
      });
      var copies = mk("g", {}, svg);
      var car = use(svg, "i-car", 0, 0, 44, 21);
      var cap1 = mk("text", { x: 0, y: 136, style: "font: 600 12px var(--body); fill: var(--ink)" }, svg);
      var cap2 = mk("text", { x: 0, y: 153, style: "font: 12px var(--body); fill: var(--muted)" }, svg);
      function ride(x) { car.setAttribute("transform", "translate(" + (x - 22) + ",36)"); }
      function stamp(i, txt, color) { cells[i].t.textContent = txt; cells[i].t.style.fill = color; cells[i].r.style.stroke = color; }
      function reset(label) {
        title.textContent = label; copies.innerHTML = ""; cap1.textContent = ""; cap2.textContent = "";
        cells.forEach(function (c, i) { stamp(i, "–", "var(--muted)"); c.r.style.stroke = "var(--line)"; });
        ride(-20);
      }
      function drive(careful, done) {
        var i = 0;
        (function next() {
          if (i >= xs.length) { tween(600, function (p) { ride(xs[4] + (326 - xs[4]) * ease(p)); }, done); return; }
          var from = i === 0 ? -20 : xs[i - 1], to = xs[i];
          tween(560, function (p) { ride(from + (to - from) * ease(p)); }, function () {
            if (careful) stamp(i, care[i], "var(--ref)"); else stamp(i, "not yet", "var(--muted)");
            i++; setTimeout(next, 170);
          });
        })();
      }
      function endOfShift() {
        xs.forEach(function (x, i) { stamp(i, late, "var(--lq)"); });
        cap1.textContent = "Every record says " + late + ", the end of the shift.";
        cap2.textContent = "To the model, each delivery looks hours slower.";
      }
      return function (done) {
        if (RM) { reset("Sloppy courier: scans it all at the end of the shift"); ride(326); endOfShift(); if (done) done(); return; }
        reset("Careful courier: scans at each door");
        drive(true, function () {
          cap1.textContent = "Five deliveries, five real times.";
          setTimeout(function () {
            reset("Sloppy courier: scans nothing until the end of the shift");
            drive(false, function () { endOfShift(); if (done) done(); });
          }, 1400);
        });
      };
    }
  };
  function initPoisons() {
    document.querySelectorAll(".mini[data-anim]").forEach(function (el) {
      var street = el.classList.contains("street");
      var svg = mk("svg", { viewBox: street ? "0 0 340 160" : "0 0 340 120", "aria-hidden": "true", preserveAspectRatio: "xMinYMid meet" });
      el.appendChild(svg);
      var play = POISON[el.getAttribute("data-anim")](svg, el), busy = false;
      function run() { if (busy) return; busy = true; play(function () { busy = false; }); }
      if (RM) { play(); return; }
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "ghost replay"; btn.textContent = "Replay";
      btn.setAttribute("aria-label", "Replay animation");
      btn.addEventListener("click", run);
      var stub = el.closest(".label") && el.closest(".label").querySelector(".label-stub");
      if (stub) { btn.classList.add("in-stub"); stub.appendChild(btn); } else el.appendChild(btn);
      onView(el, run, "0px 0px -25% 0px");
    });
  }
  function renderShelf() {
    var sl = D.summary.shelf_life, order = ["1", "2", "4", "8", "16", "all"];
    var cat = order.map(function (w) { return w === "all" ? "all" : w + " wk"; });
    var series = ["reference", "low_quality"].map(function (c) {
      return { name: CNAME[c], color: CVAR[c], x: cat, y: order.map(function (w) { var r = sl.filter(function (s) { return s.condition === c && s.window_weeks === w; })[0]; return r ? r.mae : null; }) };
    });
    lineChart($("ch-shelf"), series, { cat: cat, yLabel: "average error (min per package)", xLabel: "weeks of history the model learns from", yFmt: "f0", tipFmt: "f1", dots: true, endLabels: true, tipX: "window ", margin: { r: 90 } });
  }

  function initRoads() {
    var hr = $("hero-road");
    function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
    if (hr) {
      var svg = mk("svg", { viewBox: "0 0 1200 70", preserveAspectRatio: "xMidYMid meet" }, hr);
      mk("rect", { x: 30, y: 50, width: 1140, height: 12, rx: 6, style: "fill: var(--line)" }, svg);
      mk("line", { x1: 44, x2: 1156, y1: 56, y2: 56, style: "stroke: var(--floor); stroke-width: 2; stroke-dasharray: 14 12" }, svg);
      use(svg, "i-depot", 0, 18, 46, 35, "color: var(--muted)");
      use(svg, "i-house", 1152, 20, 38, 35);
      var pin = mk("g", { transform: "translate(1171,10)" }, svg);
      var tag = mk("g", { class: "pop" }, pin);
      mk("rect", { x: -40, y: -9, width: 80, height: 20, rx: 10, style: "fill: var(--pass)" }, tag);
      mk("text", { x: 0, y: 5, "text-anchor": "middle", style: "font: 700 12px var(--body); fill: var(--floor)", text: "Delivered" }, tag);
      var van = use(svg, "i-van", 0, 0, 58, 31);
      var x0 = 52, x1 = 1088;
      function at(x) { van.setAttribute("transform", "translate(" + x + ",24)"); }
      if (RM) { at(x1); tag.classList.add("in"); }
      else { at(x0); onView(hr, function () { tween(2800, function (p) { at(x0 + (x1 - x0) * easeOut(p)); }, function () { tag.classList.add("in"); }); }); }
    }
    document.querySelectorAll(".lane").forEach(function (el) {
      var V_ = { van: [54, 29], truck: [58, 29], pickup: [54, 26], car: [50, 24] }, kind = el.getAttribute("data-lane"), dim = V_[kind] || V_.van;
      var svg = mk("svg", { viewBox: "0 0 600 46" }, el);
      mk("rect", { x: 0, y: 38, width: 560, height: 6, rx: 3, style: "fill: var(--line)" }, svg);
      mk("circle", { cx: 580, cy: 26, r: 15, style: "fill: var(--tote)" }, svg);
      mk("text", { x: 580, y: 32, "text-anchor": "middle", style: "font: 800 17px var(--display); fill: #1B2B3A", text: el.getAttribute("data-n") }, svg);
      var w = dim[0], h = dim[1], y = 41 - h, x0 = -w, x1 = 552 - w;
      var v = use(svg, "i-" + kind, 0, 0, w, h);
      function at(x) { v.setAttribute("transform", "translate(" + x + "," + y + ")"); }
      if (RM) { at(x1); return; }
      at(x0);
      onView(el, function () { tween(1600, function (p) { at(x0 + (x1 - x0) * easeOut(p)); }); }, "0px 0px -20% 0px");
    });
  }

  function initDeco() {
    document.querySelectorAll(".deco").forEach(function (d) {
      if (RM) return;
      d.classList.add("wait");
      onView(d, function () { setTimeout(function () { d.classList.remove("wait"); d.classList.add("play"); }, 300); });
    });
    // Part 2 map: the van follows the route path, turning with the road; the trail fills in behind it
    var trail = $("rm-trail"), van = $("rm-van"), done = $("rm-done");
    if (!trail || !van) return;
    var L = trail.getTotalLength();
    trail.style.strokeDasharray = L + " " + L;
    function at(f) {
      var l = f * L, p = trail.getPointAtLength(l), q = trail.getPointAtLength(Math.min(L, l + 1)), r = trail.getPointAtLength(Math.max(0, l - 1));
      var ang = Math.atan2(q.y - r.y, q.x - r.x) * 180 / Math.PI;
      van.setAttribute("transform", "translate(" + p.x.toFixed(1) + "," + p.y.toFixed(1) + ") rotate(" + ang.toFixed(1) + ")");
      trail.style.strokeDashoffset = (L - l).toFixed(1);
    }
    if (RM) { at(1); done.classList.add("in"); return; }
    at(0);
    onView(van.ownerSVGElement.parentNode, function () {
      setTimeout(function () {
        tween(4200, function (p) { at(p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2); }, function () { done.classList.add("in"); });
      }, 350);
    });
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
    mk("text", { x: 444, y: 314, class: "sl-note", text: "dispatcher decisions go to the data team and update who is trusted" }, svg);
    var layer = mk("g", {}, svg);
    function station(x, y, w, h, t, s, guard) {
      var g = mk("g", { class: "sl-st" + (guard ? " guard" : "") }, svg);
      mk("rect", { x: x, y: y, width: w, height: h, rx: 8 }, g);
      mk("text", { x: x + w / 2, y: y + h / 2 - (s ? 3 : -5), "text-anchor": "middle", text: t }, g);
      if (s) mk("text", { x: x + w / 2, y: y + h / 2 + 15, "text-anchor": "middle", class: "s", text: s }, g);
      return g;
    }
    station(14, Y1 - 32, 106, 64, "Delivery data", "scans and uploads");
    station(14, Y2 - 32, 106, 64, "New package", "at pickup");
    station(L1X - 64, Y1 - 40, 128, 80, "1  Door check", "flag suspicious", true);
    station(L2X - 64, Y1 - 40, 128, 80, "2  Trust", "weigh sources", true);
    var model = station(MX0, Y1 - 40, MX1 - MX0, Y2 - Y1 + 80, "Weekly relearning", "the prediction model");
    station(L3X - 62, Y2 - 34, 124, 68, "3  Final check", "before promising", true);
    station(930, 140, 66, 56, "Promise", "sent");
    station(930, 262, 66, 56, "Person", "decides");
    mk("text", { x: 130, y: Y1 - 52, class: "sl-lane", text: "Every week: the model relearns from recent records" }, svg);
    mk("text", { x: 130, y: Y2 - 50, class: "sl-lane", text: "Every package: a promise to the customer" }, svg);
    mk("text", { x: L1X, y: Y1 + 62, "text-anchor": "middle", class: "sl-note", text: "suspicious ones count " + fmt(qw, "pct0") }, svg);
    mk("text", { x: L2X, y: Y1 + 62, "text-anchor": "middle", class: "sl-note", text: "recent, trusted ones count more" }, svg);
    var toks = [], acc1 = 0, acc2 = 0, spawn1 = 0, spawn2 = 0, last = null, running = false, paused = false, inView = false, pulse = 0;
    var modelRect = model.querySelector("rect");
    function addTok(lane) {
      var g = mk("g", { class: "tok" }, layer);
      var t = { lane: lane, x: 120, y: lane === 1 ? Y1 : Y2, el: g, body: mk("rect", { x: -7, y: -5.5, width: 14, height: 11, rx: 2 }, g) };
      mk("path", { d: "M0 -5.5V5.5M-7 -1.5h14", class: "tape" }, g);
      if (lane === 1) { acc1 += injRate; t.bad = acc1 >= 1; if (t.bad) acc1 -= 1; t.body.style.fill = t.bad ? "var(--lq)" : "var(--ref)"; }
      else { acc2 += defRate; t.defer = acc2 >= 1; if (t.defer) acc2 -= 1; t.body.style.fill = "var(--ink)"; }
      toks.push(t);
      return t;
    }
    function draw(t) {
      var s = t.s === undefined ? 1 : t.s;
      t.el.setAttribute("transform", "translate(" + t.x.toFixed(1) + "," + t.y.toFixed(1) + ") scale(" + s + ")");
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
          if (t.bad && t.x > L1X) { t.s = 0.45; t.body.style.fill = "transparent"; t.body.style.stroke = "var(--lq)"; t.body.style.strokeWidth = 3; }
          if (t.x > L2X && t.bad) t.o = 0.55;
          if (t.x > MX0 + 6) { t.dead = true; pulse = 1; }
        } else {
          if (t.x > MX0 + 6 && t.x < MX1) { t.o = 0; }
          if (t.x >= MX1) { t.o = 1; t.body.style.fill = t.defer ? "var(--tote)" : "var(--ref)"; }
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
      { id: "age", name: "Age of courier and area stats", val: sc.meta.hist_age_days + (sc.meta.hist_age_days === 1 ? " day" : " days"), lim: dh === null ? "never (alerts the data team instead)" : "> " + dh + " days", fired: dh !== null && sc.meta.hist_age_days > dh && !nullingOn },
      { id: "gps", name: "GPS signal age", val: fmt(sc.meta.gps_age_min, "f1") + " min", lim: "> " + g.l3.defer_gps_age_min + " min", fired: sc.meta.gps_age_min > g.l3.defer_gps_age_min },
      { id: "area", name: "Recent deliveries in this area", val: fmt(sc.meta.area_rows, "int"), lim: "< " + g.l3.defer_min_area_rows, fired: sc.meta.area_rows < g.l3.defer_min_area_rows },
      { id: "width", name: "How unsure the model is (promise minus likely time)", val: fmt(width, "f0") + " min", lim: "> " + g.l3.defer_width_k + " × " + fmt(wref, "f0") + " min", fired: width > g.l3.defer_width_k * wref }
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
    $("slip-pkg").textContent = "Picked up at " + clock(md, 0) + ". The courier's trust score is " + fmt(sc.meta.reputation, "f2") + " out of 1.";
    $("slip-off").innerHTML = esc(hm(a.p80)) + "<small>arrives by " + esc(clock(md, a.p80)) + "</small>";
    $("slip-on").innerHTML = esc(hm(b.p80)) + "<small>arrives by " + esc(clock(md, b.p80)) + "</small>";
    $("slip-diff").textContent = hm(a.p80 - b.p80);
  }

  var caseOpened = 0, actions = [], curModelMs = null;
  function scenario() { return D.console.scenarios[+$("sc-pick").value || 0]; }
  function initWalk() {
    var C = D.console, pick = $("sc-pick");
    var NAMES = { normal: "A normal package", stale: "Stats out of date", sloppy: "A sloppy courier", rare: "A brand-new area", golden: "Golden Week rush" };
    fill(pick, C.scenarios.map(function (s, i) { return [i, s.id === "stale" ? "Stats " + s.meta.hist_age_days + " days out of date" : NAMES[s.id] || s.name]; }));
    var first = 0;
    for (var i = 0; i < C.scenarios.length; i++) if (guardOn(C.scenarios[i]).defer) { first = i; break; }
    pick.value = first;
    pick.addEventListener("change", renderWalk);
    function act(kind) {
      var sc = scenario(), b = guardOn(sc), secs = (performance.now() - caseOpened) / 1000;
      var rec = { kind: kind, sc: $("sc-pick").options[$("sc-pick").selectedIndex].text, model: Math.round(b.p80), secs: secs, note: $("act-note").value.trim(), state: b.defer ? "flagged by the Guard" : "sent automatically" };
      if (kind === "Changed") rec.to = +$("act-min").value;
      actions.unshift(rec);
      $("ef-human").textContent = secs.toFixed(1) + " s";
      $("act-log").innerHTML = actions.map(function (r) {
        return "<div><b>" + esc(r.kind) + "</b>: " + esc(r.sc) + " (" + r.state + "), system promise " + r.model + " min" +
          (r.to !== undefined ? ", changed to " + r.to + " min" : "") +
          (r.note ? ". Note: " + esc(r.note) : "") + ". Your time " + r.secs.toFixed(1) + " s.</div>";
      }).join("");
      $("act-note").value = "";
      caseOpened = performance.now();
    }
    $("act-approve").addEventListener("click", function () { act("Approved"); });
    $("act-correct").addEventListener("click", function () { act("Changed"); });
    $("act-escalate").addEventListener("click", function () { act("Sent to the data team"); });
    renderWalk();
  }
  function renderWalk() {
    var sc = scenario(), C = D.console, g = C.guard, a = guardOff(sc), b = guardOn(sc), md = sc.inputs_off.minute_of_day;
    caseOpened = performance.now();
    $("sc-desc").textContent = sc.description;
    $("w-promise").innerHTML =
      "<div class='pr on'><span class='k'>With the Guard</span><span class='big'>" + esc(hm(b.p80)) + "</span><span class='s'>arrives by " + esc(clock(md, b.p80)) + " (picked up " + esc(clock(md, 0)) + ")</span></div>" +
      "<div class='pr off'><span class='k'>Without the Guard</span><span class='mid'>" + esc(hm(a.p80)) + "</span><span class='s'>arrives by " + esc(clock(md, a.p80)) + "</span></div>";
    promiseTimeline(a, b);
    var reasons = b.rules.filter(function (r) { return r.fired; });
    $("w-decision").innerHTML = b.defer
      ? "<div class='verdict defer'>Not sent automatically. A dispatcher decides.</div>"
      : "<div class='verdict ok'>Sent to the customer automatically.</div>";
    var rep = sc.meta.reputation, age = sc.meta.hist_age_days;
    var area = b.rules.filter(function (r) { return r.id === "area"; })[0], wid = b.rules.filter(function (r) { return r.id === "width"; })[0];
    var items = [
      { ok: !area.fired, t: area.fired ? "No recent deliveries in this area" : "The area is familiar", v: fmt(sc.meta.area_rows, "int") + " deliveries here in the last " + V.cfg.splits.window_weeks + " weeks" },
      { ok: !wid.fired, t: wid.fired ? "The model is unusually unsure" : "The model is reasonably sure", v: "promise is " + fmt(b.width, "f0") + " min past the likely time; limit " + g.l3.defer_width_k + " × " + fmt(b.wref, "f0") + " min" },
      { ok: rep >= 0.5, t: rep >= 0.5 ? "The courier's records are trustworthy" : "The courier's records look sloppy", v: "trust score " + fmt(rep, "f2") + " out of 1" + (rep < 0.5 ? ": counted less when the model learns" : "") },
      { ok: rep >= 0.5, t: "Courier's average delivery time", v: fmt(sc.inputs_off.courier_hist_mean, "f0") + " min as recorded → " + fmt(sc.inputs_on.courier_hist_mean, "f0") + " min after the Guard set suspicious records aside", neutral: rep >= 0.5 }
    ];
    if (age > 7) items.push({ ok: true, warn: true, t: "Stats are " + age + " days old", v: "still used, because old stats stayed useful; the data team is alerted" });
    $("w-reasons").innerHTML = items.map(function (r) {
      var cls = r.warn ? "warn" : r.neutral ? "neutral" : r.ok ? "ok" : "no";
      var mark = r.warn ? "!" : r.neutral ? "i" : r.ok ? "✓" : "✕";
      return "<li class='" + cls + "'><span class='mark' aria-hidden='true'>" + mark + "</span><span><b>" + esc(r.t) + "</b><br><span class='v'>" + esc(r.v) + "</span></span></li>";
    }).join("");
    var raw = Object.assign({}, sc.inputs_on, { courier_hist_mean: sc.inputs_off.courier_hist_mean, area_hist_mean: sc.inputs_off.area_hist_mean, open_workload: sc.inputs_off.open_workload });
    var wi = guardOn(sc, raw), ex;
    if (area.fired) ex = "The model has nothing recent to go on for this area, so rather than guess, the Guard asks a person.";
    else if (wid.fired) ex = "The model is too unsure about this package to promise on its own.";
    else if (rep < 0.5) ex = "The Guard ignores this courier's inflated records. Fed the raw records, the same model would promise " + hm(wi.p80) + " instead of " + hm(b.p80) + ".";
    else if (age > 7) ex = "Old stats, but still reliable, so the promise goes out and the data team gets a heads-up.";
    else ex = "Nothing unusual, so the promise goes out automatically.";
    $("w-explain").innerHTML = "<p><b>In short:</b> " + esc(ex) + "</p>";
    if (document.activeElement !== $("act-min")) $("act-min").value = Math.round(b.p80);
    curModelMs = b.ms;
    $("ef-model").textContent = (b.ms < 0.1 ? b.ms.toFixed(3) : b.ms.toFixed(2)) + " ms";
    $("ef-human").textContent = "starts now";
    renderScale();
  }

  function promiseTimeline(a, b) {
    var W = 300, mx = Math.max(a.p80, b.p80) * 1.1, step = mx > 720 ? 120 : 60;
    function X(m) { return 16 + (W - 32) * m / mx; }
    var lanes = [[b.p80, 26, "var(--tote)", "with the Guard"], [a.p80, 60, "var(--lq)", "without"]];
    var g = "<svg class='ptl' viewBox='0 0 300 96' role='img' aria-label='Promise length: with the Guard " + esc(hm(b.p80)) + ", without " + esc(hm(a.p80)) + "'>";
    for (var m = 0; m <= mx; m += step) g += "<text x='" + X(m).toFixed(1) + "' y='92' text-anchor='middle' class='ptl-t'>" + (m / 60) + " h</text>";
    g += "<line x1='16' x2='284' y1='80' y2='80' class='ptl-ax'/>";
    lanes.forEach(function (l) {
      g += "<rect class='ptl-road' x='16' y='" + (l[1] + 2) + "' height='6' rx='3' width='" + (X(l[0]) - 16).toFixed(1) + "' style='fill:" + l[2] + "'/>" +
        "<use href='#i-van' class='ptl-van' width='34' height='18' x='0' y='" + (l[1] - 14) + "' data-x='" + (X(l[0]) - 34).toFixed(1) + "'/>" +
        "<text class='ptl-l' x='" + Math.max(52, X(l[0]) - 38).toFixed(1) + "' y='" + (l[1] - 2) + "' text-anchor='end'>" + esc(l[3]) + "</text>";
    });
    $("w-promise").insertAdjacentHTML("beforeend", g + "</svg>");
    var vans = $("w-promise").querySelectorAll(".ptl-van"), roads = $("w-promise").querySelectorAll(".ptl-road");
    vans.forEach(function (v) { v.style.transform = "translate(" + (RM ? v.getAttribute("data-x") : 16) + "px,0px)"; });
    if (RM) return;
    roads.forEach(function (r) { r.style.transform = "scaleX(0)"; });
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      vans.forEach(function (v) { v.classList.add("go"); v.style.transform = "translate(" + v.getAttribute("data-x") + "px,0px)"; });
      roads.forEach(function (r) { r.classList.add("go"); r.style.transform = "scaleX(1)"; });
    }); });
  }
  function renderScale() {
    var on = V.final.cells.combined.on, tl = track("reference", false), h0 = V.cfg.splits.heldout[0];
    var wk = tl.week.map(function (w, i) { return [w, tl.n_test[i]]; }).filter(function (p) { return p[0] >= h0; });
    var perDay = wk.reduce(function (s, p) { return s + p[1]; }, 0) / wk.length / 7, rs = D.console.review_seconds;
    var defDay = on.defer * perDay, hrs = defDay * rs / 3600;
    $("ef-scale").innerHTML = "<p><b>At city scale:</b> about " + fmt(perDay, "int") + " packages a day in the test weeks. With both data problems present, the Guard hands " + fmt(on.defer, "pct1") +
      " of them, about " + fmt(defDay, "int") + " a day, to a person. At " + rs + " seconds each, that's " + fmt(hrs, "f1") + " hours of review a day. The computer needs " + (curModelMs === null ? "–" : curModelMs.toFixed(2)) +
      " ms per package and " + fmt(on.secs, "f0") + " seconds for each weekly update. A one-district pilot would carry a fraction of that.</p>";
  }

  // ------------------------------------------------------------ 3 matrix
  function renderMatrix() {
    var B = V.final, ref = B.cells.reference.off.mae;
    var conds = ["reference", "stale", "low_quality", "combined"];
    function cellHtml(x) {
      var gap = x.mae - ref;
      return "<span class='m'>" + fmt(x.mae, "f1") + "</span><span class='gap'>" + (Math.abs(gap) < 0.005 ? "the baseline" : fmt(gap, "sgn1") + " min vs clean") + "</span>";
    }
    $("mx-table").innerHTML = "<caption class='sr'>Average error by problem, with and without the Guard, final test</caption>" +
      "<tr><th class='l'>Problem</th><th>Without the Guard<br>avg error (min)</th><th>With the Guard<br>avg error (min)</th><th>Error cut per package</th><th>Extra error<br>removed</th><th>Handed to<br>a person</th></tr>" +
      conds.map(function (c) {
        var o = B.cells[c].off, n = B.cells[c].on, r = B.recovery[c], saved = o.mae - n.mae;
        var cut = c === "reference" ? "<span class='sp'>" + fmt(-saved, "sgn1") + " min (cost)</span>" : "<span class='rec'>" + fmt(saved, "neg1") + " min</span>";
        var rec = c === "reference" ? "<span class='sp'>" + fmt(n.mae / o.mae - 1, "spct2") + "</span>" : "<span class='rec'>" + fmt(r && r.recovery, "pct0") + "</span>";
        return "<tr><td class='l'><span class='cname' style='--c:" + CVAR[c] + "'><i></i>" + esc(CNAME[c]) + "</span></td><td>" + cellHtml(o) + "</td><td>" + cellHtml(n) + "</td><td>" + cut + "</td><td>" + rec +
          "</td><td>" + fmt(n.defer, "pct1") + "</td></tr>";
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
    c.g.append("text").attr("class", "direct").attr("x", X(ref)).attr("y", -12).attr("text-anchor", "middle").style("fill", "var(--ref)").text("clean data: " + fmt(ref, "f1") + " min");
    xLabel(c, "average error per package (min)");
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
  function renderWeekly() {
    var refOff = D.timeline.cells.filter(function (c) { return c.condition === "reference" && !c.guard; })[0];
    var h0 = V.cfg.splits.heldout[0], h1 = V.cfg.splits.heldout[1], FR = V.final.recovery;
    var marks = D.timeline.markers.filter(function (m) { return m.week !== V.cfg.degrade.unseen.start_week; });
    function panel(cond, id, head) {
      var off = D.timeline.cells.filter(function (c) { return c.condition === cond && !c.guard; })[0];
      var on = D.timeline.cells.filter(function (c) { return c.condition === cond && c.guard; })[0];
      function gap(c) { return c.week.map(function (w, i) { var j = refOff.week.indexOf(w); return j < 0 ? null : c.mae_min.mean[i] - refOff.mae_min.mean[j]; }); }
      var series = [{ name: "without the Guard", color: CVAR[cond], x: off.week, y: gap(off), w: 2.6 }, { name: "with the Guard", color: "var(--tote-ink)", dash: true, x: on.week, y: gap(on), w: 2.6 }];
      lineChart($(id), series, { xDomain: [V.cfg.splits.dev[0], h1], shade: [h0 - 0.5, h1 + 0.5], zero: true, between: [0, 1], yLabel: "extra error vs clean data (min per package)",
        xLabel: "week", yFmt: "sgn1", tipFmt: "sgn1", markers: marks.map(function (m) { return { x: m.week - 0.5 }; }), aria: head, margin: { r: 20 } });
      var r = FR[cond];
      return "<b>" + esc(CNAME[cond].charAt(0).toUpperCase() + CNAME[cond].slice(1)) + ":</b> in the final test the extra error drops from " + fmt(r.degraded - r.reference, "sgn1") + " to " + fmt(r.guarded - r.reference, "sgn1") + " min per package.";
    }
    $("wk-lq-h").innerHTML = panel("low_quality", "ch-wk-lq", "Sloppy scans: extra error by week");
    $("wk-comb-h").innerHTML = panel("combined", "ch-wk-comb", "Both at once: extra error by week");
    var PLAIN = { 4: "sloppy scanning begins", 8: "stats stop updating", 10: "duplicate uploads begin", 22: "final test weeks begin, including Golden Week" };
    legend($("lg-weekly"), [{ name: "without the Guard", color: "var(--lq)" }, { name: "with the Guard", color: "var(--tote-ink)", dash: true }]);
    $("lg-weekly").insertAdjacentHTML("beforeend", "<span><svg width='26' height='12' aria-hidden='true'><rect width='26' height='12' rx='2' style='fill:var(--tote);opacity:.38'/></svg>error removed by the Guard</span><span class='note'>Dotted lines: " +
      esc(marks.map(function (m) { return "week " + m.week + ": " + (PLAIN[m.week] || m.label); }).join("; ")) + ".</span>");
  }

  // ------------------------------------------------------------ 3 chain
  function chainFor(c, g) { return D.mechanism.chain.filter(function (x) { return x.condition === c && x.guard === g; })[0]; }
  function renderChain() {
    var c = "low_quality", off = chainFor(c, false), on = chainFor(c, true), ref = chainFor("reference", false), col = CVAR[c];
    var small = { margin: { l: 44, t: 12, b: 26 } };
    function two(id, key, f) {
      var s = [{ name: "Guard off", color: col, x: off.week, y: off[key] }];
      if (on) s.push({ name: "Guard on", color: col, dash: true, x: on.week, y: on[key] });
      lineChart($(id), s, Object.assign({ yFmt: f, tipFmt: f === "pct0" ? "pct1" : f === "f3" ? "f2" : "f1", zero: true }, small));
    }
    two("cn-data", "injected_share_train", "pct0");
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
      { k: "Do nothing", v: lqOff - ref, color: "var(--lq)" },
      { k: "Delete records at random", v: ctl.random.mae - ref, color: "var(--muted)" },
      { k: "Delete exactly the bad ones", v: ctl.oracle.mae - ref, color: "var(--ref)" },
      { k: "The Guard", v: bc.value.guard - ref, color: "var(--tote)" }
    ];
    rows.forEach(function (r) { r.label = fmt(r.v, "sgn1") + " min"; });
    hbars($("ch-ctrl"), rows, { left: 180, xLabel: "extra minutes of error per package", aria: "Extra error from sloppy scans under each fix" });
    var dose = S.dose, sv = [];
    [false, true].forEach(function (g) {
      var a = dose.filter(function (d) { return d.guard === g; }).sort(function (p, q) { return p.severity - q.severity; });
      sv.push({ name: g ? "with the Guard" : "without", color: g ? "var(--tote-ink)" : "var(--lq)", dash: g, x: a.map(function (d) { return d.severity; }), y: a.map(function (d) { return d.mae; }) });
    });
    lineChart($("ch-dose"), sv, { yLabel: "average error (min per package)", xLabel: "share of couriers scanning sloppily", xFmt: "pct0", yFmt: "f0", tipFmt: "f1", dots: true, endLabels: true, tipX: "", margin: { r: 110 } });
  }

  // ------------------------------------------------------------ 3 classifier
  function renderClassifier() {
    var DT = V.final.detector, d = { tp: 0, fp: 0, fn: 0, tn: 0 };
    ["low_quality", "combined"].forEach(function (k) { ["tp", "fp", "fn", "tn"].forEach(function (q) { d[q] += DT[k][q]; }); });
    d.precision = d.tp / (d.tp + d.fp); d.recall = d.tp / (d.tp + d.fn); d.fpr = d.fp / (d.fp + d.tn);
    var span = V.cfg.splits.heldout, nW = span[1] - span[0] + 1, nS = V.cfg.seeds.length;
    $("cl-unit").textContent = "One check of one training record in one weekly update. A record is checked again in every window it falls in (up to " + V.cfg.splits.window_weeks +
      " times; combined runs train on all past weeks, so more), summed over " + nW * nS + " updates per condition (" + nW + " weeks × " + nS + " seeds).";
    var pos = d.tp + d.fn, neg = d.fp + d.tn;
    function cl(v, of, label, cc) {
      return "<div class='c' style='--cc:" + cc + "'><div class='fill' style='height:" + (100 * v / of).toFixed(1) + "%'></div><b>" + fmt(v, "int") + "</b><span>" + label + "</span></div>";
    }
    $("cl-matrix").innerHTML = "<div></div><div class='h'>Really bad</div><div class='h'>Really fine</div>" +
      "<div class='rh'>Flagged</div>" + cl(d.tp, pos, "bad, caught", "var(--pass)") + cl(d.fp, neg, "fine, flagged by mistake", "var(--fail)") +
      "<div class='rh'>Passed</div>" + cl(d.fn, pos, "bad, missed", "var(--fail)") + cl(d.tn, neg, "fine, passed", "var(--pass)");
    function p(v) { return fmt(v, v < 0.01 ? "pct2" : "pct1"); }
    function rate(v, name, tech) { return "<div><b>" + p(v) + "</b><span>" + name + "<br><i>" + tech + "</i></span></div>"; }
    $("cl-rates").innerHTML = rate(d.precision, "of flagged records really were bad", "precision") + rate(d.recall, "of bad records got caught", "recall") + rate(d.fpr, "of good records flagged by mistake", "false-positive rate");
    $("cl-plain").textContent = p(d.precision) + " of the records it flagged really were bad. It caught " + p(d.recall) + " of the bad ones, and wrongly flagged only " + p(d.fpr) + " of the good ones.";
  }

  // ------------------------------------------------------------ 3 failures, scorecard, footer
  function renderFails() {
    var on = V.final.cells.combined.on, off = V.final.cells.combined.off, r = V.final.cells.reference;
    var items = [
      "People: " + fmt(V.x.deferMin, "pct1") + "–" + fmt(V.x.deferMax, "pct1") + " of packages need a dispatcher's decision.",
      "Less data to learn from: with both problems present, the Guard turns down the weight of " + fmt(on.downweighted, "pct0") + " of records.",
      "Slower weekly updates: " + fmt(on.secs, "f0") + " s instead of " + fmt(off.secs, "f0") + " s.",
      "On clean data: " + fmt(r.on.mae - r.off.mae, "sgn1") + " min of error per package (" + fmt(V.x.noHarm, "spct2") + ").",
      "Slightly longer promises on clean data, " + fmt(V.x.wRefFinal, "spct1") + " (" + fmt(r.off.width, "f0") + " → " + fmt(r.on.width, "f0") + " min), to stay on time about " + fmt(V.cfg.guard.l3.target_coverage, "pct0") + " of the time."
    ];
    $("fl-trade").innerHTML = items.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("");
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
  function renderCharts() { renderShelf(); renderMatrix(); renderWeekly(); renderChain(); renderControls(); renderClassifier(); }
  function fail(e) {
    document.querySelector("main").insertAdjacentHTML("afterbegin", '<div class="err">Some site data didn\'t load (' + esc(e.message) + "). Serve the docs folder over HTTP, for example <code>python -m http.server -d docs 8000</code>, then reload.</div>");
    console.error(e);
  }
  function initKeys() {
    var map = { "0": "top", "1": "poisons", "2": "built", "3": "analysis", "4": "walk" };
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target || {}).tagName || "")) return;
      if (e.key === "5") { window.location.href = "lab.html"; return; }
      var id = map[e.key];
      if (!id) return;
      e.preventDefault();
      var el = $(id);
      el.scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "start" });
      if (id !== "top") { el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }
    });
  }
  initTheme(); initNav(); initKeys(); initRoads(); initDeco();
  // results.json (a copy of results/results.json) is the source of every result; summary.json only adds the build time
  Promise.all(["results", "timeline", "mechanism", "console", "manifest", "modlog", "text", "summary"].map(function (n) {
    return getJSON("data/" + n + ".json").catch(function (e) { if (n === "text" || n === "summary") return {}; throw e; });
  })).then(function (r) {
    D.summary = r[0]; D.timeline = r[1]; D.mechanism = r[2]; D.console = r[3]; D.manifest = r[4]; D.modlog = r[5]; D.text = r[6];
    D.summary.generated = r[7].generated;
    if (typeof d3 === "undefined") throw new Error("the chart library (D3, from cdnjs) didn't load");
    buildV(); bindAll();
    initPoisons(); initSortline();
    renderCharts(); renderClassifier(); renderFails(); renderFooter();
    window.addEventListener("resize", function () { clearTimeout(resizeT); resizeT = setTimeout(renderCharts, 200); });
    return Promise.all(["off_p50", "off_p80", "on_p50", "on_p80"].map(function (n) { return getJSON("models/" + n + ".json"); }));
  }).then(function (ms) {
    M.off_p50 = ms[0]; M.off_p80 = ms[1]; M.on_p50 = ms[2]; M.on_p80 = ms[3];
    renderSlip(); initWalk();
  }).catch(fail);
})();

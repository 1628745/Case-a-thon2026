/* Lab page: UI, worker messaging, charts (D3 7.9.0, as on index.html) and in-browser downloads.
   All compute happens in lab-worker.js (Pyodide). No data leaves the browser. */
(function () {
  "use strict";
  var RM = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var PRESET_MECHS = { clean: [], sloppy: ["bulk", "dup"], stale: ["stale"], sloppy_stale: ["bulk", "dup", "stale"], unseen: ["early"] };
  var PRESET_NAME = { clean: "Clean as uploaded", sloppy: "Sloppy couriers", stale: "Stale feature store", sloppy_stale: "Sloppy + stale", unseen: "Unseen: early scans 15%", custom: "Custom mix" };
  var RUN_COLOR = { reference: "var(--ref)", degraded_off: "var(--lq)", degraded_on: "var(--tote)", clean_off: "var(--ref)", clean_on: "var(--tote)" };
  var RUN_SHORT = { reference: "Reference", degraded_off: "Poisoned, Guard off", degraded_on: "Poisoned, Guard on", clean_off: "Guard off", clean_on: "Guard on" };
  var FEAT = { hour: "Hour accepted", minute_of_day: "Minute of day", dow: "Weekday", region_id: "Region id", aoi_id: "Area id",
    aoi_type: "Area type", lng: "Stop longitude", lat: "Stop latitude", dist_km: "Courier to stop (km)", open_workload: "Open packages",
    courier_hist_mean: "Courier 14-day mean (min)", area_hist_mean: "Area 14-day mean (min)" };
  var REASON = { hist: "history features too old", gps: "courier GPS fix older than 30 minutes", area: "area not seen in the training weeks", width: "promise more than 4x the usual width for this area type" };
  var S = { worker: null, ready: false, readyP: null, versions: null, file: null, audit: null, hasFile: false, pending: null,
    preset: "sloppy", budget: "quick", result: null, prev: null, release: {}, running: false, cached: false, sweep: null, t0: 0, timer: null };
  window.__lab = S; // read by tests/e2e_lab.py

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function bad(x) { return x === null || x === undefined || (typeof x === "number" && isNaN(x)); }
  function n0(x) { return bad(x) ? "–" : Math.round(x).toLocaleString("en-US"); }
  function n1(x) { return bad(x) ? "–" : Number(x).toFixed(1); }
  function n2(x) { return bad(x) ? "–" : Number(x).toFixed(2); }
  function p1(x) { return bad(x) ? "–" : (100 * x).toFixed(1) + "%"; }
  function p0(x) { return bad(x) ? "–" : (100 * x).toFixed(0) + "%"; }
  function mb(b) { return (b / 1e6).toFixed(b > 1e7 ? 0 : 1) + " MB"; }
  function secs(s) { return s < 60 ? s.toFixed(1) + " s" : Math.floor(s / 60) + " min " + Math.round(s % 60) + " s"; }
  function el(tag, attrs, html) { var e = document.createElement(tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (html !== undefined) e.innerHTML = html; return e; }
  function show(id, on) { $(id).hidden = !on; }
  function errBox(id, msg, detail) {
    $(id).innerHTML = msg ? '<div class="err">' + esc(msg) + (detail ? '<details><summary>Details</summary><pre class="note">' + esc(detail) + "</pre></details>" : "") + "</div>" : "";
  }

  // ------------------------------------------------------------ theme
  $("theme").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("theme", next); } catch (e) { /* storage blocked */ }
    rerenderCharts();
  });

  // ------------------------------------------------------------ worker
  function newWorker() {
    S.ready = false; S.hasFile = false;
    S.worker = new Worker("lab-worker.js");
    S.readyP = new Promise(function (res, rej) { S._readyRes = res; S._readyRej = rej; });
    S.readyP.catch(function () { /* handled in pyFailed */ });
    S.worker.onmessage = function (ev) { onMsg(ev.data); };
    S.worker.onerror = function (e) { pyFailed("the Python worker could not start (" + (e.message || "script error") + ")"); };
    S.worker.postMessage({ type: "load" });
  }
  function onMsg(m) {
    if (m.type === "progress") {
      if (m.step === "load") { $("py-msg").textContent = m.msg + "…"; $("py-bar").style.width = m.pct + "%"; }
      if (S.pending && S.pending.onProgress) S.pending.onProgress(m);
      return;
    }
    if (m.type === "ready") {
      S.ready = true; S.versions = m.versions;
      $("py-pill").textContent = "Python ready"; $("py-pill").className = "pill ok";
      $("py-msg").textContent = "Loaded in " + secs(m.versions.load_s) + ": Pyodide " + m.versions.pyodide + ", pandas " + m.versions.pandas + ", LightGBM " + m.versions.lightgbm + ".";
      $("py-bar").style.width = "100%";
      S._readyRes(m.versions); updateButtons();
      return;
    }
    if (m.type === "error" && m.kind === "load") { pyFailed(m.msg); }
    var p = S.pending;
    if (!p) return;
    if (m.type === "error") { S.pending = null; var e = new Error(m.msg); e.kind = m.kind; e.detail = m.detail; p.reject(e); }
    else if (m.type === p.want) { S.pending = null; p.resolve(m); }
  }
  function ask(msg, want, transfer, onProgress) {
    return S.readyP.then(function () {
      return new Promise(function (resolve, reject) {
        S.pending = { want: want, resolve: resolve, reject: reject, onProgress: onProgress };
        S.worker.postMessage(msg, transfer || []);
      });
    });
  }
  function pyFailed(msg) {
    $("py-pill").textContent = "Python unavailable"; $("py-pill").className = "pill bad";
    $("py-msg").innerHTML = esc(msg) + ' You can still <button class="linkish" type="button" id="fallback-btn">show the cached Yantai result</button>.';
    $("fallback-btn").addEventListener("click", showCached);
    S._readyRej && S._readyRej(new Error(msg));
    if (S.pending) { var p = S.pending; S.pending = null; var e = new Error(msg); e.kind = "load"; p.reject(e); }
    errBox("run-err", "Python could not load in this browser, so the live experiment can't run. The cached Yantai result (computed with the same code natively) is available instead.");
    $("run-err").insertAdjacentHTML("beforeend", '<button class="btn" type="button" id="fallback-btn2">Show cached Yantai result</button>');
    $("fallback-btn2").addEventListener("click", showCached);
  }

  // ------------------------------------------------------------ step bar
  function updateSteps() {
    var done = { load: !!S.file, check: !!(S.audit && S.audit.ok), poison: !!(S.audit && S.audit.ok), train: !!S.result, results: !!S.result };
    var order = ["load", "check", "poison", "train", "results"];
    var active = order.filter(function (k) { return !done[k]; })[0] || "results";
    if (done.poison && !S.result) active = "train";
    document.querySelectorAll(".lstep").forEach(function (a) {
      var k = a.getAttribute("data-step");
      a.classList.toggle("done", done[k] && k !== active);
      a.classList.toggle("active", k === active);
      if (k === active) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
    });
  }
  function updateButtons() {
    var ok = !!(S.audit && S.audit.ok) && !S.running && !S.cached;
    $("run").disabled = !ok;
    $("cancel").disabled = !S.running;
    $("rerun").disabled = !(S.result && !S.running && !S.cached && S.ready);
    $("sweep").disabled = !(S.result && !S.running && !S.cached && S.ready);
    $("run-hint").textContent = S.running ? "Running in a background thread; the page stays usable." :
      !S.file ? "Load a file first." : !S.audit ? "Checking the file…" : !S.audit.ok ? "Fix the problems in step 2 first." :
      !S.ready ? "Python is still loading; you can press Run, it will start when ready." : "Ready.";
    if (S.audit && S.audit.ok && !S.ready && !S.running && !S.cached) $("run").disabled = false;
    updateSteps();
  }

  // ------------------------------------------------------------ 1 load
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]); });
  $("file").addEventListener("change", function () { if (this.files[0]) takeFile(this.files[0]); });
  $("use-sample").addEventListener("click", function () {
    $("use-sample").disabled = true;
    fetch("data/lab_sample.csv").then(function (r) { if (!r.ok) throw new Error("lab_sample.csv returned " + r.status); return r.arrayBuffer(); })
      .then(function (buf) { $("use-sample").disabled = false; setFile("lab_sample.csv (synthetic)", buf, true); })
      .catch(function (e) { $("use-sample").disabled = false; errBox("load-err", "Could not load the sample: " + e.message); });
  });
  $("year").addEventListener("change", function () { if (S.file) doAudit().catch(function () { /* shown in step 2 */ }); });
  $("show-cached").addEventListener("click", showCached);

  function takeFile(f) {
    if (f.size > 400e6) { errBox("load-err", f.name + " is " + mb(f.size) + ": too large for a browser tab. Try a single city file (Chongqing is 145 MB)."); return; }
    errBox("load-err", "");
    f.arrayBuffer().then(function (buf) { setFile(f.name, buf, false); }, function (e) { errBox("load-err", "Could not read the file: " + e.message); });
  }
  function setFile(name, buf, synthetic) {
    S.file = { name: name, size: buf.byteLength, buf: buf, synthetic: synthetic };
    S.audit = null; S.result = null; S.prev = null; S.release = {}; S.cached = false; S.sweep = null;
    show("cached-badge", false); show("results", false); show("results-empty", true);
    errBox("load-err", ""); errBox("run-err", "");
    $("fileinfo").innerHTML = "<dt>File</dt><dd>" + esc(name) + "</dd><dt>Size</dt><dd>" + mb(buf.byteLength) + "</dd><dt>Rows</dt><dd id=\"fi-rows\">reading…</dd>";
    show("fileinfo", true);
    updateButtons();
    doAudit().catch(function () { /* shown in step 2 */ });
  }
  function doAudit() {
    var copy = S.file.buf.slice(0);
    S.audit = null; updateButtons();
    show("check-empty", true); $("check-empty").textContent = S.ready ? "Checking the file…" : "Waiting for Python to finish loading, then checking the file…";
    return ask({ type: "audit", file: copy, name: S.file.name, year: +$("year").value }, "audit_result", [copy]).then(function (m) {
      S.hasFile = true; S.audit = m.audit; renderAudit(m.audit); updateButtons(); return m.audit;
    }, function (e) {
      if (e.kind === "data") { S.audit = { ok: false, problems: [e.message] }; renderAuditError(e.message); }
      else if (e.kind !== "load" && !e.cancelled) renderAuditError("The check failed: " + e.message, e.detail);
      updateButtons();
      throw e;
    });
  }

  // ------------------------------------------------------------ 2 check
  function renderAuditError(msg, detail) {
    show("check-empty", false); show("check", true);
    $("fi-rows") && ($("fi-rows").textContent = "–");
    errBox("check-problems", msg, detail);
    $("check-counters").innerHTML = ""; $("ch-weeks").innerHTML = ""; $("issues").querySelector("tbody").innerHTML = "";
  }
  function renderAudit(a) {
    show("check-empty", false); show("check", true);
    $("fi-rows").textContent = n0(a.rows);
    $("check-problems").innerHTML = a.ok ? (a.big_file ? '<p class="note">More than 400,000 rows: the experiment keeps the last 7 full weeks.</p>' : "") :
      '<div class="err"><strong>This file can\'t be used yet.</strong><ul>' + a.problems.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>";
    var c = [[n0(a.rows), "packages"], [a.n_full_weeks, "full weeks (" + a.weeks.length + " in all)"], [n0(a.n_couriers), "couriers"], [n0(a.n_aoi), "areas"],
      [a.plan ? fmtDate(a.plan.test_start) : "–", "test week starts"]];
    $("check-counters").innerHTML = c.map(function (x) { return '<div class="counter"><span class="num">' + x[0] + '</span><span class="cap">' + esc(x[1]) + "</span></div>"; }).join("");
    var iss = a.observed_issues, r = a.rows || 1;
    var rows = [["Duration ≤ 0", iss.duration_le_0], ["Duration > 12 h", iss.duration_gt_12h], ["Same-minute bursts (≥ 5 packages, one courier)", iss.same_minute_burst_ge5_rows],
      ["Duplicate order ids", iss.duplicate_order_id], ["GPS fix older than 30 min", iss.gps_fix_age_gt_30min], ["Courier more than 30 km from the stop", iss.courier_to_stop_gt_30km],
      ["Missing courier GPS", iss.missing_accept_gps], ["Unreadable times", a.unparseable_any], ["Missing ids", a.missing_ids]];
    $("issues").querySelector("tbody").innerHTML = rows.map(function (x) { return '<tr><td class="l">' + x[0] + "</td><td>" + n0(x[1]) + "</td><td>" + (bad(x[1]) ? "–" : p1(x[1] / r)) + "</td></tr>"; }).join("");
    $("poison-summary").textContent = a.plan ? "Training weeks start " + fmtDate(a.plan.train_start) + "; the test week starts " + fmtDate(a.plan.test_start) + "." : "";
    drawWeeks();
  }
  function fmtDate(s) { var d = new Date(s + "T00:00:00"); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }

  // ------------------------------------------------------------ 3 poison
  var presetBtns = document.querySelectorAll(".preset");
  presetBtns.forEach(function (b) { b.addEventListener("click", function () { setPreset(b.getAttribute("data-preset")); }); });
  $("presets").addEventListener("keydown", function (e) {
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].indexOf(e.key) < 0) return;
    e.preventDefault();
    var list = Array.prototype.slice.call(presetBtns), i = list.findIndex(function (b) { return b.getAttribute("aria-checked") === "true"; });
    i = (i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
    setPreset(list[i].getAttribute("data-preset")); list[i].focus();
  });
  function setPreset(p) {
    S.preset = p;
    presetBtns.forEach(function (b) { var on = b.getAttribute("data-preset") === p; b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on || p === "custom" ? 0 : -1; });
    if (p !== "custom") document.querySelectorAll("[data-mech]").forEach(function (c) { c.checked = PRESET_MECHS[p].indexOf(c.getAttribute("data-mech")) >= 0; });
    if (p === "sloppy" || p === "sloppy_stale") { $("share").value = 20; $("share-v").textContent = "20%"; }
  }
  document.querySelectorAll("[data-mech]").forEach(function (c) {
    c.addEventListener("change", function () {
      var m = mechs(), hit = Object.keys(PRESET_MECHS).filter(function (k) { return PRESET_MECHS[k].slice().sort().join() === m.slice().sort().join(); })[0];
      setPresetQuiet(hit || "custom");
    });
  });
  function setPresetQuiet(p) { S.preset = p; presetBtns.forEach(function (b) { b.setAttribute("aria-checked", b.getAttribute("data-preset") === p ? "true" : "false"); }); }
  $("share").addEventListener("input", function () { $("share-v").textContent = this.value + "%"; });
  document.querySelectorAll("[data-budget]").forEach(function (b) {
    b.addEventListener("click", function () {
      S.budget = b.getAttribute("data-budget");
      document.querySelectorAll("[data-budget]").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
    });
  });
  function mechs() { return Array.prototype.filter.call(document.querySelectorAll("[data-mech]"), function (c) { return c.checked; }).map(function (c) { return c.getAttribute("data-mech"); }); }
  function options(extra) {
    return Object.assign({ preset: S.preset, mechanisms: mechs(), sloppy_share: +$("share").value / 100, seed: Math.max(0, parseInt($("seed").value, 10) || 0),
      budget: S.budget, year: +$("year").value, release: Object.keys(S.release) }, extra || {});
  }
  setPreset("sloppy");

  // ------------------------------------------------------------ 4 train
  $("run").addEventListener("click", function () { S.release = {}; S.prev = null; runExperiment(); });
  $("rerun").addEventListener("click", function () { S.prev = S.result; runExperiment(); });
  $("cancel").addEventListener("click", cancel);

  function startTimer(label) {
    S.t0 = performance.now();
    show("runbox", true); $("run-log").innerHTML = ""; $("run-bar").style.width = "0%"; $("run-step").textContent = label;
    clearInterval(S.timer);
    S.timer = setInterval(function () { $("run-time").textContent = secs((performance.now() - S.t0) / 1000) + " elapsed"; }, 250);
  }
  function logLine(msg) {
    var d = el("div", {}, '<span class="t">' + secs((performance.now() - S.t0) / 1000) + "</span>" + esc(msg));
    $("run-log").appendChild(d); $("run-log").scrollTop = $("run-log").scrollHeight;
  }
  function onRunProgress(m) {
    if (m.step === "load") return;
    $("run-bar").style.width = m.pct + "%"; $("run-step").textContent = m.msg;
    logLine(m.msg);
  }
  function stopRun() { S.running = false; clearInterval(S.timer); updateButtons(); }
  function runExperiment() {
    if (S.running) return;
    S.running = true; errBox("run-err", ""); updateButtons();
    startTimer(S.ready ? "Starting" : "Waiting for Python to load");
    if (!S.ready) logLine("Waiting for Python to finish loading");
    var opt = options();
    var need = S.hasFile ? Promise.resolve() : (logLine("Reloading your file into Python"), doAudit());
    var tRun = 0;
    need.then(function () {
      tRun = performance.now();
      return ask({ type: "run", options: opt }, "result", [], onRunProgress);
    }).then(function (m) {
      var r = m.result;
      r.timings.page_s = (performance.now() - S.t0) / 1000;
      r.timings.worker_wait_s = (tRun - S.t0) / 1000;
      r.file = { name: S.file.name, bytes: S.file.size, synthetic: S.file.synthetic };
      $("run-bar").style.width = "100%"; $("run-step").textContent = "Done in " + secs(r.timings.page_s);
      logLine("Done");
      stopRun();
      S.result = r; S.cached = false; show("cached-badge", false);
      renderResults(r);
      updateButtons();
      if (!S.prev) $("s-results").scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "start" });
    }).catch(function (e) {
      stopRun();
      if (e.cancelled) return;
      if (e.kind === "load") return;
      $("run-step").textContent = "Stopped";
      errBox("run-err", (e.kind === "data" ? "" : "The run failed: ") + e.message, e.detail);
    });
  }
  function cancel() {
    if (!S.running) return;
    S.worker.terminate();
    var p = S.pending; S.pending = null;
    stopRun();
    $("run-step").textContent = "Cancelled"; logLine("Cancelled: the worker was stopped. Python restarts in the background.");
    newWorker();
    if (p) { var e = new Error("cancelled"); e.cancelled = true; p.reject(e); }
  }

  // ------------------------------------------------------------ 5 results
  function runsByKey(r) { var o = {}; r.runs.forEach(function (m) { o[m.key] = m; }); return o; }
  function renderResults(r) {
    show("results-empty", false); show("results", true);
    var R = runsByKey(r), h = r.headline, inj = h.kind === "injected";
    var g = r.config || {};
    $("banner").className = "banner " + h.verdict;
    $("banner").innerHTML = esc(h.sentence) + '<span class="sub">' + esc(PRESET_NAME[r.settings.preset] || r.settings.preset) +
      (r.settings.sloppy_share !== null && r.settings.sloppy_share !== undefined ? " (" + p0(r.settings.sloppy_share) + " of couriers)" : "") +
      " · seed " + r.settings.seed + " · " + r.settings.budget + " budget · Guard settings frozen on Chongqing" + (g.guard_hash ? " (guard hash " + esc(g.guard_hash) + ")" : "") +
      (r.settings.released.length ? " · " + r.settings.released.length + " courier(s) released by you" : "") + "</span>";
    // KPI cards
    var cards = r.runs.map(function (m) {
      return '<div class="kpi" style="--c: ' + RUN_COLOR[m.key] + '" data-run="' + m.key + '"><h4>' + esc(m.label) + '</h4><div class="big">' + n1(m.mae) + "<small>min MAE</small></div><dl>" +
        "<dt>P90 error</dt><dd>" + n0(m.p90_err) + " min</dd><dt>Promise-miss rate</dt><dd>" + p1(m.miss_rate) + "</dd><dt>Average promise (P80)</dt><dd>" + n0(m.promise_mean) + " min</dd>" +
        "<dt>Average width P80 − P50</dt><dd>" + n0(m.width_mean) + " min</dd><dt>Deferred to a dispatcher</dt><dd>" + p1(m.defer_rate) + "</dd></dl></div>";
    });
    if (inj) {
      var rec = h.recovery_pct;
      cards.push('<div class="kpi rec ' + h.verdict + '" style="--c: var(--pass)" data-run="recovery"><h4>Damage recovered</h4><div class="big">' + (rec === null ? "–" : n0(rec) + "%") + "</div><dl>" +
        "<dt>Damage (poisoned − reference)</dt><dd>" + (h.gap_min >= 0 ? "+" : "") + n1(h.gap_min) + " min</dd><dt>Noise floor (1% of reference)</dt><dd>" + n1(h.noise_floor_min) + " min</dd></dl>" +
        '<p class="note">' + (rec === null ? "The defect did not measurably hurt this dataset, so there is nothing to recover." : "(poisoned off − poisoned on) / (poisoned off − reference)") + "</p></div>");
    } else {
      cards.push('<div class="kpi rec ' + h.verdict + '" style="--c: var(--pass)" data-run="cost"><h4>Cost of the Guard on your data</h4><div class="big">' + (h.cost_min >= 0 ? "+" : "−") + n1(Math.abs(h.cost_min)) + "<small>min MAE</small></div><dl>" +
        "<dt>Training rows flagged by L1</dt><dd>" + n0(r.guard.quarantined) + "</dd><dt>Share of training rows</dt><dd>" + p1(r.guard.quarantined / r.guard.n_train) + "</dd></dl></div>");
    }
    $("kpis").innerHTML = cards.join("");
    // guard activity
    var gd = r.guard, f = gd.flags;
    var flagRows = [["Same-minute bursts", f.burst], ["Duplicate re-uploads", f.dup], ["Duration ≤ 0", f.nonpos], ["Courier > 30 km away", f.far], ["GPS fix > 30 min old", f.gps_age]];
    var maxF = Math.max.apply(null, flagRows.map(function (x) { return x[1]; }).concat([1]));
    $("guard-act").innerHTML =
      '<div class="gauge"><span class="k">L1 flags by type (training rows)</span>' + flagRows.map(function (x) {
        return '<span class="g-note">' + x[0] + ": <b>" + n0(x[1]) + '</b></span><div class="bar"><i style="width:' + (100 * x[1] / maxF).toFixed(1) + '%; background: var(--lq)"></i></div>';
      }).join("") + "</div>" +
      gauge("Rows quarantined (weight × 0.05)", n0(gd.quarantined) + " of " + n0(gd.n_train), gd.quarantined / gd.n_train, "L1: any flag") +
      gauge("Training weight down-weighted", p1(gd.frac_downweighted), gd.frac_downweighted, "L2: rows at under half their recency weight (reputation, flags, courier cap)") +
      gauge("Effective training size", n0(gd.eff_n) + " of " + n0(gd.n_train), gd.eff_n / gd.n_train, "(Σw)² / Σw²") +
      gauge("Test packages deferred", n0(gd.deferred) + " of " + n0(gd.n_test), gd.deferred / gd.n_test,
        "L3: " + (["area", "width", "gps", "hist"].filter(function (k) { return gd.defer_reasons[k]; }).map(function (k) { return n0(gd.defer_reasons[k]) + " " + REASON[k]; }).join("; ") || "nothing deferred"));
    // detector
    renderDetector(r);
    renderReputation(r);
    renderExplainPicker(r);
    renderEffort(r);
    renderFacts(r);
    renderRerunDiff(r);
    $("sweep-status").textContent = S.cached ? "Not available for the cached result." : "";
    $("ch-sweep").innerHTML = "";
    if (S.sweep && S.sweep.forFile === S.file && !S.cached) drawSweep(S.sweep.result);
    document.querySelector('[data-dl="quarantine"]').disabled = S.cached;
    rerenderCharts();
  }
  function gauge(k, v, frac, note) {
    return '<div class="gauge"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span><div class="bar"><i style="width:' + Math.min(100, 100 * (frac || 0)).toFixed(1) + '%"></i></div><span class="g-note">' + esc(note) + "</span></div>";
  }
  function renderDetector(r) {
    var d = r.detector;
    if (!d) {
      $("det").innerHTML = '<p>Nothing was injected, so there is nothing to score: every flag above is an issue that was already in your file (' + n0(r.guard.quarantined) + " training rows).</p>";
      return;
    }
    $("det").innerHTML = '<table class="conf" aria-label="Confusion counts"><thead><tr><th></th><th>Injected</th><th>Not injected</th></tr></thead><tbody>' +
      '<tr><th>Flagged by L1</th><td class="hit">' + n0(d.tp) + '</td><td class="miss">' + n0(d.fp) + "</td></tr>" +
      '<tr><th>Not flagged</th><td class="miss">' + n0(d.fn) + "</td><td>" + n0(d.tn) + "</td></tr></tbody></table>" +
      '<div class="gauges det-g">' + gauge("Precision", p1(d.precision), d.precision, "flagged rows that were injected") +
      gauge("Recall", p1(d.recall), d.recall, "injected rows that were flagged") +
      gauge("False-positive rate", p1(d.fpr), d.fpr, "clean rows flagged anyway") + "</div>" +
      (r.reputation.n_early ? '<p class="note">Early "delivered" scans leave no burst or duplicate trace, so L1 is not expected to catch them; only reputation (peer disagreement) can.</p>' : "");
  }
  function renderReputation(r) {
    var rp = r.reputation, inj = r.headline.kind === "injected";
    $("rep-truth-h").hidden = !inj;
    $("rep-cap").textContent = "Reputation of all " + n0(rp.n_couriers) + " couriers in the training weeks (1 = fully trusted; below 0.5 their records count much less)." +
      (rp.n_sloppy ? " The poison dial made " + rp.n_sloppy + " couriers sloppy; " + rp.sloppy_caught + " of them ended below 0.5." : "");
    $("rep-table").querySelector("tbody").innerHTML = rp.lowest.map(function (c) {
      var truth = !inj ? "" : '<td class="l' + (c.sloppy || c.early ? " yes" : "") + '">' + (c.sloppy ? "yes (sloppy)" : c.early ? "yes (early scans)" : "no") + "</td>";
      var on = !!S.release[c.courier] || c.released;
      return '<tr class="' + (c.released ? "released" : "") + '"><td class="l"><code>' + esc(c.courier) + "</code></td><td>" + n0(c.n) + "</td><td>" + p1(c.flag_rate) + "</td><td>" + n1(c.z) + "</td><td>" + n2(c.rep) + "</td>" + truth +
        '<td><input type="checkbox" data-release="' + esc(c.courier) + '" aria-label="Release courier ' + esc(c.courier) + '"' + (on ? " checked" : "") + (S.cached ? " disabled" : "") + "></td></tr>";
    }).join("");
    $("rep-table").querySelectorAll("[data-release]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var h = cb.getAttribute("data-release");
        if (cb.checked) S.release[h] = true; else delete S.release[h];
        $("release-note").textContent = Object.keys(S.release).length + " courier(s) marked for release. Press Rerun to apply.";
      });
    });
    r.settings.released.forEach(function (h) { S.release[h] = true; });
  }
  function renderRerunDiff(r) {
    var p = S.prev;
    if (!p) { $("rerun-diff").textContent = ""; return; }
    var a = runsByKey(p), b = runsByKey(r), k = a.degraded_on ? "degraded_on" : "clean_on";
    $("rerun-diff").textContent = "With " + r.settings.released.length + " courier(s) released: Guard-on MAE " + n1(a[k].mae) + " → " + n1(b[k].mae) + " min" +
      (p.headline.recovery_pct !== null && r.headline.recovery_pct !== null ? ", recovery " + n0(p.headline.recovery_pct) + "% → " + n0(r.headline.recovery_pct) + "%" : "") +
      ", deferred " + n0(a[k].n_deferred) + " → " + n0(b[k].n_deferred) + ".";
  }
  function renderEffort(r) {
    var h = r.human;
    $("effort").innerHTML = [["Training, Guard-on model pair", secs(h.train_s_guard)], ["Prediction", n2(h.predict_ms_per_pkg) + " <small>ms per package</small>"],
      ["Deferred packages", n0(h.deferred) + " <small>of " + n0(h.n_test) + "</small>"], ["Dispatcher time (assumed)", n0(h.dispatcher_min) + " <small>min = " + n0(h.deferred) + " × 45 s</small>"]]
      .map(function (x) { return '<div><span class="k">' + x[0] + '</span><span class="v">' + x[1] + "</span></div>"; }).join("");
    $("effort").style.gridTemplateColumns = "";
  }
  function renderFacts(r) {
    var d = r.data, s = r.settings, v = r.versions, t = r.timings, c = r.config || {};
    var trainS = r.runs.map(function (m) { return RUN_SHORT[m.key] + " " + secs(m.train_s); }).join(", ");
    var rows = [
      ["Data", (r.file ? esc(r.file.name) : esc(r.data_name || "")) + " · " + n0(d.rows_used) + " rows used of " + n0(d.rows_file) + (d.trimmed_to_last_weeks ? " (kept the last " + d.trimmed_to_last_weeks + " full weeks)" : "")],
      ["Weeks", "week 0 starts " + fmtDate(d.week0_start) + "; training " + fmtDate(d.train_start) + " + 4 weeks" + (s.mechanisms.indexOf("stale") >= 0 ? " (stale runs: all " + d.stale_weeks.length + " full weeks before the test)" : "") + "; test week " + fmtDate(d.test_start)],
      ["Training rows", r.runs.map(function (m) { return RUN_SHORT[m.key] + " " + n0(m.n_train); }).join(", ") + (s.capped ? " (capped at " + n0(s.row_cap) + " by whole couriers: " + (s.couriers_kept || "all") + " kept" + (s.couriers_kept_stale_window ? ", " + s.couriers_kept_stale_window + " in the stale window" : "") + ")" : " (no cap needed)")],
      ["Test packages", n0(r.runs[0].n_test)],
      ["Defects", s.mechanisms.length ? s.mechanisms.join(", ") + (s.sloppy_share !== null ? "; sloppy share " + p0(s.sloppy_share) : "") + "; bulk-scan probability " + s.ramp.bulk_p.join(" → ") + " across the training weeks; duplicates p = " + s.ramp.dup_prob + " from week " + s.ramp.dup_from_week : "none (clean as uploaded)"],
      ["Rows changed", Object.keys(r.injection).length ? Object.keys(r.injection).map(function (k) { return k + " " + n0(r.injection[k]); }).join(", ") : "–"],
      ["Seed", s.seed],
      ["Model budget", s.budget + ": " + s.n_estimators + " trees, " + s.num_leaves + " leaves, learning rate 0.05; P50 = L1 objective, P80 = quantile 0.8 (+ conformal offset with the Guard)"],
      ["Guard", "frozen config.yaml guard block, tag " + esc(c.tag || "guard-v1-frozen") + (c.guard_hash ? ", guard hash " + esc(c.guard_hash) + ", config hash " + esc(c.config_hash) : "")],
      ["Training time", trainS + " (each = a P50 + P80 model pair)"],
      ["Prediction latency", r.runs.map(function (m) { return RUN_SHORT[m.key] + " " + n2(m.predict_ms_per_pkg) + " ms"; }).join(", ") + " per package"],
      ["Run time", t.page_s ? secs(t.page_s) + " on this page (" + secs(t.total_s) + " in Python)" : secs(t.total_s || t.end_to_end_s || 0) + (r.source === "cached" ? " natively" : "")],
      ["Software", "Python " + v.python + (v.pyodide ? ", Pyodide " + v.pyodide : "") + ", pandas " + v.pandas + ", numpy " + v.numpy + ", LightGBM " + v.lightgbm + " (" + esc(v.platform) + ")"],
      ["Source", r.source === "cached" ? "cached: computed natively by scripts/lab_native.py, not live" : "live, in this browser"]
    ];
    $("facts").innerHTML = rows.map(function (x) { return "<dt>" + x[0] + "</dt><dd>" + x[1] + "</dd>"; }).join("");
  }

  // ------------------------------------------------------------ explain
  function renderExplainPicker(r) {
    var sel = $("ex-pick");
    sel.innerHTML = r.explain.map(function (e, i) { return '<option value="' + i + '">' + esc(e.label) + " (actual " + n0(e.y) + " min)</option>"; }).join("");
    sel.onchange = function () { drawExplain(r.explain[+sel.value], r); };
    if (r.explain.length) drawExplain(r.explain[0], r); else $("explain").innerHTML = '<p class="note">No test packages to explain.</p>';
  }
  function drawExplain(e, r) {
    var inj = r.headline.kind === "injected";
    var offName = inj ? "Poisoned, Guard off" : "Guard off", onName = inj ? "Poisoned, Guard on" : "Guard on";
    var feats = e.features.map(function (f) { return f.name; });
    var rank = feats.map(function (f, i) { return [i, Math.max(Math.abs(e.contrib_off[i]), Math.abs(e.contrib_on[i]))]; }).sort(function (a, b) { return b[1] - a[1]; });
    var top = rank.slice(0, 7).map(function (x) { return x[0]; });
    var ftab = '<table class="t ftab"><thead><tr><th class="l">Feature</th><th>Guard off</th><th>Guard on</th></tr></thead><tbody>' + e.features.map(function (f) {
      var chg = !bad(f.off) && !bad(f.on) ? Math.abs(f.off - f.on) > 0.05 : bad(f.off) !== bad(f.on);
      return "<tr><td class=\"l\">" + esc(FEAT[f.name] || f.name) + "</td><td" + (chg ? ' class="chg"' : "") + ">" + fv(f.off) + "</td><td" + (chg ? ' class="chg"' : "") + ">" + fv(f.on) + "</td></tr>";
    }).join("") + "</tbody></table>";
    var reasons = Object.keys(e.reasons).filter(function (k) { return e.reasons[k]; });
    $("explain").innerHTML =
      '<div class="wf"><h4>' + offName + '</h4><div class="pred">' + n0(e.p50_off) + ' <small>min predicted (median)</small></div><div class="chart" id="wf-off" data-h="300"></div></div>' +
      '<div class="wf on"><h4>' + onName + '</h4><div class="pred">' + n0(e.p50_on) + ' <small>min predicted (median)</small></div><div class="chart" id="wf-on" data-h="300"></div></div>' +
      '<div class="l3card"><h4>Serve-time check (L3)</h4><div class="verdict ' + (e.decision === "defer" ? "defer" : "ok") + '">' + (e.decision === "defer" ? "Defer to a dispatcher" : "Approve the promise") + "</div>" +
      "<ul><li>Actual duration: <b>" + n0(e.y) + " min</b></li><li>Promise (P80) with the Guard: <b>" + n0(e.p80_on) + " min</b>, without: " + n0(e.p80_off) + " min</li>" +
      "<li>" + (reasons.length ? "Why: " + reasons.map(function (k) { return REASON[k]; }).join("; ") : "All checks passed: recent GPS fix, known area, normal promise width.") + "</li></ul>" + ftab +
      (e.features[0].off === null && r.source === "cached" ? '<p class="note">Feature values are removed from the cached result (no coordinates are published).</p>' : "") + "</div>";
    var xs = [];
    [["off", e.contrib_off, e.base_off], ["on", e.contrib_on, e.base_on]].forEach(function (s) {
      var cum = s[2], other = 0;
      s[1].forEach(function (v, i) { if (top.indexOf(i) < 0) other += v; });
      xs.push(cum);
      top.forEach(function (i) { cum += s[1][i]; xs.push(cum); });
      cum += other; xs.push(cum);
    });
    var dom = [Math.min.apply(null, xs.concat([0])), Math.max.apply(null, xs)];
    drawWaterfall($("wf-off"), e.contrib_off, e.base_off, top, feats, dom);
    drawWaterfall($("wf-on"), e.contrib_on, e.base_on, top, feats, dom);
  }
  function fv(x) { return bad(x) ? "–" : Math.abs(x) >= 100 ? n0(x) : Math.abs(x - Math.round(x)) < 1e-6 ? String(Math.round(x)) : n2(x); }

  // ------------------------------------------------------------ charts
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function svgBase(node, m) {
    node.innerHTML = ""; // measure without the old svg, so a narrower layout can shrink the chart
    var w = Math.max(260, node.clientWidth || 300), h = +node.getAttribute("data-h") || 220;
    var svg = d3.select(node).append("svg").attr("width", w).attr("height", h).attr("role", "img");
    return { svg: svg, w: w, h: h, iw: w - m.l - m.r, ih: h - m.t - m.b, g: svg.append("g").attr("transform", "translate(" + m.l + "," + m.t + ")") };
  }
  function drawWeeks() {
    var a = S.audit, node = $("ch-weeks");
    if (!a || !a.weeks || !node.offsetParent && node.clientWidth === 0) return;
    var m = { l: 52, r: 8, t: 10, b: 30 }, B = svgBase(node, m), wk = a.weeks, plan = a.plan || {};
    B.svg.attr("aria-label", "Packages per week, " + wk.length + " weeks");
    var x = d3.scaleBand().domain(wk.map(function (d) { return d.week; })).range([0, B.iw]).padding(0.15);
    var y = d3.scaleLinear().domain([0, d3.max(wk, function (d) { return d.rows; }) || 1]).nice().range([B.ih, 0]);
    B.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~s")));
    var every = Math.ceil(wk.length / 8);
    B.g.append("g").attr("class", "axis").attr("transform", "translate(0," + B.ih + ")")
      .call(d3.axisBottom(x).tickValues(wk.filter(function (d, i) { return i % every === 0; }).map(function (d) { return d.week; }))
        .tickFormat(function (w) { var d = wk[w]; return d ? d.start.slice(5) : ""; }));
    B.g.selectAll("rect").data(wk).enter().append("rect")
      .attr("x", function (d) { return x(d.week); }).attr("width", x.bandwidth())
      .attr("y", function (d) { return y(d.rows); }).attr("height", function (d) { return B.ih - y(d.rows); })
      .attr("fill", function (d) {
        if (d.week === plan.test_week) return css("--tote");
        if ((plan.train_weeks || []).indexOf(d.week) >= 0) return css("--ref");
        return d.full ? css("--muted") : css("--line");
      }).attr("opacity", function (d) { return d.full && d.week !== plan.test_week && (plan.train_weeks || []).indexOf(d.week) < 0 ? 0.55 : 1; })
      .append("title").text(function (d) { return "Week of " + d.start + ": " + d.rows.toLocaleString("en-US") + " packages" + (d.full ? "" : " (partial week)"); });
  }
  function drawMae() {
    var r = S.result, node = $("ch-mae");
    if (!r) return;
    var m = { l: 46, r: 8, t: 22, b: 54 }, B = svgBase(node, m);
    var runs = r.runs, keys = ["mae", "p90_err"];
    B.svg.attr("aria-label", "MAE and P90 error per run: " + runs.map(function (d) { return d.label + " " + n1(d.mae) + " min"; }).join("; "));
    var x0 = d3.scaleBand().domain(runs.map(function (d) { return d.key; })).range([0, B.iw]).padding(0.22);
    var x1 = d3.scaleBand().domain(keys).range([0, x0.bandwidth()]).padding(0.08);
    var y = d3.scaleLinear().domain([0, d3.max(runs, function (d) { return d.p90_err; })]).nice().range([B.ih, 0]);
    B.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5));
    B.g.append("g").attr("class", "axis").attr("transform", "translate(0," + B.ih + ")").call(d3.axisBottom(x0).tickFormat(function (k) { return RUN_SHORT[k]; }))
      .selectAll("text").call(wrapText, x0.bandwidth());
    var grp = B.g.selectAll(".grp").data(runs).enter().append("g").attr("transform", function (d) { return "translate(" + x0(d.key) + ",0)"; });
    grp.selectAll("rect").data(function (d) { return keys.map(function (k) { return { k: k, v: d[k], run: d.key }; }); }).enter().append("rect")
      .attr("x", function (d) { return x1(d.k); }).attr("width", x1.bandwidth()).attr("y", function (d) { return y(d.v); }).attr("height", function (d) { return B.ih - y(d.v); })
      .attr("fill", function (d) { return css(RUN_COLOR[d.run].slice(4, -1)); }).attr("opacity", function (d) { return d.k === "mae" ? 1 : 0.45; });
    grp.selectAll("text.v").data(function (d) { return keys.map(function (k) { return { k: k, v: d[k] }; }); }).enter().append("text").attr("class", "v")
      .attr("x", function (d) { return x1(d.k) + x1.bandwidth() / 2; }).attr("y", function (d) { return y(d.v) - 5; }).attr("text-anchor", "middle")
      .attr("fill", css("--ink")).attr("font-size", 12).attr("font-weight", 700).text(function (d) { return Math.round(d.v); });
    var lg = B.svg.append("g").attr("transform", "translate(" + m.l + ",12)").attr("class", "axis");
    [["MAE", 1], ["P90 error", 0.45]].forEach(function (x, i) {
      var gx = lg.append("g").attr("transform", "translate(" + i * 90 + ",0)");
      gx.append("rect").attr("width", 11).attr("height", 11).attr("y", -9).attr("fill", css("--ink")).attr("opacity", x[1]);
      gx.append("text").attr("x", 16).text(x[0] + " (min)");
    });
  }
  function wrapText(sel, width) {
    sel.each(function () {
      var t = d3.select(this), words = t.text().split(/\s+/), line = [], tsp = t.text(null).append("tspan").attr("x", 0).attr("dy", "1em"), n = 0;
      words.forEach(function (w) {
        line.push(w); tsp.text(line.join(" "));
        if (tsp.node().getComputedTextLength() > width && line.length > 1) { line.pop(); tsp.text(line.join(" ")); line = [w]; tsp = t.append("tspan").attr("x", 0).attr("dy", "1.1em").text(w); n++; }
      });
    });
  }
  function drawRep() {
    var r = S.result, node = $("ch-rep");
    if (!r) return;
    var rp = r.reputation, m = { l: 40, r: 8, t: 10, b: 34 }, B = svgBase(node, m);
    var bins = rp.counts.map(function (c, i) { return { lo: rp.edges[i], hi: rp.edges[i + 1], c: c }; });
    B.svg.attr("aria-label", "Histogram of courier reputation for " + rp.n_couriers + " couriers");
    var x = d3.scaleLinear().domain([0.1, 1]).range([0, B.iw]);
    var y = d3.scaleLinear().domain([0, d3.max(bins, function (d) { return d.c; }) || 1]).nice().range([B.ih, 0]);
    B.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("d")));
    B.g.append("g").attr("class", "axis").attr("transform", "translate(0," + B.ih + ")").call(d3.axisBottom(x).ticks(9));
    B.g.selectAll("rect").data(bins).enter().append("rect").attr("x", function (d) { return x(d.lo) + 1; }).attr("width", function (d) { return Math.max(1, x(d.hi) - x(d.lo) - 2); })
      .attr("y", function (d) { return y(d.c); }).attr("height", function (d) { return B.ih - y(d.c); })
      .attr("fill", function (d) { return d.hi <= 0.5 ? css("--fail") : css("--ref"); })
      .append("title").text(function (d) { return d.lo.toFixed(2) + "–" + d.hi.toFixed(2) + ": " + d.c + " couriers"; });
    B.g.append("line").attr("x1", x(0.5)).attr("x2", x(0.5)).attr("y1", 0).attr("y2", B.ih).attr("stroke", css("--ink")).attr("stroke-dasharray", "3 3");
    B.g.append("text").attr("class", "axis").attr("x", x(0.5) + 4).attr("y", 10).attr("fill", css("--muted")).attr("font-size", 12).text("0.5");
  }
  function drawWaterfall(node, contrib, base, top, feats, dom) {
    var m = { l: 150, r: 46, t: 6, b: 24 }, B = svgBase(node, m);
    var rows = [{ name: "Average package", a: 0, b: base, kind: "base" }], cum = base, other = 0;
    contrib.forEach(function (v, i) { if (top.indexOf(i) < 0) other += v; });
    top.forEach(function (i) { rows.push({ name: FEAT[feats[i]] || feats[i], a: cum, b: cum + contrib[i], kind: contrib[i] >= 0 ? "up" : "down", v: contrib[i] }); cum += contrib[i]; });
    rows.push({ name: "Other features", a: cum, b: cum + other, kind: other >= 0 ? "up" : "down", v: other }); cum += other;
    rows.push({ name: "Prediction", a: 0, b: cum, kind: "pred" });
    B.svg.attr("aria-label", "Feature contributions: " + rows.slice(1, -1).map(function (d) { return d.name + " " + (d.v >= 0 ? "+" : "") + Math.round(d.v); }).join(", "));
    var y = d3.scaleBand().domain(rows.map(function (d, i) { return i; })).range([0, B.ih]).padding(0.18);
    var x = d3.scaleLinear().domain(dom).nice().range([0, B.iw]);
    B.g.append("g").attr("class", "axis").attr("transform", "translate(0," + B.ih + ")").call(d3.axisBottom(x).ticks(4));
    B.g.selectAll("text.n").data(rows).enter().append("text").attr("class", "axis").attr("x", -6).attr("y", function (d, i) { return y(i) + y.bandwidth() / 2 + 4; })
      .attr("text-anchor", "end").attr("font-size", 12).attr("fill", css("--ink")).text(function (d) { return d.name; });
    var col = { base: css("--muted"), pred: css("--ink"), up: css("--lq"), down: css("--unseen") };
    B.g.selectAll("rect").data(rows).enter().append("rect").attr("y", function (d, i) { return y(i); }).attr("height", y.bandwidth())
      .attr("x", function (d) { return x(Math.min(d.a, d.b)); }).attr("width", function (d) { return Math.max(1, Math.abs(x(d.b) - x(d.a))); })
      .attr("fill", function (d) { return col[d.kind]; });
    B.g.selectAll("text.v").data(rows).enter().append("text").attr("x", function (d) { return x(Math.max(d.a, d.b)) + 4; }).attr("y", function (d, i) { return y(i) + y.bandwidth() / 2 + 4; })
      .attr("font-size", 12).attr("fill", css("--muted")).text(function (d) { return d.kind === "base" || d.kind === "pred" ? Math.round(d.b) : (d.v >= 0 ? "+" : "−") + Math.abs(Math.round(d.v)); });
  }
  function drawSweep(sw) {
    var node = $("ch-sweep"), m = { l: 46, r: 110, t: 14, b: 36 }, B = svgBase(node, m), pts = sw.points;
    B.svg.attr("aria-label", "MAE by sloppy-courier share, Guard off and on");
    var x = d3.scaleLinear().domain([0, 0.6]).range([0, B.iw]);
    var y = d3.scaleLinear().domain([0, d3.max(pts, function (d) { return Math.max(d.mae_off, d.mae_on); })]).nice().range([B.ih, 0]);
    B.g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5));
    B.g.append("g").attr("class", "axis").attr("transform", "translate(0," + B.ih + ")").call(d3.axisBottom(x).tickValues([0, 0.2, 0.4, 0.6]).tickFormat(d3.format(".0%")));
    [["mae_off", "--lq", "Guard off"], ["mae_on", "--tote", "Guard on"]].forEach(function (s) {
      var line = d3.line().x(function (d) { return x(d.share); }).y(function (d) { return y(d[s[0]]); });
      B.g.append("path").datum(pts).attr("d", line).attr("fill", "none").attr("stroke", css(s[1])).attr("stroke-width", 3);
      B.g.selectAll("c." + s[0]).data(pts).enter().append("circle").attr("cx", function (d) { return x(d.share); }).attr("cy", function (d) { return y(d[s[0]]); }).attr("r", 4.5).attr("fill", css(s[1]))
        .append("title").text(function (d) { return s[2] + ", " + Math.round(100 * d.share) + "% sloppy: MAE " + d[s[0]].toFixed(1) + " min"; });
      var last = pts[pts.length - 1];
      B.g.append("text").attr("x", x(last.share) + 8).attr("y", y(last[s[0]]) + 4).attr("font-size", 13).attr("font-weight", 700).attr("fill", css(s[1])).text(s[2] + " " + last[s[0]].toFixed(0));
    });
    B.g.append("text").attr("class", "axis").attr("x", 0).attr("y", -2).attr("font-size", 12).attr("fill", css("--muted")).text("MAE (min)");
  }
  function rerenderCharts() {
    drawWeeks(); drawMae(); drawRep();
    if (S.result && S.result.explain.length) drawExplain(S.result.explain[+$("ex-pick").value || 0], S.result);
    if (S.sweep && S.sweep.forFile === S.file && S.result && !S.cached) drawSweep(S.sweep.result);
  }
  var resizeT = null;
  window.addEventListener("resize", function () { clearTimeout(resizeT); resizeT = setTimeout(rerenderCharts, 200); });

  // ------------------------------------------------------------ sweep (P3)
  $("sweep").addEventListener("click", function () {
    if (S.running) return;
    S.running = true; updateButtons();
    startTimer("Sweeping the dial");
    $("sweep-status").textContent = "Running 8 model pairs…";
    ask({ type: "sweep", options: options({ budget: "quick" }) }, "sweep_result", [], function (m) { onRunProgress(m); $("sweep-status").textContent = m.msg; }).then(function (m) {
      stopRun();
      $("run-step").textContent = "Sweep done in " + secs(m.result.seconds);
      S.sweep = { forFile: S.file, result: m.result };
      $("sweep-status").textContent = "Done in " + secs(m.result.seconds) + ".";
      drawSweep(m.result);
    }).catch(function (e) { stopRun(); if (!e.cancelled) $("sweep-status").textContent = "Sweep failed: " + e.message; });
  });

  // ------------------------------------------------------------ cached fallback
  function showCached() {
    fetch("data/lab_cached_yantai.json").then(function (r) { if (!r.ok) throw new Error("returned " + r.status); return r.json(); }).then(function (r) {
      S.result = r; S.prev = null; S.cached = true;
      show("cached-badge", true);
      renderResults(r);
      updateButtons();
      $("s-results").scrollIntoView({ behavior: RM ? "auto" : "smooth", block: "start" });
    }).catch(function (e) { errBox("run-err", "Could not load the cached result (" + e.message + ")."); });
  }

  // ------------------------------------------------------------ downloads
  document.querySelectorAll("[data-dl]").forEach(function (b) {
    b.addEventListener("click", function () {
      var r = S.result, k = b.getAttribute("data-dl");
      if (!r) return;
      if (k === "report") save("lab_report.json", "application/json", JSON.stringify(report(r), null, 1));
      if (k === "quarantine") save("quarantine.csv", "text/csv", quarantineCsv(r));
      if (k === "card") save("model_card.md", "text/markdown", modelCard(r));
    });
  });
  function save(name, type, text) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = el("a", { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function report(r) {
    var o = JSON.parse(JSON.stringify(r));
    o.quarantine = { columns: r.quarantine.columns, n: r.quarantine.rows.length, note: "rows are in quarantine.csv" };
    o.explain.forEach(function (e) { e.features.forEach(function (f) { if (f.name === "lng" || f.name === "lat") f.off = f.on = null; }); });
    o.generated = new Date().toISOString();
    o.page = "Shelf-Life Guard lab (lab.html)";
    return o;
  }
  function quarantineCsv(r) {
    return [r.quarantine.columns.join(",")].concat(r.quarantine.rows.map(function (x) { return x.map(function (v) { return /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v; }).join(","); })).join("\n") + "\n";
  }
  function modelCard(r) {
    var s = r.settings, d = r.data, c = r.config || {}, h = r.headline;
    var g = c.guard || {};
    var tbl = "| Run | MAE (min) | P90 error | Promise-miss rate | Avg promise P80 (min) | Deferred |\n|---|---|---|---|---|---|\n" +
      r.runs.map(function (m) { return "| " + m.label + " | " + n1(m.mae) + " | " + n0(m.p90_err) + " | " + p1(m.miss_rate) + " | " + n0(m.promise_mean) + " | " + p1(m.defer_rate) + " |"; }).join("\n");
    function block(o, ind) { return Object.keys(o).map(function (k) { return typeof o[k] === "object" && o[k] !== null ? ind + k + ":\n" + block(o[k], ind + "  ") : ind + k + ": " + o[k]; }).join("\n"); }
    return "# Model card: delivery-time model trained in the Shelf-Life Guard lab\n\n" +
      "Generated " + new Date().toISOString() + " in the browser (" + (r.source === "cached" ? "cached native result" : "live run") + ").\n\n" +
      "## Intended use\nResearch and demonstration only: shows how a LightGBM delivery-time model (median and P80 promise) behaves on this file with and without the Shelf-Life Guard. " +
      "Not validated for real dispatch decisions.\n\n" +
      "## Data\n- File: " + (r.file ? r.file.name : r.data_name || "") + (r.file && r.file.synthetic ? " (SYNTHETIC)" : "") + "\n- Rows used: " + n0(d.rows_used) + " of " + n0(d.rows_file) +
      "\n- Training weeks: 4 weeks from " + d.train_start + (s.mechanisms.indexOf("stale") >= 0 ? " (stale runs: " + d.stale_weeks.length + " weeks)" : "") + "; test week from " + d.test_start +
      "\n- Training rows capped: " + (s.capped ? "yes, at " + s.row_cap + " (whole couriers, seeded)" : "no") + "\n- Defects injected: " + (s.mechanisms.length ? s.mechanisms.join(", ") + (s.sloppy_share !== null ? " (sloppy share " + p0(s.sloppy_share) + ")" : "") : "none") +
      "\n- Couriers released by a human: " + s.released.length + "\n\n" +
      "## Model\nLightGBM " + r.versions.lightgbm + ", " + s.n_estimators + " trees, " + s.num_leaves + " leaves, seed " + s.seed + ". Features: hour, minute of day, weekday, region, area id and type, stop coordinates, courier-to-stop distance, open workload, courier and area 14-day mean duration.\n\n" +
      "## Metrics (test week, scored on the durations in the file)\n" + tbl + "\n\n" + h.sentence + "\n\n" +
      "## Guard settings (frozen on Chongqing, not tuned on this file)\nTag " + (c.tag || "guard-v1-frozen") + (c.guard_hash ? ", guard hash " + c.guard_hash + ", config hash " + c.config_hash : "") + ".\n\n```yaml\n" + block(g, "") + "\n```\n\n" +
      "## Limits\n- One train/test split, one seed: differences under about 1% of MAE are noise.\n- The Guard down-weights couriers whose scans disagree with their peers; a courier who is genuinely slower can be penalized. Releasing them is a human decision.\n" +
      "- Early \"delivered\" scans leave no burst or duplicate trace, so L1 cannot catch them.\n- Promises (P80) aim for 80% coverage; the miss rate shows how close they came on this week.\n- Results depend on the file: other cities, years or couriers can behave differently.\n";
  }

  // ------------------------------------------------------------ start
  updateButtons();
  newWorker(); // preload Python as soon as the page opens
})();

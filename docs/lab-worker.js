/* Lab worker: runs the Shelf-Life Guard pipeline (docs/py/guardlab, a copy of src/) in Pyodide.
   Nothing leaves the browser: the file arrives as an ArrayBuffer and is written to Pyodide's
   in-memory filesystem. Messages in:  {type: "load"} | {type: "audit", file, name, year} |
   {type: "run", options} | {type: "sweep", options} | {type: "cancel"}.
   Messages out: {type: "progress", step, pct, msg} | {type: "ready", versions} |
   {type: "audit_result", audit} | {type: "result", result} | {type: "sweep_result", result} |
   {type: "error", msg, detail, kind}. Cancel = the page terminates this worker. */
"use strict";
var PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/";
var py = null, loading = null, t0 = 0;
var SALT = (function () {
  var a = new Uint8Array(8); self.crypto.getRandomValues(a);
  return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
})();

function post(m) { self.postMessage(m); }
function progress(step, pct, msg) { post({ type: "progress", step: step, pct: pct, msg: msg }); }

function load() {
  if (loading) return loading;
  t0 = performance.now();
  loading = (async function () {
    progress("load", 2, "Downloading Python (Pyodide 0.29.4)");
    importScripts(PYODIDE + "pyodide.js");
    py = await self.loadPyodide({ indexURL: PYODIDE });
    progress("load", 35, "Loading numpy, pandas, scikit-learn and LightGBM");
    await py.loadPackage(["numpy", "pandas", "lightgbm"], { messageCallback: function () {}, errorCallback: function () {} });
    progress("load", 85, "Loading the Guard code");
    var cfg = await (await fetch("py/lab_config.json")).json();
    py.FS.mkdirTree("/home/pyodide/guardlab");
    await Promise.all(cfg.py_files.map(async function (f) {
      var r = await fetch("py/guardlab/" + f);
      if (!r.ok) throw new Error("could not fetch py/guardlab/" + f + " (" + r.status + ")");
      py.FS.writeFile("/home/pyodide/guardlab/" + f, await r.text());
    }));
    py.globals.set("CFG_JSON", JSON.stringify(cfg));
    py.globals.set("SALT", SALT);
    py.runPython([
      "import sys, json, traceback, warnings",
      "warnings.filterwarnings('ignore', message='X does not have valid feature names')",
      "sys.path.insert(0, '/home/pyodide')",
      "import guardlab.lab as lab",
      "LAB = json.loads(CFG_JSON)",
      "CFG = LAB['config']",
      "RAW = None",
      "YEAR = CFG['data']['year']"
    ].join("\n"));
    var v = JSON.parse(py.runPython("json.dumps(lab.versions())"));
    v.pyodide = py.version;
    v.load_s = (performance.now() - t0) / 1000;
    v.config_hash = py.runPython("LAB['config_hash']");
    v.guard_hash = py.runPython("LAB['guard_hash']");
    progress("load", 100, "Python ready");
    post({ type: "ready", versions: v });
    return v;
  })();
  return loading;
}

// Run Python, mapping lab.LabError (a problem with the file) to a friendly message.
function call(code, kind) {
  py.globals.set("_CODE", code);
  var out = py.runPython([
    "try:",
    "    _OUT = json.dumps({'ok': True, 'value': eval(_CODE)})",
    "except lab.LabError as e:",
    "    _OUT = json.dumps({'ok': False, 'kind': 'data', 'msg': str(e)})",
    "except MemoryError:",
    "    _OUT = json.dumps({'ok': False, 'kind': 'memory', 'msg': 'The browser ran out of memory for this file. Try a smaller file or the Quick budget.'})",
    "except Exception as e:",
    "    _OUT = json.dumps({'ok': False, 'kind': 'python', 'msg': type(e).__name__ + ': ' + str(e), 'detail': traceback.format_exc()})",
    "_OUT"
  ].join("\n"));
  var r = JSON.parse(out);
  if (!r.ok) { var e = new Error(r.msg); e.kind = r.kind || kind; e.detail = r.detail || ""; throw e; }
  return r.value;
}

async function audit(m) {
  await load();
  var t = performance.now();
  progress("audit", 10, "Reading " + (m.name || "the file"));
  py.FS.writeFile("/tmp/upload.csv", new Uint8Array(m.file));
  m.file = null;
  py.globals.set("YEAR", m.year || 2022);
  call("globals().__setitem__('RAW', lab.read_lab_csv('/tmp/upload.csv')) or len(RAW)");
  try { py.FS.unlink("/tmp/upload.csv"); } catch (e) { /* already gone */ }
  progress("audit", 60, "Checking times, weeks and issues");
  var a = JSON.parse(call("lab.to_json(lab.lab_audit(RAW, CFG, int(YEAR)))"));
  a.audit_s = (performance.now() - t) / 1000;
  progress("audit", 100, "Checked");
  post({ type: "audit_result", audit: a });
}

function setOptions(o) {
  py.globals.set("OPT_JSON", JSON.stringify(o || {}));
  py.globals.set("_PROGRESS", function (step, pct, msg) { progress(step, pct, msg); });
}

async function run(m) {
  await load();
  var t = performance.now();
  setOptions(m.options);
  progress("prepare", 4, "Preparing features (weeks, history, workload)");
  call("globals().__setitem__('OPT', json.loads(OPT_JSON)) or True");
  call("globals().__setitem__('PREP', lab.prepare(RAW, CFG, int(OPT.get('year', YEAR)), OPT.get('budget', 'quick'), float(OPT.get('sloppy_share', 0.2)))) or True");
  var prep_s = (performance.now() - t) / 1000;
  var r = JSON.parse(call("lab.to_json(dict(lab.run_lab(*PREP, OPT, progress=_PROGRESS, salt=OPT.get('salt') or SALT), config={'config_hash': LAB['config_hash'], 'guard_hash': LAB['guard_hash'], 'guard': CFG['guard'], 'tag': LAB['guard_tag']}, source='browser'))"));
  r.timings.prepare_s = prep_s;
  r.timings.end_to_end_s = (performance.now() - t) / 1000;
  r.versions.pyodide = py.version;
  post({ type: "result", result: r });
}

async function sweep(m) {
  await load();
  var t = performance.now();
  setOptions(m.options);
  call("globals().__setitem__('OPT', json.loads(OPT_JSON)) or True");
  call("globals().__setitem__('PREP', lab.prepare(RAW, CFG, int(OPT.get('year', YEAR)), OPT.get('budget', 'quick'), 0.2)) or True");
  var r = JSON.parse(call("lab.to_json(lab.run_sweep(*PREP, OPT, progress=_PROGRESS))"));
  r.seconds = (performance.now() - t) / 1000;
  post({ type: "sweep_result", result: r });
}

self.onmessage = function (ev) {
  var m = ev.data || {};
  var job = m.type === "load" ? load() : m.type === "audit" ? audit(m) : m.type === "run" ? run(m) :
    m.type === "sweep" ? sweep(m) : m.type === "cancel" ? Promise.resolve(self.close()) : Promise.resolve();
  job.catch(function (e) {
    var kind = e.kind || (py ? "python" : "load");
    post({ type: "error", kind: kind, msg: kind === "load" ? "Python could not load in this browser (" + (e.message || e) + ")." : (e.message || String(e)), detail: e.detail || (e.stack || "") });
    if (!py) loading = null;
  });
};

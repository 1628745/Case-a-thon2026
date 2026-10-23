"""End-to-end checks in headless Chromium (Playwright). Not collected by pytest (needs network for Pyodide).

.venv/bin/python tests/e2e_lab.py worker   # lab-worker.js alone: audit + run -> same schema as src/lab.py
.venv/bin/python tests/e2e_lab.py lab      # lab.html: synthetic (default + clean), Yantai via set_input_files
.venv/bin/python tests/e2e_lab.py smoke    # index.html regression smoke test + the "Try it" link
.venv/bin/python tests/e2e_lab.py all      # everything (+ screenshots in logs/lab_screens/)
Writes logs/e2e_lab.json with timings. Exit code 0 only if every check passed.
"""
import functools
import http.server
import json
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
YT = os.path.join(ROOT, "data", "raw", "delivery_yt.csv")
SHOTS = os.path.join(ROOT, "logs", "lab_screens")
PROFILE = os.path.join(ROOT, ".cache", "pw-profile")  # keeps the Pyodide download cached between runs
PORT = int(os.environ.get("E2E_PORT", "8765"))
BASE = f"http://127.0.0.1:{PORT}"
sys.path.insert(0, ROOT)
REPORT = {"checks": [], "timings": {}}
SCHEMA_KEYS = ["schema", "settings", "data", "runs", "headline", "guard", "detector", "reputation", "injection",
               "explain", "human", "quarantine", "timings", "versions"]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    h = functools.partial(Quiet, directory=DOCS)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def check(name, ok, detail=""):
    REPORT["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""), flush=True)
    return ok


def console_watch(page, bucket):
    def on_msg(m):
        if m.type == "error":
            bucket.append(m.text)
    page.on("console", on_msg)
    page.on("pageerror", lambda e: bucket.append("pageerror: " + str(e)))


def native_schema():
    from src import lab
    from src.common import load_config
    cfg = load_config()
    raw = lab.read_lab_csv(os.path.join(DOCS, "data", "lab_sample.csv"))
    base, lcfg, split = lab.prepare(raw, cfg, 2022)
    return json.loads(lab.to_json(lab.run_lab(base, lcfg, split, {"preset": "sloppy", "seed": 0})))


def shape(o):
    """Recursive key structure (lists: shape of the first item)."""
    if isinstance(o, dict):
        return {k: shape(v) for k, v in sorted(o.items())}
    if isinstance(o, list):
        return [shape(o[0])] if o and isinstance(o[0], (dict, list)) else []
    return None


WORKER_JS = """
async ({csvText, opts}) => {
  const w = new Worker('/lab-worker.js');
  const log = [];
  const wait = (type) => new Promise((res, rej) => {
    w.onerror = (e) => rej(new Error('worker failed to start: ' + (e.message || 'script error')));
    w.onmessage = (e) => { const m = e.data; if (m.type === 'progress') log.push(m.msg);
      else if (m.type === 'error') rej(new Error(m.kind + ': ' + m.msg + ' ' + (m.detail || '')));
      else if (m.type === type) res(m); };
  });
  const t0 = performance.now();
  w.postMessage({type: 'load'}); const ready = await wait('ready');
  const t1 = performance.now();
  const buf = new TextEncoder().encode(csvText).buffer;
  w.postMessage({type: 'audit', file: buf, name: 'lab_sample.csv', year: 2022}, [buf]);
  const audit = (await wait('audit_result')).audit;
  const t2 = performance.now();
  w.postMessage({type: 'run', options: opts}); const result = (await wait('result')).result;
  const t3 = performance.now();
  w.terminate();
  return {ready: ready.versions, audit, result, log, load_s: (t1 - t0) / 1000, audit_s: (t2 - t1) / 1000, run_s: (t3 - t2) / 1000};
}
"""


def worker_check(ctx):
    page = ctx.new_page()
    errs = []
    console_watch(page, errs)
    page.goto(BASE + "/data/")
    with open(os.path.join(DOCS, "data", "lab_sample.csv")) as f:
        csv = f.read()
    t = time.time()
    out = page.evaluate(WORKER_JS, {"csvText": csv, "opts": {"preset": "sloppy", "seed": 0, "budget": "quick"}})
    REPORT["timings"]["worker_sample"] = {"load_s": out["load_s"], "audit_s": out["audit_s"], "run_s": out["run_s"],
                                          "wall_s": time.time() - t}
    r = out["result"]
    check("worker: versions", out["ready"]["lightgbm"] == "4.6.0" and out["ready"]["pandas"].startswith("2.3"), out["ready"])
    check("worker: audit ok", out["audit"]["ok"] and out["audit"]["n_full_weeks"] == 8, out["audit"]["problems"])
    nat = native_schema()
    check("worker: top-level schema keys", all(k in r for k in SCHEMA_KEYS), [k for k in SCHEMA_KEYS if k not in r])
    fixed = [k for k in SCHEMA_KEYS if k not in ("timings", "versions")]
    s_b, s_n = shape({k: r[k] for k in fixed}), shape({k: nat[k] for k in fixed})
    extra_ok = all(set(nat[k]) <= set(r[k]) for k in ("timings", "versions"))  # the browser adds load/prepare times, pyodide
    check("worker: same JSON schema as native", s_b == s_n and extra_ok, [k for k in fixed if s_b.get(k) != s_n.get(k)])
    mb = {m["key"]: m["mae"] for m in r["runs"]}
    mn = {m["key"]: m["mae"] for m in nat["runs"]}
    rel = {k: abs(mb[k] - mn[k]) / mn[k] for k in mn}
    REPORT["parity_sample"] = {"browser": mb, "native": mn, "rel_diff": rel}
    check("worker: sample MAE within 2% of native", max(rel.values()) < 0.02, {k: round(v, 4) for k, v in rel.items()})
    check("worker: progress messages", len(out["log"]) >= 6, len(out["log"]))
    check("worker: no console errors", not errs, errs[:3])
    page.close()
    return r


def main(what):
    from playwright.sync_api import sync_playwright
    os.makedirs(SHOTS, exist_ok=True)
    srv = serve()
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(PROFILE, headless=True, viewport={"width": 1440, "height": 900})
            ctx.set_default_timeout(300_000)
            if what in ("worker", "all"):
                worker_check(ctx)
            if what in ("lab", "all"):
                lab_check(ctx, p)
            if what in ("smoke", "all"):
                smoke_check(ctx)
            ctx.close()
    finally:
        srv.shutdown()
    ok = all(c["ok"] for c in REPORT["checks"])
    REPORT["ok"] = ok
    REPORT["when"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(os.path.join(ROOT, "logs", f"e2e_lab_{what}.json"), "w") as f:
        json.dump(REPORT, f, indent=1)
    print(f"{sum(c['ok'] for c in REPORT['checks'])}/{len(REPORT['checks'])} checks passed")
    return 0 if ok else 1


def lab_check(ctx, p):
    raise NotImplementedError


def smoke_check(ctx):
    raise NotImplementedError


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "all"))

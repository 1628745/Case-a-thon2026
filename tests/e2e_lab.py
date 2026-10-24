"""End-to-end checks in headless Chromium (Playwright). Not collected by pytest (needs network for Pyodide).

.venv/bin/python tests/e2e_lab.py worker   # lab-worker.js alone: audit + run -> same schema as src/lab.py
.venv/bin/python tests/e2e_lab.py lab      # lab.html: synthetic (default + clean), Yantai via set_input_files
.venv/bin/python tests/e2e_lab.py smoke    # index.html regression smoke test + the "Try it" link
.venv/bin/python tests/e2e_lab.py budgets  # cold Pyodide load (fresh profile) + Chongqing full file
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

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always test the current files (Pyodide from the CDN stays cached)
        super().end_headers()


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
            if what in ("budgets", "all"):
                budget_check(p)
    finally:
        srv.shutdown()
    ok = all(c["ok"] for c in REPORT["checks"])
    REPORT["ok"] = ok
    REPORT["when"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(os.path.join(ROOT, "logs", f"e2e_lab_{what}.json"), "w") as f:
        json.dump(REPORT, f, indent=1)
    print(f"{sum(c['ok'] for c in REPORT['checks'])}/{len(REPORT['checks'])} checks passed")
    return 0 if ok else 1


def wait_result(page, prev_id, timeout=600_000):
    """Wait until window.__lab.result is a new object and nothing is running; returns its timings."""
    page.wait_for_function("(prev) => window.__lab.result && !window.__lab.running && window.__lab.result !== window.__labPrev",
                           arg=prev_id, timeout=timeout)
    page.evaluate("window.__labPrev = window.__lab.result")
    return page.evaluate("JSON.parse(JSON.stringify({t: window.__lab.result.timings, h: window.__lab.result.headline, "
                         "runs: window.__lab.result.runs.map(r => [r.key, r.mae]), released: window.__lab.result.settings.released}))")


def results_ok(page, tag, injected):
    n_kpi = page.locator("#kpis .kpi").count()
    big = page.locator("#kpis .kpi .big").all_inner_texts()
    check(f"{tag}: KPI cards filled", n_kpi == (4 if injected else 3) and all(b.strip() and not b.startswith("–") for b in big), big)
    check(f"{tag}: banner", page.locator("#banner").inner_text().strip() != "", page.locator("#banner").inner_text()[:90])
    bars = page.locator("#ch-mae svg rect").count()
    check(f"{tag}: MAE chart renders", bars >= (6 if injected else 4), bars)
    check(f"{tag}: guard activity in one line", page.locator("#guard-act span").count() == 3 and "effective training size" in page.locator("#guard-act").inner_text())
    trust = page.locator("#trust").inner_text()
    check(f"{tag}: courier trust sentence", trust.startswith("Courier trust:") and "below 0.5" in trust, trust[:100])
    check(f"{tag}: no reputation table, explain or sweep", page.locator("#rep-table, #ch-rep, #ex-pick, #wf-off, #sweep, #ch-sweep").count() == 0)
    det = page.locator("#det").inner_text()
    check(f"{tag}: detector scorecard", ("Precision" in det) if injected else ("Nothing was injected" in det), det[:80])
    rv = page.locator("#review").inner_text()
    check(f"{tag}: dispatcher review panel", "Dispatcher time (assumed)" in rv and "ms per package" in rv and "45 s" in rv
          and page.locator("#pkgcard .verdict").count() == 1 and "Promise without the Guard" in rv and "GPS fix age" in rv, rv[:80])
    check(f"{tag}: run facts collapsed", "Seed" in page.locator("#facts").text_content() and page.get_attribute("#facts-box", "open") is None)


def downloads_ok(page, tag):
    out = {}
    for k, fn in [("report", "lab_report.json"), ("quarantine", "quarantine.csv"), ("card", "model_card.md")]:
        with page.expect_download() as d:
            page.click(f'[data-dl="{k}"]')
        dl = d.value
        with open(dl.path(), encoding="utf-8") as f:
            out[k] = f.read()
        check(f"{tag}: download {fn} name", dl.suggested_filename == fn, dl.suggested_filename)
    rep = json.loads(out["report"])
    check(f"{tag}: lab_report.json valid", all(k in rep for k in SCHEMA_KEYS) and rep["quarantine"]["n"] >= 0)
    lines = out["quarantine"].strip().splitlines()
    nq = page.evaluate("window.__lab.result.quarantine.rows.length")
    check(f"{tag}: quarantine.csv valid", lines[0] == "file_line,courier,reasons,note" and len(lines) - 1 == nq
          and all(len(x.split(",")) == 4 for x in lines[1:]), f"{len(lines) - 1} rows")
    check(f"{tag}: model_card.md valid", out["card"].startswith("# Model card") and "## Metrics" in out["card"] and "## Guard settings" in out["card"])
    check(f"{tag}: no coordinates in report", all(f["off"] is None for e in rep["explain"] for f in e["features"] if f["name"] in ("lng", "lat")))


def no_overflow(page, tag):
    w = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    return check(f"{tag}: no horizontal overflow", w[0] <= w[1], w)


def shots(page, name):
    for scheme in ("light", "dark"):
        page.emulate_media(color_scheme=scheme)
        page.evaluate("document.documentElement.removeAttribute('data-theme'); window.dispatchEvent(new Event('resize'))")
        page.wait_for_timeout(500)
        page.screenshot(path=os.path.join(SHOTS, f"{name}_{scheme}.png"), full_page=True)
    page.emulate_media(color_scheme="light")


def lab_check(ctx, p):
    page = ctx.new_page()
    errs = []
    console_watch(page, errs)
    t = time.time()
    page.goto(BASE + "/lab.html")
    page.wait_for_function("window.__lab && window.__lab.ready", timeout=180_000)
    REPORT["timings"]["page_python_ready_s"] = time.time() - t
    check("lab: Python loads", True, f"{time.time() - t:.1f} s")
    check("P3 new-city card", "% recovered" in page.locator("#newcity").inner_text(), page.locator("#newcity").inner_text()[:100])
    page.evaluate("window.__labPrev = null")

    # synthetic, default preset
    page.click("#use-sample")
    page.wait_for_function("window.__lab.audit && window.__lab.audit.ok", timeout=60_000)
    check("synthetic: audit counters", "8" in page.locator("#check-counters").inner_text() and page.locator("#ch-weeks svg rect").count() == 8)
    check("synthetic: default preset is Sloppy 20%", page.get_attribute('[data-preset="sloppy"]', "aria-checked") == "true")
    t = time.time()
    page.click("#run")
    r = wait_result(page, None)
    REPORT["timings"]["synthetic_sloppy"] = {"click_to_result_s": time.time() - t, **r["t"]}
    check("synthetic: default run <= 45 s", time.time() - t <= 45, f"{time.time() - t:.1f} s")
    results_ok(page, "synthetic sloppy", True)
    downloads_ok(page, "synthetic sloppy")
    no_overflow(page, "synthetic 1440")
    shots(page, "lab_1440_synthetic")

    # human override: restore trust for every courier below 0.5, rerun with the same settings
    n_low = page.evaluate("window.__lab.result.reputation.below_half.length")
    t = time.time()
    page.click("#restore")
    r2 = wait_result(page, None)
    REPORT["timings"]["synthetic_restore_rerun_s"] = time.time() - t
    diff = page.locator("#rerun-diff").inner_text()
    check("override: restore trust reruns with all flagged couriers released", n_low > 0 and len(r2["released"]) == n_low
          and diff.startswith(f"Trust restored for {n_low} courier") and "Guard-on MAE" in diff, diff)

    # the Guard's honest failure case
    page.click('[data-preset="unseen"]')
    t = time.time()
    page.click("#run")
    r = wait_result(page, None)
    REPORT["timings"]["synthetic_unseen"] = {"click_to_result_s": time.time() - t, **r["t"]}
    check("Unseen preset: runs and is reported", [k for k, _ in r["runs"]] == ["reference", "degraded_off", "degraded_on"]
          and "early-scan couriers" in page.locator("#trust").inner_text(), r["h"]["sentence"])

    # synthetic, clean
    page.click('[data-preset="clean"]')
    t = time.time()
    page.click("#run")
    r = wait_result(page, None)
    REPORT["timings"]["synthetic_clean"] = {"click_to_result_s": time.time() - t, **r["t"]}
    results_ok(page, "synthetic clean", False)
    downloads_ok(page, "synthetic clean")

    # cancel, then the worker comes back
    page.click('[data-preset="sloppy"]')
    page.click("#run")
    page.wait_for_timeout(700)
    page.click("#cancel")
    check("cancel: run stops", page.locator("#run-step").inner_text() == "Cancelled")
    page.wait_for_function("window.__lab.ready", timeout=120_000)
    check("cancel: Python restarts", True)

    # Yantai via the file picker
    if os.path.exists(YT):
        t = time.time()
        page.set_input_files("#file", YT)
        page.wait_for_function("window.__lab.audit && window.__lab.audit.ok", timeout=120_000)
        audit_s = page.evaluate("window.__lab.audit.audit_s")
        REPORT["timings"]["yantai_audit_s"] = audit_s
        check("Yantai: audit <= 15 s", audit_s <= 15, f"{audit_s:.1f} s")
        page.click('[data-preset="sloppy"]')
        t = time.time()
        page.click("#run")
        r = wait_result(page, None)
        el = time.time() - t
        REPORT["timings"]["yantai_sloppy"] = {"click_to_result_s": el, **r["t"]}
        check("Yantai: default run <= 90 s", el <= 90, f"{el:.1f} s")
        results_ok(page, "Yantai sloppy", True)
        downloads_ok(page, "Yantai sloppy")
        nat_p = os.path.join(ROOT, "logs", "lab", "native_yt_sloppy.json")
        if os.path.exists(nat_p):
            with open(nat_p) as f:
                nat = {m["key"]: m["mae"] for m in json.load(f)["runs"]}
            br = dict(r["runs"])
            rel = {k: abs(br[k] - nat[k]) / nat[k] for k in nat}
            REPORT["parity_yantai"] = {"browser": br, "native": nat, "rel_diff": rel}
            check("Yantai parity: browser MAE within 2% of native", max(rel.values()) < 0.02,
                  {k: f"{br[k]:.2f} vs {nat[k]:.2f}" for k in nat})
        shots(page, "lab_1440_yantai")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(600)
        no_overflow(page, "Yantai 390")
        shots(page, "lab_390_yantai")
        page.set_viewport_size({"width": 1440, "height": 900})
    else:
        check("Yantai: data/raw/delivery_yt.csv present", False)

    # cached fallback
    page.click("#show-cached")
    page.wait_for_function("window.__lab.cached", timeout=30_000)
    check("cached fallback: badge + results", page.locator("#cached-badge").is_visible() and page.locator("#kpis .kpi").count() == 4)
    check("lab: zero console errors", not errs, errs[:5])
    page.close()


def budget_check(p):
    import shutil
    import tempfile
    tmp = tempfile.mkdtemp(dir=os.path.join(ROOT, ".cache"))
    try:
        ctx = p.chromium.launch_persistent_context(tmp, headless=True, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        console_watch(page, errs)
        t = time.time()
        page.goto(BASE + "/lab.html")
        page.wait_for_function("window.__lab && window.__lab.ready", timeout=300_000)
        cold = time.time() - t
        REPORT["timings"]["cold_load_s"] = cold
        check("budget: first (cold) Python load <= 40 s", cold <= 40, f"{cold:.1f} s")
        page.reload()
        t = time.time()
        page.wait_for_function("window.__lab && window.__lab.ready", timeout=120_000)
        warm = time.time() - t
        REPORT["timings"]["warm_load_s"] = warm
        check("budget: cached Python load <= 5 s", warm <= 5, f"{warm:.1f} s")
        cq = os.path.join(ROOT, "data", "raw", "delivery_cq.csv")
        if os.path.exists(cq):
            page.evaluate("window.__labPrev = null")
            t = time.time()
            page.set_input_files("#file", cq)
            page.wait_for_function("window.__lab.audit", timeout=300_000)
            a = page.evaluate("JSON.parse(JSON.stringify(window.__lab.audit))")
            REPORT["timings"]["cq_audit_s"] = time.time() - t
            if a.get("ok"):
                page.click("#run")
                page.wait_for_function("(window.__lab.result && !window.__lab.running) || document.getElementById('run-err').innerText.length > 0",
                                       timeout=330_000)
                el = time.time() - t
                err = page.locator("#run-err").inner_text()
                REPORT["timings"]["cq_total_s"] = el
                REPORT["cq"] = {"error": err, "runs": page.evaluate("window.__lab.result ? window.__lab.result.runs.map(r => [r.key, r.mae, r.n_train]) : null"),
                                "data": page.evaluate("window.__lab.result ? window.__lab.result.data : null")}
                check("budget: Chongqing completes <= 5 min or refuses clearly", (el <= 300 and not err) or (err and "memory" in err.lower()),
                      f"{el:.0f} s; {err[:120] or 'completed'}")
            else:
                check("budget: Chongqing refused clearly", bool(a.get("problems")), a.get("problems"))
        check("budget: zero console errors", not errs, errs[:3])
        ctx.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def smoke_check(ctx):
    page = ctx.new_page()
    errs = []
    console_watch(page, errs)
    page.goto(BASE + "/index.html")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    info = page.evaluate("""() => ({
      sections: ['poisons', 'built', 'analysis'].filter(id => document.getElementById(id)).length,
      svgs: document.querySelectorAll('main svg').length,
      chartSvgs: document.querySelectorAll('.chart svg').length,
      err: !!document.querySelector('main .err'),
      tryit: !!document.querySelector('header a[href="lab.html"]'),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })""")
    REPORT["smoke_index"] = info
    base_p = os.path.join(ROOT, "logs", "smoke_baseline.json")
    if os.path.exists(base_p):
        with open(base_p) as f:
            base = json.load(f)
        check("index: same sections and charts as before", info["sections"] == base["sections"] and info["chartSvgs"] == base["chartSvgs"]
              and info["svgs"] == base["svgs"], {"now": info, "baseline": base})
    else:
        with open(base_p, "w") as f:
            json.dump(info, f)
        check("index: baseline recorded", True, info)
    check("index: sections present", info["sections"] == 3, info["sections"])
    check("index: charts render", info["chartSvgs"] >= 5, info["chartSvgs"])
    check("index: no data-load error box", not info["err"])
    check("index: no horizontal overflow", not info["overflow"])
    check("index: zero console errors", not errs, errs[:5])
    if os.environ.get("E2E_BASELINE"):
        page.close()
        return
    page.screenshot(path=os.path.join(SHOTS, "index_1440.png"))
    page.set_viewport_size({"width": 390, "height": 844})
    page.reload()  # index.html lays out its decorations at load; a live 1440 -> 390 resize isn't what a phone sees
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    no_overflow(page, "index 390")
    check("index: Try it link visible at 390 px", page.locator("header a.tryit").is_visible())
    page.screenshot(path=os.path.join(SHOTS, "index_390.png"))
    page.set_viewport_size({"width": 1440, "height": 900})
    check("index: Try it link in the header", info["tryit"])
    page.click('header a[href="lab.html"]')
    page.wait_for_url("**/lab.html")
    check("index: Try it link opens the lab", page.title().startswith("Try it"), page.title())
    page.goto(BASE + "/index.html")
    page.wait_for_load_state("networkidle")
    page.keyboard.press("5")
    page.wait_for_url("**/lab.html", timeout=10_000)
    check("index: key 5 opens the lab", True)
    page.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "all"))

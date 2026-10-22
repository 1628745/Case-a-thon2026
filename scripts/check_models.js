// In-browser model check: evaluate docs/models/*.json with docs/trees.js (the code the site runs)
// on the 20 inputs written by src/export_site.py and compare to LightGBM's Python predictions.
// Usage: node scripts/check_models.js   (exit code 1 on any |diff| >= 0.01 min)
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const T = require(path.join(root, "docs", "trees.js"));
const chk = JSON.parse(fs.readFileSync(path.join(root, "logs", "model_check_inputs.json")));
let worst = 0, n = 0;
for (const name of Object.keys(chk.python)) {
  const model = JSON.parse(fs.readFileSync(path.join(root, "docs", "models", name + ".json")));
  if (JSON.stringify(model.features) !== JSON.stringify(chk.features)) throw new Error("feature order mismatch " + name);
  chk.X.forEach((row, i) => {
    const x = row.map((v) => T.f32(v === null ? NaN : v));
    const js = T.predict(model, x), py = chk.python[name][i];
    const d = Math.abs(js - py);
    worst = Math.max(worst, d); n++;
    if (d >= 0.01) console.log(`MISMATCH ${name} input ${i}: js ${js} py ${py}`);
  });
  console.log(`${name}: ${model.n_trees} trees, 20 inputs checked`);
}
const ok = worst < 0.01 && n === 80;
console.log(`${n} predictions, max |js - python| = ${worst.toExponential(3)} min -> ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);

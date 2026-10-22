// LightGBM tree evaluator for the compact JSON exported by src/export_site.py.
// Each tree: f (split feature), t (threshold), dl (default_left 0/1), mt (missing type 0 None, 1 Zero, 2 NaN),
// l / r (children: >= 0 internal node index, < 0 leaf ~index), v (leaf values).
// Matches LightGBM's NumericalDecision: NaN becomes 0 unless missing type is NaN; a missing value
// (zero for Zero, NaN for NaN) follows default_left; otherwise go left when x <= threshold.
(function (root) {
  var K_ZERO = 1e-35;

  function leafIndex(tree, x) {
    if (tree.f.length === 0) return 0;
    var node = 0;
    while (node >= 0) {
      var fv = x[tree.f[node]];
      if (fv === null || fv === undefined) fv = NaN;
      var mt = tree.mt[node];
      if (isNaN(fv) && mt !== 2) fv = 0.0;
      var goLeft;
      if ((mt === 1 && Math.abs(fv) <= K_ZERO) || (mt === 2 && isNaN(fv))) {
        goLeft = tree.dl[node] === 1;
      } else {
        goLeft = fv <= tree.t[node];
      }
      node = goLeft ? tree.l[node] : tree.r[node];
    }
    return ~node;
  }

  function predict(model, x) {
    var s = 0;
    for (var i = 0; i < model.trees.length; i++) {
      var tr = model.trees[i];
      s += tr.v[leafIndex(tr, x)];
    }
    return s;
  }

  // float32 rounding, as the Python pipeline feeds float32 features
  function f32(x) { return x === null || x === undefined || isNaN(x) ? NaN : Math.fround(x); }

  var api = { predict: predict, leafIndex: leafIndex, f32: f32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LGBTrees = api;
})(this);

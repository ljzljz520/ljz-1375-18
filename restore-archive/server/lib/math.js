'use strict';
// 配准数学库：相似 / 仿射最小二乘 / TPS 薄板样条 / 误差界限 / 坐标迁移
// 所有点统一为 {x, y}。旧照坐标 u -> 新照坐标 v。

// ---------- 线性代数（高斯-若尔当消元，带部分主元）----------
function solve(A, b) {
  const n = A.length;
  if (b.length !== n) throw new Error('solve: size mismatch');
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) {
      const err = new Error('SINGULAR_MATRIX');
      err.code = 'SINGULAR_MATRIX';
      throw err;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let k = col; k <= n; k++) M[col][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row) => row[n]);
}

// 通用线性最小二乘：min ||X p - y||，正规方程 (XtX) p = Xty
function leastSquares(X, y) {
  const rows = X.length;
  const cols = X[0].length;
  if (y.length !== rows) throw new Error('leastSquares: size mismatch');
  const XtX = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const Xty = new Array(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      Xty[i] += X[r][i] * y[r];
      for (let j = 0; j < cols; j++) XtX[i][j] += X[r][i] * X[r][j];
    }
  }
  return solve(XtX, Xty);
}

// ---------- 3x3 齐次矩阵工具（坐标迁移用）----------
function matIdentity() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}
function matMul(A, B) { // C = A * B，行主序 9 元素
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] =
        A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}
function matInv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) {
    const err = new Error('SINGULAR_TRANSFORM');
    err.code = 'SINGULAR_TRANSFORM';
    throw err;
  }
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  return [A, D, G, B, E, H, C, F, I].map((v) => v / det);
}
function applyMat(m, p) {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}
// 常用坐标矩阵
function trTranslate(tx, ty) { return [1, 0, tx, 0, 1, ty, 0, 0, 1]; }
function trScale(sx, sy) { return [sx, 0, 0, 0, sy, 0, 0, 0, 1]; }
// 顺时针 90（源画布 w x h，输出 h x w）：(x,y) -> (h-1-y, x)
function trRotateCW(w, h) { return [0, -1, h - 1, 1, 0, 0, 0, 0, 1]; }
// 180（画布 w x h）：(x,y) -> (w-1-x, h-1-y)
function trRotate180(w, h) { return [-1, 0, w - 1, 0, -1, h - 1, 0, 0, 1]; }
// 逆时针 90（源画布 w x h，输出 h x w）：(x,y) -> (y, w-1-x)
function trRotateCCW(w, h) { return [0, 1, 0, -1, 0, w - 1, 0, 0, 1]; }
// EXIF 方向（1..8）-> canonical<-raw 矩阵；需传入原图宽高。仅实现演示常用方向。
function orientationMatrix(orientation, w, h) {
  switch (orientation) {
    case 1: return matIdentity();
    case 3: return trRotate180(w, h);
    case 6: return trRotateCW(w, h);   // 顺时针90，输出 h x w
    case 8: return trRotateCCW(w, h);  // 逆时针90，输出 h x w
    default: {
      const err = new Error('ORIENTATION_UNSUPPORTED'); err.code = 'ORIENTATION_UNSUPPORTED'; throw err;
    }
  }
}
function trMirror(w) { return [-1, 0, w - 1, 0, 1, 0, 0, 0, 1]; }

// 由 crop(在某画布上的裁切矩形 x,y,w,h) 得到 规范像<-原图 平移
function trCrop(c) { return trTranslate(-c.x, -c.y); }

// ---------- 仿射最小二乘 ----------
// v = A u；行 [x y 1]；分别解 x',y' 两组系数
function affineLeastSquares(pairs) {
  if (pairs.length < 3) {
    const e = new Error('NEED_3_POINTS'); e.code = 'NEED_MORE_POINTS'; throw e;
  }
  if (collinear(pairs.map((p) => p.u))) {
    const e = new Error('POINTS_COLLINEAR'); e.code = 'POINTS_COLLINEAR'; throw e;
  }
  const X = pairs.map((p) => [p.u.x, p.u.y, 1]);
  const px = leastSquares(X, pairs.map((p) => p.v.x));
  const py = leastSquares(X, pairs.map((p) => p.v.y));
  // 3x3 齐次形式
  const M = [px[0], px[1], px[2], py[0], py[1], py[2], 0, 0, 1];
  return M;
}

// 相似变换（旋转+缩放+平移），最少 2 点：x'=a x - b y + tx, y'=b x + a y + ty
function similarityLeastSquares(pairs) {
  if (pairs.length < 2) {
    const e = new Error('NEED_2_POINTS'); e.code = 'NEED_MORE_POINTS'; throw e;
  }
  const X = pairs.map((p) => [p.u.x, -p.u.y, 1, 0]);
  // 同时解 x/y，采用拼接法：构造 4 系数
  const Xx = pairs.map((p) => [p.u.x, -p.u.y, 1, 0]);
  const Xy = pairs.map((p) => [p.u.x, p.u.y, 0, 1]);
  const Xall = [...Xx, ...Xy];
  const yall = [...pairs.map((p) => p.v.x), ...pairs.map((p) => p.v.y)];
  const s = leastSquares(Xall, yall);
  const [a, b, tx, ty] = s;
  return [a, -b, tx, b, a, ty, 0, 0, 1];
}

function collinear(pts) {
  if (pts.length < 3) return true;
  const p0 = pts[0];
  let a = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - p0.x, dy = pts[i].y - p0.y;
    if (dx === 0 && dy === 0) continue;
    if (a === null) { a = Math.atan2(dy, dx); continue; }
    if (Math.abs(normAngle(Math.atan2(dy, dx) - a)) > 1e-6) return false;
  }
  return true;
}
function normAngle(t) {
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return t;
}

// ---------- 薄板样条 TPS ----------
// 对 x 与 y 两个标量场分别求解；核 U(r)=r^2 log(r^2)
function tpsBuild(src, dst) {
  const n = src.length;
  if (n < 6) { const e = new Error('TPS_NEED_6'); e.code = 'NEED_MORE_POINTS'; throw e; }
  const U = (r2) => (r2 <= 1e-12 ? 0 : r2 * Math.log(r2));
  const L = Array.from({ length: n + 3 }, () => new Array(n + 3).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = src[i].x - src[j].x, dy = src[i].y - src[j].y;
      L[i][j] = U(dx * dx + dy * dy);
    }
    L[i][n] = 1; L[i][n + 1] = src[i].x; L[i][n + 2] = src[i].y;
    L[n][i] = 1; L[n + 1][i] = src[i].x; L[n + 2][i] = src[i].y;
  }
  const bx = src.map((_, i) => dst[i].x).concat([0, 0, 0]);
  const by = src.map((_, i) => dst[i].y).concat([0, 0, 0]);
  const wx = solve(L.map((r) => r.slice()), bx);
  const wy = solve(L.map((r) => r.slice()), by);
  return {
    src,
    wx, wy,
    map(p) {
      let x = wx[n] + wx[n + 1] * p.x + wx[n + 2] * p.y;
      let y = wy[n] + wy[n + 1] * p.x + wy[n + 2] * p.y;
      for (let k = 0; k < n; k++) {
        const dx = p.x - src[k].x, dy = p.y - src[k].y;
        const w = U(dx * dx + dy * dy);
        x += wx[k] * w; y += wy[k] * w;
      }
      return { x, y };
    },
  };
}

// ---------- 误差评估 ----------
// model: { kind:'affine'|'similarity', M } 或 { kind:'tps', map }
function mapPoint(model, p) {
  if (model.kind === 'tps') return model.map(p);
  return applyMat(model.M, p);
}
function evaluate(model, pairs, diagPx) {
  let sse = 0, maxErr = 0;
  const residuals = pairs.map((pr) => {
    const q = mapPoint(model, pr.u);
    const ex = q.x - pr.v.x, ey = q.y - pr.v.y;
    const e = Math.hypot(ex, ey);
    sse += e * e; if (e > maxErr) maxErr = e;
    return { id: pr.id, err: e, ex, ey };
  });
  const rms = Math.sqrt(sse / pairs.length);
  return {
    rms, maxErr,
    relRms: rms / diagPx,
    relMax: maxErr / diagPx,
    residuals,
  };
}

// 凸包（Andrew monotone chain）——用于界定变换“有效域”
function convexHull(pts) {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length <= 1) return p;
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lo = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- 配准主管线：模型选择 + 误差界限判定 ----------
const DEFAULT_BUDGET = { relRms: 0.005, relMax: 0.015, minAffine: 3, minTps: 6 };

function register(pairs, opts = {}) {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const diag = opts.diagPx || 1000;
  const kind = opts.kind || 'affine';
  let model;
  try {
    if (kind === 'similarity') model = { kind, M: similarityLeastSquares(pairs) };
    else if (kind === 'affine') model = { kind, M: affineLeastSquares(pairs) };
    else if (kind === 'tps') model = { kind, ...tpsBuild(pairs.map((p) => p.u), pairs.map((p) => p.v)) };
    else throw Object.assign(new Error('UNKNOWN_MODEL'), { code: 'UNKNOWN_MODEL' });
  } catch (e) {
    // 点数不足/共线/奇异 => 强制并排
    return {
      status: 'FALLBACK_SIDE_BY_SIDE',
      reason: e.code || 'SOLVE_FAILED',
      kind: 'M0',
      budget,
    };
  }
  const ev = evaluate(model, pairs, diag);
  const hull = convexHull(pairs.map((p) => p.v));
  // 残差空间聚集的简易检验：最大残差点若彼此邻近，提示系统性透视偏差
  const spatialCluster = detectResidualCluster(ev.residuals, pairs);
  const accepted =
    ev.relRms <= budget.relRms &&
    ev.relMax <= budget.relMax &&
    !spatialCluster;
  return {
    status: accepted ? 'ACCEPTED' : 'REJECTED',
    kind: accepted ? model.kind : 'M0',
    requestedKind: model.kind,
    model: accepted ? serializeModel(model) : null,
    metrics: { rms: ev.rms, maxErr: ev.maxErr, relRms: ev.relRms, relMax: ev.relMax },
    residuals: ev.residuals,
    validHull: hull,
    spatialCluster,
    budget,
    note: accepted
      ? '在控制点凸包内按声明模型可比；凸包外为外推区，不声明对齐。'
      : '超出误差界限或残差存在系统性聚集（透视/结构变化），强制退回并排观察。',
  };
}
function serializeModel(model) {
  if (model.kind === 'tps') {
    return { kind: 'tps', src: model.src, wx: model.wx, wy: model.wy };
  }
  return { kind: model.kind, M: model.M };
}
function detectResidualCluster(residuals, pairs, relBudget = 0.005) {
  if (residuals.length < 4) return false;
  const byId = new Map(pairs.map((p) => [p.id, p.v]));
  const allx = pairs.map((p) => p.v.x), ally = pairs.map((p) => p.v.y);
  const span = Math.hypot(Math.max(...allx) - Math.min(...allx), Math.max(...ally) - Math.min(...ally));
  // 显著阈值 = 整体跨度 0.1%：排除 ~1e-13 数值噪声，避免完美配准被误判聚集
  const significant = span * 0.001;
  const big = residuals
    .filter((r) => r.err > significant)
    .sort((a, b) => b.err - a.err)
    .slice(0, Math.max(2, Math.ceil(residuals.length / 3)));
  if (big.length < 2) return false;
  const pts = big.map((r) => byId.get(r.id));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const spanBig = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return spanBig < span / 3;
}

// ---------- 标注坐标迁移 ----------
// oldCanonical<-source 与 newCanonical<-source；旧规范点 -> 新规范点 = Tnew * Told^-1
function migratePoint(p, oldFromSource, newFromSource) {
  const chain = matMul(newFromSource, matInv(oldFromSource));
  return applyMat(chain, p);
}
// 迁移标注集合；无法落在新画布内则置 PENDING
function migrateAnnotations(annotations, oldFromSource, newFromSource, newDims) {
  return annotations.map((a) => {
    try {
      const np = migratePoint({ x: a.x, y: a.y }, oldFromSource, newFromSource);
      const inside = np.x >= 0 && np.y >= 0 && np.x <= newDims.w && np.y <= newDims.h;
      if (!inside) return { ...a, x: np.x, y: np.y, reviewStatus: 'PENDING', reviewReason: 'MIGRATED_OUT_OF_FRAME' };
      return { ...a, x: np.x, y: np.y, reviewStatus: 'CONFIRMED' };
    } catch (e) {
      return { ...a, reviewStatus: 'PENDING', reviewReason: e.code || 'MIGRATION_FAILED' };
    }
  });
}

module.exports = {
  solve, leastSquares,
  matIdentity, matMul, matInv, applyMat,
  trTranslate, trScale, trRotateCW, trRotate180, trRotateCCW, orientationMatrix, trMirror, trCrop,
  affineLeastSquares, similarityLeastSquares, tpsBuild,
  evaluate, convexHull, pointInPolygon, register,
  migratePoint, migrateAnnotations,
};

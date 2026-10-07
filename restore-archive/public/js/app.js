'use strict';
/* 古建筑修复对照档案 —— 前端
 * 不变量：滑杆/并排/注释引用同一照片组版本（state.snapVersion）；
 * 已批准版本可由深链接精确复现；未开放区域常驻说明不随图层消失。 */

const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: r.status, data });
  return data;
};

const state = {
  pairId: null,
  currentVersion: null,
  snapVersion: null,           // 当前检视的不可变版本（滑杆/并排/注释共用）
  snap: null,
  mode: 'slider',
  split: 50,
  layers: { old: true, new: true, added: true, notes: true },
  imgs: { old: null, new: null, imgError: { old: null, new: null } },
  picking: null,               // 'old' | 'new'
  draftAnchor: { label: '', u: null, v: null, editId: null, editVer: null },
  maskDrawing: null,           // 'added' | 'occ'
  maskStart: null,
  tileReady: { old: false, new: false },
};

// ---------- toast ----------
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- 深链接 ----------
function parseHash() {
  const h = location.hash || '';
  const m = h.match(/^#\/pair\/([^/]+)\/v\/(\d+)/);
  const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
  return {
    pairId: m ? m[1] : null,
    v: m ? Number(m[2]) : null,
    mode: params.get('mode') || 'slider',
    split: params.has('split') ? Number(params.get('split')) : 50,
    layer: params.get('layer') ? params.get('layer').split(',') : null,
  };
}
function pushHash(replace = false) {
  if (!state.pairId) return;
  const layers = Object.entries(state.layers).filter(([, on]) => on).map(([k]) => k).join(',');
  const hash = `#/pair/${state.pairId}/v/${state.snapVersion}?mode=${state.mode}&split=${state.split}&layer=${layers}`;
  if (replace) history.replaceState(null, '', hash); else history.pushState(null, '', hash);
}
window.addEventListener('hashchange', () => routeFromHash(true));

async function routeFromHash(keepImages) {
  const d = parseHash();
  if (d.pairId && (!state.pairId || state.pairId !== d.pairId || (d.v && d.v !== state.snapVersion))) {
    state.pairId = d.pairId; state.snapVersion = d.v;
    await loadPair();
  }
  if (d.mode) setMode(d.mode, true);
  if (typeof d.split === 'number') { state.split = d.split; $('splitRange').value = d.split; }
  if (d.layer) { for (const k of ['old', 'new', 'added', 'notes']) state.layers[k] = d.layer.includes(k); syncLayerChecks(); }
  draw();
}

// ---------- 载入 ----------
async function loadPair() {
  const v = state.snapVersion || undefined;
  const url = `/api/pair/${state.pairId}${v ? '?v=' + v : ''}`;
  const snap = await api('GET', url);
  state.snap = snap;
  state.currentVersion = snap.currentVersion;
  state.snapVersion = snap.version;
  // 若深链接指向历史/已批准版本，保持该版本，不自动跳到最新
  await loadImages();
  renderMeta(); renderAnchors(); renderNotes(); renderRegistration(); renderBlockers(); renderVersions(); draw();
}

async function loadImages() {
  const s = state.snap;
  for (const role of ['old', 'new']) {
    const meta = s[role];
    if (!meta) { state.imgs[role] = null; continue; }
    if (meta.license.access !== 'OK') { state.imgs.imgError[role] = meta.license.access; state.imgs[role] = null; continue; }
    await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => { state.imgs[role] = im; state.imgs.imgError[role] = null; resolve(); };
      im.onerror = () => { state.imgs[role] = null; state.imgs.imgError[role] = 'LOAD_FAILED'; resolve(); };
      im.src = `/api/photo/${meta.id}`;
    });
  }
}

// ---------- 画布 ----------
function cv() { return $('cv'); }
function geometry() {
  // 以旧照/新照共同显示区为画布（统一显示宽高仅用于叠加显示；几何可比由配准模型决定）
  const W = 720, H = 540;
  const fit = (im, meta) => {
    if (!im || !meta) return null;
    const s = Math.min(W / meta.width, H / meta.height);
    const w = meta.width * s, h = meta.height * s;
    return { sx: (W - w) / 2, sy: (H - h) / 2, s };
  };
  return { W, H, fOld: fit(state.imgs.old, state.snap && state.snap.old), fNew: fit(state.imgs.new, state.snap && state.snap.new) };
}
// 规范像坐标 -> 画布坐标（role）
function toCanvas(role, p) {
  const g = geometry(), f = role === 'old' ? g.fOld : g.fNew;
  if (!f || !p) return null;
  return { x: f.sx + p.x * f.s, y: f.sy + p.y * f.s };
}
function fromCanvas(role, p) {
  const g = geometry(), f = role === 'old' ? g.fOld : g.fNew;
  if (!f) return null;
  return { x: (p.x - f.sx) / f.s, y: (p.y - f.sy) / f.s };
}

function draw() {
  const canvas = cv(); const g = geometry();
  canvas.width = g.W; canvas.height = g.H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, g.W, g.H);
  if (!state.snap) { ctx.fillStyle = '#888'; ctx.font = '16px serif'; ctx.fillText('点击“载入演示工程”开始', 220, 260); return; }

  const reg = state.snap.registration;
  const aligned = reg && reg.status === 'ACCEPTED' && reg.model; // 仅接受的模型才允许叠加对齐
  const showOld = state.layers.old, showNew = state.layers.new;

  if (state.mode === 'side') drawSideBySide(ctx, g);
  else drawSlider(ctx, g, aligned);

  drawMasks(ctx, g);
  if (state.layers.notes) drawAnnotations(ctx, g);
  drawAnchors(ctx, g);
  drawDraft(ctx, g);
}

function drawImageCover(ctx, role, im, f) {
  if (im && f) ctx.drawImage(im, f.sx, f.sy, im.width * f.s, im.height * f.s);
  else drawPlaceholder(ctx, role, f);
}
function drawPlaceholder(ctx, role, f) {
  const g = geometry(); const box = f || { sx: 40, sy: 40, s: 1 };
  const w = f ? state.snap[role].width : g.W - 80, h = f ? state.snap[role].height : g.H - 80;
  ctx.save();
  ctx.fillStyle = '#2a2722'; ctx.fillRect(box.sx, box.sy, w * (f ? f.s : 1), h * (f ? f.s : 1));
  ctx.strokeStyle = '#7a6a45'; ctx.setLineDash([6, 5]);
  ctx.strokeRect(box.sx, box.sy, w * (f ? f.s : 1), h * (f ? f.s : 1));
  ctx.setLineDash([]); ctx.fillStyle = '#e0b07a'; ctx.font = '15px serif'; ctx.textAlign = 'center';
  const reason = state.imgs.imgError[role];
  const txt = role === 'old' ? '旧照' : '新照';
  ctx.fillText(reason === 'LICENSE_EXPIRED' ? `【${txt}】授权已过期 · 原图受限` : `【${txt}】${reason || '缺失'}`,
    box.sx + (w * (f ? f.s : 1)) / 2, box.sy + (h * (f ? f.s : 1)) / 2);
  ctx.restore();
}

function drawSlider(ctx, g, aligned) {
  // 底层新照，上层旧照按 split 裁剪。几何对齐仅在配准 ACCEPTED 时对旧照施加 model。
  // 说明：这里的叠加仅用于检视；是否“可比”由 regBanner 与模型状态显式声明。
  if (state.layers.new) { drawImageCover(ctx, 'new', state.imgs.new, g.fNew); }
  if (state.layers.old) {
    const xCut = g.W * state.split / 100;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, xCut, g.H); ctx.clip();
    if (aligned && state.imgs.old) drawOldAligned(ctx, g);
    else drawImageCover(ctx, 'old', state.imgs.old, g.fOld);
    ctx.restore();
  }
  // 分割线
  const xCut = g.W * state.split / 100;
  ctx.strokeStyle = '#f4d58a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xCut, 0); ctx.lineTo(xCut, g.H); ctx.stroke();
  ctx.fillStyle = 'rgba(244,213,138,.9)'; ctx.fillRect(xCut - 22, g.H / 2 - 16, 44, 32);
  ctx.fillStyle = '#5a3c10'; ctx.font = '18px serif'; ctx.textAlign = 'center';
  ctx.fillText('⇆', xCut, g.H / 2 + 6);
}
function drawSideBySide(ctx, g) {
  // 并排观察：左右各占一半，独立缩放，绝不宣称已对齐
  const halfW = g.W / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, halfW, g.H); ctx.clip();
  if (state.layers.old) { ctx.save(); ctx.translate(0, 0); drawImageCoverScaled(ctx, 'old', state.imgs.old, 0.5); ctx.restore(); }
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(halfW, 0, halfW, g.H); ctx.clip();
  if (state.layers.new) drawImageCoverScaled(ctx, 'new', state.imgs.new, 0.5);
  ctx.restore();
  ctx.strokeStyle = '#b3893b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(halfW, 0); ctx.lineTo(halfW, g.H); ctx.stroke();
  ctx.fillStyle = '#8c2f23'; ctx.font = '13px serif'; ctx.textAlign = 'center';
  ctx.fillText('旧照（残损）', 70, 20); ctx.fillText('新照（修复后）', halfW + 70, 20);
}
function drawImageCoverScaled(ctx, role, im, scale) {
  const W = geometry().W * scale, H = geometry().H;
  const meta = state.snap[role];
  if (!meta) { drawPlaceholder(ctx, role, null); return; }
  const s = Math.min(W / meta.width, H / meta.height);
  const w = meta.width * s, h = meta.height * s;
  const ox = role === 'new' ? geometry().W * 0.5 : 0;
  const sx = ox + (W - w) / 2, sy = (H - h) / 2;
  if (im) ctx.drawImage(im, sx, sy, w, h); else {
    ctx.save(); ctx.translate(ox, 0);
    drawPlaceholder(ctx, role, { sx: (W - w) / 2, sy, s }); ctx.restore();
  }
}

// 在画布上用仿射/相似/TPS 绘制旧照（逐小网格变换，避免把新增构件“拉成旧结构”——
// 新增结构遮罩区域不参与对应，且新增区域本身只画新照）
function drawOldAligned(ctx, g) {
  const reg = state.snap.registration;
  const oldMeta = state.snap.old, im = state.imgs.old;
  if (!im || !reg || !reg.model) { drawImageCover(ctx, 'old', im, g.fOld); return; }
  if (reg.model.kind === 'tps') {
    // TPS 反演复杂，演示中若为 tps 则退化为网格近似：用正向映射的逆（牛顿迭代）。
    drawWarpedTps(ctx, im, oldMeta, g, reg);
    return;
  }
  const M = reg.model.M; // old canonical(px) -> new canonical(px)
  const ns = g.fNew.s; // 新照显示比例
  // 构造 new-canvas <- old-canonical：C = Tnew_disp * M
  const tr = (p) => {
    const w = M[6] * p.x + M[7] * p.y + M[8];
    const nx = (M[0] * p.x + M[1] * p.y + M[2]) / w;
    const ny = (M[3] * p.x + M[4] * p.y + M[5]) / w;
    return { x: g.fNew.sx + nx * ns, y: g.fNew.sy + ny * ns };
  };
  drawWarpedGrid(ctx, im, oldMeta, tr, 40);
}
function drawWarpedGrid(ctx, im, oldMeta, mapFn, cell) {
  // 每个源小块用由三个角点确定的局部仿射绘制；全局模型已在 mapFn 中。
  for (let y = 0; y < oldMeta.height; y += cell) {
    for (let x = 0; x < oldMeta.width; x += cell) {
      const x2 = Math.min(x + cell, oldMeta.width), y2 = Math.min(y + cell, oldMeta.height);
      const p0 = mapFn({ x, y }), p1 = mapFn({ x: x2, y }), p3 = mapFn({ x, y: y2 });
      const A = affineFromTri({ x, y }, { x: x2, y }, { x, y: y2 }, p0, p1, p3);
      ctx.save(); ctx.globalAlpha = 0.96;
      ctx.setTransform(A[0], A[3], A[1], A[4], A[2], A[5]);
      ctx.drawImage(im, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.restore();
    }
  }
}
function affineFromTri(s0, s1, s2, d0, d1, d2) {
  const S = [[s0.x, s0.y, 1], [s1.x, s1.y, 1], [s2.x, s2.y, 1]];
  const inv = inv3(S);
  const dx = [d0.x, d1.x, d2.x], dy = [d0.y, d1.y, d2.y];
  const cx = mv(inv, dx), cy = mv(inv, dy);
  return [cx[0], cx[1], cx[2], cy[0], cy[1], cy[2]];
}
function inv3(m) {
  const a = m.flat(); const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = a;
  const A = r4 * r8 - r5 * r7, B = -(r3 * r8 - r5 * r6), C = r3 * r7 - r4 * r6;
  const det = r0 * A + r1 * B + r2 * C;
  const D = -(r1 * r8 - r2 * r7), E = r0 * r8 - r2 * r6, F = -(r0 * r7 - r1 * r6);
  const G = r1 * r5 - r2 * r4, H = -(r0 * r5 - r2 * r3), I = r0 * r4 - r1 * r3;
  return [A, D, G, B, E, H, C, F, I].map((v) => v / det);
}
function mv(inv, col) {
  const out = [];
  for (let r = 0; r < 3; r++) out.push(inv[r * 3] * col[0] + inv[r * 3 + 1] * col[1] + inv[r * 3 + 2] * col[2]);
  return out;
}
function drawWarpedTps(ctx, im, oldMeta, g, reg) {
  // TPS：用保存的权重在前端重建 map，正向映射源网格
  const m = reg.model;
  const U = (r2) => (r2 <= 1e-12 ? 0 : r2 * Math.log(r2));
  const map = (p) => {
    let x = m.wx[m.src.length] + m.wx[m.src.length + 1] * p.x + m.wx[m.src.length + 2] * p.y;
    let y = m.wy[m.src.length] + m.wy[m.src.length + 1] * p.x + m.wy[m.src.length + 2] * p.y;
    for (let k = 0; k < m.src.length; k++) {
      const dx = p.x - m.src[k].x, dy = p.y - m.src[k].y, w = U(dx * dx + dy * dy);
      x += m.wx[k] * w; y += m.wy[k] * w;
    }
    return { x: g.fNew.sx + x * g.fNew.s, y: g.fNew.sy + y * g.fNew.s };
  };
  // 反演：对目标网格点做固定点逆（演示简化为最近源点 + 小步牛顿），这里直接正向小网格并用仿射块
  const cell = 24;
  for (let y = 0; y < oldMeta.height; y += cell)
    for (let x = 0; x < oldMeta.width; x += cell) {
      const x2 = Math.min(x + cell, oldMeta.width), y2 = Math.min(y + cell, oldMeta.height);
      const p0 = map({ x, y }), p1 = map({ x: x2, y }), p3 = map({ x, y: y2 });
      const A = affineFromTri({ x, y }, { x: x2, y }, { x, y: y2 }, p0, p1, p3);
      ctx.save(); ctx.globalAlpha = 0.95;
      ctx.setTransform(A[0], A[3], A[1], A[4], A[2], A[5]);
      ctx.drawImage(im, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.restore();
    }
}

// ---------- 遮罩 / 标注 / 锚点绘制 ----------
function drawMasks(ctx, g) {
  const masks = state.snap.masks || {};
  const drawPoly = (poly, role, fill, stroke) => {
    const pts = poly.map((p) => toCanvas(role, p)).filter(Boolean);
    if (pts.length < 2) return;
    ctx.save(); ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach((p) => ctx.lineTo(p.x, p.y)); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  };
  if (state.layers.added) (masks.addedStructure || []).forEach((p) => drawPoly(p, 'new', 'rgba(214,158,60,.28)', '#d69e3c'));
  (masks.occlusions || []).forEach((p) => drawPoly(p, 'new', 'rgba(90,90,90,.22)', '#777'));
}
function drawAnnotations(ctx, g) {
  (state.snap.annotations || []).forEach((a) => {
    if (a.reviewStatus === 'PENDING') return; // 待复核不在图上显示定位（文字仍在面板/常驻区）
    const role = a.layer === 'old' ? 'old' : 'new';
    const p = toCanvas(role, a); if (!p) return;
    // 并排时新照侧加偏移
    const pp = state.mode === 'side' && role === 'new' ? { x: p.x + g.W / 2, y: p.y } : p;
    ctx.save();
    ctx.fillStyle = a.pinnedRestricted ? '#a5281f' : '#1d5a8c';
    ctx.beginPath(); ctx.arc(pp.x, pp.y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,253,245,.92)';
    const label = (a.pinnedRestricted ? '⛔' : '') + (a.text || '').slice(0, 10);
    ctx.font = '12px serif'; ctx.textAlign = 'left';
    ctx.fillRect(pp.x + 7, pp.y - 8, ctx.measureText(label).width + 8, 16);
    ctx.fillStyle = a.pinnedRestricted ? '#a5281f' : '#1d3f5a'; ctx.fillText(label, pp.x + 11, pp.y + 4);
    ctx.restore();
  });
}
function drawAnchors(ctx, g) {
  state.snap.anchors.forEach((a) => {
    for (const [role, key] of [['old', 'u'], ['new', 'v']]) {
      if (!a[key]) continue;
      let p = toCanvas(role, a[key]); if (!p) continue;
      if (state.mode === 'side' && role === 'new') p = { x: p.x + g.W / 2, y: p.y };
      ctx.save();
      ctx.fillStyle = a.reviewStatus === 'PENDING' ? '#c07a2c' : '#1d8f4f';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#123'; ctx.font = '9px serif'; ctx.textAlign = 'center';
      ctx.fillText('×', p.x, p.y + 3);
      ctx.fillStyle = '#fff'; ctx.font = '11px serif';
      ctx.fillText(a.label || a.id.slice(-3), p.x, p.y - 9);
      ctx.restore();
    }
  });
}
function drawDraft(ctx, g) {
  const d = state.draftAnchor;
  if (state.picking) {
    ctx.save(); ctx.fillStyle = 'rgba(255,230,150,.9)'; ctx.font = '14px serif';
    ctx.fillText(`请在${state.picking === 'old' ? '旧照(左)' : '新照(右)'}上点击选取结构点`, 16, g.H - 16); ctx.restore();
  }
  // 遮罩拖框
  if (state.maskDrawing && state.maskStart && state.maskNow) {
    ctx.save(); ctx.strokeStyle = state.maskDrawing === 'added' ? '#d69e3c' : '#888'; ctx.setLineDash([5, 4]); ctx.lineWidth = 2;
    ctx.strokeRect(state.maskStart.x, state.maskStart.y, state.maskNow.x - state.maskStart.x, state.maskNow.y - state.maskStart.y);
    ctx.restore();
  }
}

// ---------- 交互 ----------
function canvasEventPoint(ev) {
  const c = cv().getBoundingClientRect();
  const x = (ev.clientX - c.left) * (cv().width / c.width);
  const y = (ev.clientY - c.top) * (cv().height / c.height);
  return { x, y };
}
cv().addEventListener('click', (ev) => {
  if (!state.snap) return;
  const p = canvasEventPoint(ev);
  if (state.picking) {
    // 判定点在哪一侧（并排以中线分；滑杆以分割线判当前偏好——旧照左、新照右）
    let role = state.picking;
    let cp = p;
    if (state.mode === 'side') {
      role = p.x < cv().width / 2 ? 'old' : 'new';
      if (role === 'new') cp = { x: p.x - cv().width / 2, y: p.y };
    }
    const canon = fromCanvas(role, cp);
    if (!canon) return toast('该侧图像尚未就绪');
    if (state.picking === 'old') state.draftAnchor.u = canon; else state.draftAnchor.v = canon;
    state.picking = null; $('pickHint').textContent = '';
    draw();
  }
});
// 遮罩拖框（新照侧）
cv().addEventListener('mousedown', (ev) => {
  if (!state.maskDrawing || !state.snap) return;
  state.maskStart = canvasEventPoint(ev); state.maskNow = state.maskStart;
});
cv().addEventListener('mousemove', (ev) => { if (state.maskStart) { state.maskNow = canvasEventPoint(ev); draw(); } });
cv().addEventListener('mouseup', async () => {
  if (!state.maskDrawing || !state.maskStart) return;
  const g = geometry();
  const a = state.maskStart, b = state.maskNow;
  // 转换到新照规范坐标（滑杆下以新照显示框为准）
  const tl = fromCanvas('new', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) });
  const br = fromCanvas('new', { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) });
  state.maskStart = null; state.maskNow = null;
  if (!tl || !br) return;
  const poly = [tl, { x: br.x, y: tl.y }, br, { x: tl.x, y: br.y }];
  const key = state.maskDrawing === 'added' ? 'addedStructure' : 'occlusions';
  state.maskDrawing = null;
  const r = await api('POST', `/api/pair/${state.pairId}/masks`, {
    baseVersion: state.currentVersion, masks: { [key]: [...(state.snap.masks[key] || []), poly] }, editor: 'editor',
  });
  await bumpVersion(r.version);
  toast(key === 'addedStructure' ? '已标记新增构件（只标记不变形）' : '已标记遮挡区（不参与配准）');
});

// ---------- 控件 ----------
document.querySelectorAll('.mode-switch .seg').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(m, silent) {
  state.mode = m;
  document.querySelectorAll('.mode-switch .seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('viewer').className = 'viewer mode-' + m;
  $('sliderBar').style.display = m === 'side' ? 'none' : 'block';
  if (!silent) pushHash();
  draw();
}
$('splitRange').addEventListener('input', () => { state.split = Number($('splitRange').value); pushHash(true); draw(); });
['old', 'new', 'added', 'notes'].forEach((k) => {
  $('layer' + k[0].toUpperCase() + k.slice(1)).addEventListener('change', (ev) => {
    state.layers[k] = ev.target.checked;
    if (k === 'notes') renderNotes(); // 常驻说明不消失逻辑在 renderNotes
    pushHash(true); draw();
  });
});
function syncLayerChecks() {
  $('layerOld').checked = state.layers.old; $('layerNew').checked = state.layers.new;
  $('layerAdded').checked = state.layers.added; $('layerNotes').checked = state.layers.notes;
}

$('btnSeed').addEventListener('click', async () => {
  const d = await api('POST', '/api/demo/seed', {});
  state.pairId = d.pairId; state.snapVersion = null;
  location.hash = `#/pair/${d.pairId}/v/1?mode=slider&layer=old,new,added,notes`;
  await routeFromHash();
  toast('演示工程已创建：旧照(1952) 与 新照(2026)，含残损、新增斗拱、遮挡与视点差异');
});

document.querySelectorAll('.stage-row .seg').forEach((b) => b.addEventListener('click', async () => {
  if (!state.pairId) return;
  const r = await api('POST', `/api/pair/${state.pairId}/stage`, { baseVersion: state.currentVersion, stage: b.dataset.stage, editor: 'editor' });
  await bumpVersion(r.version); toast('阶段已更新：' + b.dataset.stage);
}));

// 锚点
$('btnPickOld').addEventListener('click', () => { state.picking = 'old'; setMode('side', true); $('pickHint').textContent = '在旧照上点击'; });
$('btnPickNew').addEventListener('click', () => { state.picking = 'new'; setMode('side', true); $('pickHint').textContent = '在新照上点击'; });
$('btnSaveAnchor').addEventListener('click', async () => {
  const d = state.draftAnchor;
  const label = $('anchorLabel').value.trim();
  if (!d.u || !d.v) return toast('需要先在旧照和新照各取一个点');
  try {
    const r = await api('POST', `/api/pair/${state.pairId}/anchor`, {
      anchorId: d.editId || undefined, anchorVersion: d.editVer,
      baseVersion: state.currentVersion, label: label || '锚点', u: d.u, v: d.v, editor: 'editor',
    });
    state.draftAnchor = { label: '', u: null, v: null, editId: null, editVer: null };
    $('anchorLabel').value = '';
    await bumpVersion(r.version);
    toast('锚点已保存（版本 ' + r.version + '）');
  } catch (e) {
    if (e.status === 409 && e.data && e.data.anchor) {
      toast('冲突：该锚点已被另一编辑修改（版本 ' + e.data.anchor.version + '），请核对后合并，未覆盖对方修改', 5200);
    } else toast(e.message);
  }
});

// 配准
$('btnPreviewReg').addEventListener('click', () => runReg(false));
$('btnSaveReg').addEventListener('click', () => runReg(true));
async function runReg(save) {
  const kind = $('regKind').value;
  try {
    const url = `/api/pair/${state.pairId}/${save ? 'register' : 'register/preview'}`;
    const r = save
      ? (await api('POST', url, { baseVersion: state.currentVersion, kind, editor: 'editor' })).registration
      : await api('POST', url, { baseVersion: state.snapVersion, kind });
    showRegResult(r);
    if (save) { await bumpVersion(state.currentVersion + 1); state.snap.registration = r; renderRegistration(); draw(); }
  } catch (e) { toast(e.message); }
}
function showRegResult(r) {
  const box = $('regResult');
  if (r.status === 'FALLBACK_SIDE_BY_SIDE') {
    box.innerHTML = `<span class="no">强制退回并排（M0）</span>\n原因：${r.reason}\n` +
      (r.reason === 'NEED_MORE_POINTS' ? '基准点不足：请增加非共线对应点。' : '');
    return;
  }
  const m = r.metrics;
  const stl = r.status === 'ACCEPTED' ? '<span class="ok">ACCEPTED 可比</span>' : '<span class="no">REJECTED 不可比→并排</span>';
  box.innerHTML =
    `模型：${r.requestedKind}　状态：${stl}\n` +
    `RMS=${m.rms.toFixed(2)}px　max=${m.maxErr.toFixed(2)}px\n` +
    `相对RMS=${(m.relRms * 100).toFixed(3)}% (限0.5%)　相对max=${(m.relMax * 100).toFixed(3)}% (限1.5%)\n` +
    `残差空间聚集：${r.spatialCluster ? '是（提示透视/结构差异，仿射不适用）' : '否'}\n` +
    `使用锚点：${r.usedAnchors.length}　排除(遮罩)：${r.excludedAnchors.length}\n` +
    `视点提示：${(r.photoMeta.viewpointNote || ['无显著元数据差异']).join('；')}\n` +
    `说明：${r.note}`;
}

// 遮罩按钮
$('btnMaskAdded').addEventListener('click', () => { state.maskDrawing = 'added'; toast('在新照上拖出“新增构件”矩形'); });
$('btnMaskOcc').addEventListener('click', () => { state.maskDrawing = 'occ'; toast('在新照上拖出“遮挡”矩形（脚手架/树木）'); });

// 变换：旋转迁移 / 翻转待复核
$('btnRotate').addEventListener('click', async () => {
  const meta = state.snap.old;
  const r = await api('POST', `/api/pair/${state.pairId}/remap`, {
    baseVersion: state.currentVersion, role: 'old',
    next: { orientation: 6, sourceWidth: meta.height, sourceHeight: meta.width },
    editor: 'editor',
  });
  await bumpVersion(r.version);
  toast('已对旧照应用旋转变换并迁移标注坐标');
});
$('btnFlip').addEventListener('click', async () => {
  const r = await api('POST', `/api/pair/${state.pairId}/remap`, {
    baseVersion: state.currentVersion, role: 'old', next: { ambiguousFlip: true }, editor: 'editor',
  });
  await bumpVersion(r.version);
  toast('图像翻转无法唯一确定变换：所有锚点/标注进入待复核', 4500);
});
$('btnReplaceNew').addEventListener('click', async () => {
  const r = await api('POST', `/api/pair/${state.pairId}/photo/new`, {
    baseVersion: state.currentVersion, useSample: true,
    capture: { date: '2026-10-07', camera: '全画幅数字', focalMm: 50, lighting: '正午', gps: { lat: 34.2532, lng: 108.9483 } },
    license: { holder: '本院勘察室', scope: 'internal', expiresAt: null, status: 'VALID' },
    editor: 'editor',
  });
  await bumpVersion(r.version);
  toast('新照已替换（晚到资源/换图）：该侧锚点进入待复核，旧瓦片作废', 4500);
});
$('btnExpireOld').addEventListener('click', async () => {
  await api('POST', `/api/photo/${state.snap.old.id}/expire-license`, {});
  await loadPair();
  toast('旧照授权已过期：原图受限，但已批准快照结论文字与保留瓦片仍可访问', 4800);
});

// 注释
$('btnAddNote').addEventListener('click', async () => {
  const text = $('noteText').value.trim(); if (!text) return;
  const pinned = $('notePinned').checked;
  // 未指定坐标时放到新照中央
  const r = await api('POST', `/api/pair/${state.pairId}/annotation`, {
    baseVersion: state.currentVersion, x: state.snap.new.width / 2, y: state.snap.new.height / 2,
    text, layer: 'new', pinnedRestricted: pinned, editor: 'editor',
  });
  $('noteText').value = ''; $('notePinned').checked = false;
  await bumpVersion(r.version);
});

// 瓦片
$('btnTiles').addEventListener('click', async () => {
  await api('POST', `/api/pair/${state.pairId}/tiles`, { baseVersion: state.currentVersion });
  toast('瓦片任务已入队（服务端异步生成，受解码预算/并发限制）');
  pollTiles();
});
async function pollTiles() {
  let tries = 0;
  const iv = setInterval(async () => {
    tries++;
    const d = await api('GET', `/api/pair/${state.pairId}/tiles?v=${state.currentVersion}`);
    const jobs = (d.tileSet && d.tileSet.jobs) || {};
    const parts = Object.entries(jobs).map(([role, j]) => `${role}:${j.status}${j.error ? '(' + j.error + ')' : ''}`);
    $('tileMini').textContent = parts.join(' / ');
    $('tileStatus').textContent = parts.length ? '瓦片 ' + parts.join(' · ') : '';
    const done = Object.values(jobs).every((j) => ['READY', 'FAILED', 'SUPERSEDED', 'REJECTED_RESOURCE_LIMIT'].includes(j.status));
    if (done || tries > 20) { clearInterval(iv); if (done) { state.snap.tileSet = d.tileSet; draw(); } }
  }, 500);
}

// 批准
$('btnApprove').addEventListener('click', async () => {
  try {
    const r = await api('POST', `/api/pair/${state.pairId}/approve`, {
      version: state.currentVersion, reviewer: $('reviewer').value || '审查员', note: $('approveNote').value,
    });
    toast('已批准版本 ' + r.version + '，快照冻结，深链接可复现');
    await loadPair();
  } catch (e) {
    if (e.status === 412) toast('无法批准：' + (e.data.blockers || []).join('，'), 5000);
    else toast(e.message);
  }
});

// 并发冲突演示：后台“第二个编辑”先改锚点，再用旧版本号提交
$('btnConflict').addEventListener('click', async () => {
  const a = state.snap.anchors[0]; if (!a) return toast('请先保存至少一个锚点');
  // 编辑者乙先改
  await api('POST', `/api/pair/${state.pairId}/anchor`, {
    anchorId: a.id, anchorVersion: a.version, baseVersion: state.currentVersion,
    label: a.label + '(乙改)', u: a.u, v: { x: a.v.x + 6, y: a.v.y }, editor: 'editor-乙',
  });
  // 甲仍基于旧版本号提交 -> 期望 409
  try {
    await api('POST', `/api/pair/${state.pairId}/anchor`, {
      anchorId: a.id, anchorVersion: a.version, baseVersion: state.currentVersion,
      label: a.label + '(甲改)', u: a.u, v: a.v, editor: 'editor-甲',
    });
    toast('意外：未检测到冲突');
  } catch (e) {
    if (e.status === 409) toast('已拦截：乙已先改该锚点，甲的提交返回409，需三方合并（未覆盖）', 5200);
  }
  await loadPair();
});

// 复制深链接
$('btnCopyLink').addEventListener('click', () => {
  pushHash(true);
  navigator.clipboard?.writeText(location.href).then(() => toast('已复制深链接（精确到版本/视图/图层）')).catch(() => toast(location.href));
});

// ---------- 渲染面板 ----------
function renderMeta() {
  const s = state.snap;
  $('gvLabel').textContent = `${s.pairId.slice(-5)} v${s.version}${s.version !== s.currentVersion ? `（查看历史，最新 v${s.currentVersion}）` : ''}`;
  const st = $('gvStatus'); st.textContent = s.status; st.className = 'badge ' + s.status.toLowerCase();
  const stg = $('gvStage'); stg.textContent = s.stage;
  $('flagOld').hidden = !(s.old && s.old.license.access !== 'OK');
  $('flagNew').hidden = !(s.new && s.new.license.access !== 'OK');
  $('flagOld').textContent = '旧照：' + (s.old ? s.old.license.access : '缺失');
  $('flagNew').textContent = '新照：' + (s.new ? s.new.license.access : '缺失');
}
function renderAnchors() {
  const ul = $('anchorList'); ul.innerHTML = '';
  state.snap.anchors.forEach((a) => {
    const li = document.createElement('li');
    li.className = a.reviewStatus === 'PENDING' ? 'a-pending' : '';
    li.innerHTML = `<span>${a.label} ${a.reviewStatus === 'PENDING' ? '⏳待复核(' + (a.reviewReason || '') + ')' : ''}</span><span>v${a.version}</span>`;
    li.style.cursor = 'pointer';
    li.title = '点击载入以编辑（携带版本号）';
    li.onclick = () => {
      $('anchorLabel').value = a.label;
      state.draftAnchor = { label: a.label, u: a.u, v: a.v, editId: a.id, editVer: a.version };
      toast('已载入锚点 ' + a.label + '（编辑基于 v' + a.version + '）');
    };
    ul.appendChild(li);
  });
}
function renderNotes() {
  const s = state.snap;
  $('notesVersionTag').textContent = `（引用照片组 v${s.version}）`;
  const ul = $('notesList'); ul.innerHTML = '';
  // 未开放区域常驻说明：无论 notes 图层开关如何，始终列在独立面板
  const pinned = (s.annotations || []).filter((a) => a.pinnedRestricted);
  const rp = $('restrictedPanel');
  rp.hidden = pinned.length === 0;
  $('restrictedList').innerHTML = pinned.map((a) => `<li>${escapeHtml(a.text)} <small>(${a.reviewStatus === 'PENDING' ? '待复核' : '已确认'})</small></li>`).join('');
  (s.annotations || []).forEach((a) => {
    const li = document.createElement('li');
    li.innerHTML = `${a.pinnedRestricted ? '<span class="pin-tag">常驻受限</span>' : ''}${a.reviewStatus === 'PENDING' ? '<span class="pending-tag">待复核</span>' : ''}<span>${escapeHtml(a.text)}</span>`;
    ul.appendChild(li);
  });
}
function renderRegistration() {
  const r = state.snap.registration;
  const b = $('regBanner');
  if (!r) { b.className = 'reg-banner'; b.textContent = '尚未配准：默认并排观察，不宣称几何可比。'; return; }
  if (r.status === 'ACCEPTED') {
    b.className = 'reg-banner accepted';
    b.textContent = `已配准（${r.kind}）：相对RMS ${(r.metrics.relRms * 100).toFixed(3)}%、相对max ${(r.metrics.relMax * 100).toFixed(3)}%，仅控制点凸包内可比；凸包外为外推区。`;
    showRegResult(r);
  } else if (r.status === 'FALLBACK_SIDE_BY_SIDE') {
    b.className = 'reg-banner rejected'; b.textContent = '配准条件不足（' + r.reason + '）：强制并排观察。';
  } else {
    b.className = 'reg-banner rejected';
    b.textContent = `配准被拒绝（超误差界限/残差聚集）：退回并排观察。不得把两图强行对齐。`;
    showRegResult(r);
  }
}
function renderBlockers() {
  const ul = $('blockerList');
  const b = state.snap.blockers || [];
  ul.innerHTML = b.length
    ? b.map((x) => `<li>⛔ ${blockerText(x)}</li>`).join('')
    : '<li class="clear">✓ 资源齐全、授权有效、无待复核标注，可批准</li>';
}
function blockerText(code) {
  return ({
    INCOMPLETE_SIDE: '一侧照片晚到/缺失，无法配准批准',
    OLD_LICENSE_EXPIRED: '旧照授权过期（结论可存档，原图受限）',
    NEW_LICENSE_EXPIRED: '新照授权过期',
    PENDING_ANNOTATIONS: '存在待复核标注（需人工确认迁移）',
    REGISTRATION_REJECTED: '配准未通过误差界限（请退回并排或修正锚点）',
  })[code] || code;
}
function renderVersions() {
  const box = $('versionList'); box.innerHTML = '';
  state.snap.versions.forEach((vv) => {
    const c = document.createElement('span');
    c.className = 'version-chip' + (vv.approved ? ' approved' : '') + (vv.version === state.snapVersion ? ' current' : '');
    c.textContent = 'v' + vv.version + (vv.approved ? '✓批准' : '');
    c.onclick = () => { location.hash = `#/pair/${state.pairId}/v/${vv.version}?mode=${state.mode}&split=${state.split}&layer=${Object.keys(state.layers).filter((k) => state.layers[k]).join(',')}`; };
    box.appendChild(c);
  });
}
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 编辑产生新版本后：若正在检视已批准快照则不跳走；否则跟进最新
async function bumpVersion(v) {
  const viewingApprovedHistory = state.snap && state.snap.approval && state.snap.version !== state.currentVersion;
  state.snapVersion = viewingApprovedHistory ? state.snapVersion : v;
  await loadPair();
  if (!viewingApprovedHistory) pushHash(true);
}

// 启动
syncLayerChecks();
routeFromHash();

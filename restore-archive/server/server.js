'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { Store } = require('./lib/store');
const { Service } = require('./lib/service');
const { TileQueue } = require('./lib/tiler');
const png = require('./lib/png');
const sample = require('./lib/sample-data');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const IMGDIR = path.join(DATA, 'images');
const TILEDIR = path.join(DATA, 'tiles');
const PUB = path.join(ROOT, 'public');
const PORT = process.env.PORT || 8080;

fs.mkdirSync(IMGDIR, { recursive: true });
fs.mkdirSync(TILEDIR, { recursive: true });

const store = new Store(DATA);
const service = new Service(store);
const tiles = new TileQueue(store, { dataDir: IMGDIR, tileRoot: TILEDIR,
  limits: { maxDecodePixels: Number(process.env.MAX_DECODE_PIXELS) || 8000 * 8000 } });

// ---------- helpers ----------
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limitBytes) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 })); req.destroy(); } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(Object.assign(new Error('BAD_JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function errRes(res, e) { send(res, e.status || 500, { error: e.code || 'ERROR', message: e.message, ...(e.currentVersion ? { currentVersion: e.currentVersion } : {}), ...(e.anchor ? { anchor: e.anchor } : {}), ...(e.blockers ? { blockers: e.blockers } : {}) }); }

// 写一张上传图（演示：接收 base64 或选用内置合成图）
function importImageBuffer(buf, meta) {
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const name = sha.slice(0, 16) + '.png';
  fs.writeFileSync(path.join(IMGDIR, name), buf);
  // 读尺寸（PNG IHDR）
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const ph = store.addPhoto({
    sha256: sha, file: name, width: w, height: h,
    orientation: meta.orientation || 1,
    sourceTransform: meta.sourceTransform || [1, 0, 0, 0, 1, 0, 0, 0, 1],
    capture: meta.capture || {},
    license: meta.license || { holder: '未登记', scope: 'internal', expiresAt: null, status: 'VALID' },
  });
  return ph;
}

// 图床：授权过期则不给原图字节，返回 403 + 占位元数据（瓦片缓存另算）
function photoAccessible(photo) {
  if (!photo) return { ok: false, code: 'PHOTO_GONE' };
  if (photo.license.status !== 'VALID') return { ok: false, code: 'LICENSE_' + photo.license.status };
  if (photo.license.expiresAt && Date.parse(photo.license.expiresAt) < Date.now()) return { ok: false, code: 'LICENSE_EXPIRED' };
  return { ok: true };
}

// ---------- routes ----------
const routes = {
  // 初始化演示数据
  'POST /api/demo/seed': async (req, res) => {
    const oldBuf = png.encode(sample.makeOld());
    const newBuf = png.encode(sample.makeNew());
    const oldPh = importImageBuffer(oldBuf, {
      capture: { date: '1952-04-11', camera: '禄来双反', focalMm: 75, lighting: '阴天散射', gps: { lat: 34.253, lng: 108.948 } },
      license: { holder: '历史影像馆', scope: 'archive', expiresAt: null, status: 'VALID' },
    });
    const newPh = importImageBuffer(newBuf, {
      capture: { date: '2026-09-30', camera: '全画幅数字', focalMm: 50, lighting: '晴天侧光', gps: { lat: 34.2531, lng: 108.9481 } },
      license: { holder: '本院勘察室', scope: 'internal', expiresAt: null, status: 'VALID' },
    });
    const proj = store.createProject({ name: '某府文庙大成殿修复工程' });
    const { pairId } = store.createPair({ projectId: proj.id, stage: 'BEFORE', oldPhotoId: oldPh.id, newPhotoId: newPh.id });
    send(res, 200, { projectId: proj.id, pairId, oldPhotoId: oldPh.id, newPhotoId: newPh.id });
  },

  'GET /api/projects': async (req, res, q) => {
    send(res, 200, store.list().projects.map((p) => ({ ...p, pairCount: p.pairs.length })));
  },

  // 新建项目
  'POST /api/projects': async (req, res) => {
    const body = await readBody(req);
    send(res, 200, store.createProject({ name: body.name || '未命名工程' }));
  },

  // 新建照片对。允许只给一侧（另一侧资源晚到）=> INCOMPLETE，只能标注不能配准/批准。
  'POST /api/pairs': async (req, res) => {
    const body = await readBody(req);
    if (!body.projectId || !store.getProject(body.projectId)) return send(res, 400, { error: 'PROJECT_REQUIRED' });
    const r = store.createPair({
      projectId: body.projectId, stage: body.stage || 'BEFORE',
      oldPhotoId: body.oldPhotoId || null, newPhotoId: body.newPhotoId || null,
    });
    send(res, 200, { pairId: r.pairId, version: 1, status: store.statusOf(r.snapshot) });
  },

  'GET /api/pair/:id': async (req, res, q) => {
    const snap = store.getVersion(req.params.id, q.v ? Number(q.v) : undefined);
    if (!snap) return send(res, 404, { error: 'VERSION_NOT_FOUND' });
    const pair = store.getPair(req.params.id);
    const decorate = (phId) => {
      const ph = store.getPhoto(phId);
      if (!ph) return null;
      const access = photoAccessible(ph);
      return { id: ph.id, width: ph.width, height: ph.height, orientation: ph.orientation,
               capture: ph.capture, license: { ...ph.license, access: access.ok ? 'OK' : access.code } };
    };
    send(res, 200, {
      pairId: pair.id, currentVersion: pair.currentVersion,
      version: snap.version,
      status: store.statusOf(snap),
      stage: snap.stage,
      old: decorate(snap.oldPhotoId), new: decorate(snap.newPhotoId),
      anchors: snap.anchors, annotations: snap.annotations, masks: snap.masks,
      registration: snap.registration, tileSet: snap.tileSet, approval: snap.approval,
      blockers: store.approvalBlockers(snap),
      versions: pair.versions.map((vv) => ({ version: vv.version, approved: !!vv.approval, createdAt: vv.createdAt })),
    });
  },

  // 原图字节（授权门）
  'GET /api/photo/:id': async (req, res) => {
    const ph = store.getPhoto(req.params.id);
    if (!ph) return send(res, 404, { error: 'PHOTO_GONE' });
    const access = photoAccessible(ph);
    if (!access.ok) return send(res, 403, { error: access.code, placeholder: true });
    const buf = fs.readFileSync(path.join(IMGDIR, ph.file));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(buf);
  },

  // 瓦片（已批准快照的瓦片即使授权过期仍可访问——档案保留）
  'GET /api/tile': async (req, res, q) => {
    const snap = store.getVersion(q.pair, q.v ? Number(q.v) : undefined);
    if (!snap) return send(res, 404, { error: 'VERSION_NOT_FOUND' });
    const role = q.role, z = q.z, x = q.x, y = q.y;
    const job = snap.tileSet && snap.tileSet.jobs && snap.tileSet.jobs[role];
    if (!job || job.status !== 'READY') return send(res, 409, { error: 'TILES_NOT_READY', status: job && job.status });
    const retain = snap.approval && job.meta && true;
    // 未批准时校验授权；已批准快照走保留策略
    if (!snap.approval) {
      const ph = store.getPhoto(role === 'old' ? snap.oldPhotoId : snap.newPhotoId);
      if (!photoAccessible(ph).ok) return send(res, 403, { error: 'LICENSE_EXPIRED' });
    }
    const file = path.join(TILEDIR, job.meta.dir, `${z}-${x}-${y}.png`);
    if (!fs.existsSync(file)) return send(res, 404, { error: 'TILE_NOT_FOUND' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': retain ? 'public, max-age=31536000, immutable' : 'no-store' });
    res.end(fs.readFileSync(file));
  },

  'POST /api/pair/:id/photo/:role': async (req, res, q) => {
    const body = await readBody(req, 8 * 1024 * 1024);
    let ph;
    if (body.useSample) {
      const buf = png.encode(req.params.role === 'old' ? sample.makeOld() : sample.makeNew());
      ph = importImageBuffer(buf, { capture: body.capture || {}, license: body.license });
    } else if (body.pngBase64) {
      ph = importImageBuffer(Buffer.from(body.pngBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
        { capture: body.capture, license: body.license, orientation: body.orientation, sourceTransform: body.sourceTransform });
    } else return send(res, 400, { error: 'NO_IMAGE' });
    const cur = store.getPair(req.params.id).currentVersion;
    const r = store.edit(req.params.id, cur, (d) => {
      if (req.params.role === 'old') d.oldPhotoId = ph.id; else d.newPhotoId = ph.id;
      // 换图：该侧坐标不可信 -> 该侧锚点待复核
      d.anchors = d.anchors.map((a) => ({ ...a, reviewStatus: 'PENDING', reviewReason: 'PHOTO_REPLACED' }));
      d.registration = null;
    }, body.editor || 'editor');
    send(res, 200, { version: r.version, photoId: ph.id });
  },

  'POST /api/pair/:id/stage': async (req, res) => {
    const body = await readBody(req);
    const r = service.setStage(req.params.id, body.baseVersion, body.stage, body.editor);
    send(res, 200, { version: r.version, stage: body.stage });
  },

  // 锚点保存（乐观锁）
  'POST /api/pair/:id/anchor': async (req, res) => {
    const body = await readBody(req);
    try {
      const r = store.saveAnchor(req.params.id, body.baseVersion, {
        id: body.anchorId, label: body.label, u: body.u, v: body.v, editor: body.editor, version: body.anchorVersion,
      });
      send(res, 200, { version: r.version, anchor: r.anchor });
    } catch (e) { errRes(res, e); }
  },

  // 试算配准（不落库），返回模型与误差界限
  'POST /api/pair/:id/register/preview': async (req, res) => {
    const body = await readBody(req);
    try { send(res, 200, service.computeRegistration(req.params.id, body.baseVersion, body.kind || 'affine')); }
    catch (e) { errRes(res, e); }
  },
  // 保存配准（产生新版本）
  'POST /api/pair/:id/register': async (req, res) => {
    const body = await readBody(req);
    try { const r = service.saveRegistration(req.params.id, body.baseVersion, body.kind || 'affine', body.editor); send(res, 200, { version: r.version, registration: r.snapshot.registration }); }
    catch (e) { errRes(res, e); }
  },

  // 裁切/方向/翻转后的坐标迁移
  'POST /api/pair/:id/remap': async (req, res) => {
    const body = await readBody(req);
    try {
      const r = service.remapAfterTransform(req.params.id, body.baseVersion, body.role, body.next || {}, body.editor);
      send(res, 200, { version: r.version, anchors: r.snapshot.anchors, annotations: r.snapshot.annotations });
    } catch (e) { errRes(res, e); }
  },

  'POST /api/pair/:id/annotation': async (req, res) => {
    const body = await readBody(req);
    const r = service.addAnnotation(req.params.id, body.baseVersion, body, body.editor);
    send(res, 200, { version: r.version });
  },
  'POST /api/pair/:id/masks': async (req, res) => {
    const body = await readBody(req);
    const r = service.setMasks(req.params.id, body.baseVersion, body.masks || {}, body.editor);
    send(res, 200, { version: r.version, masks: r.snapshot.masks });
  },

  // 触发瓦片生成
  'POST /api/pair/:id/tiles': async (req, res) => {
    const body = await readBody(req);
    const v = body.baseVersion || store.getPair(req.params.id).currentVersion;
    const snap = store.getVersion(req.params.id, v);
    if (!snap) return send(res, 404, { error: 'VERSION_NOT_FOUND' });
    const jobs = [];
    if (snap.oldPhotoId) jobs.push(tiles.enqueue(snap.id, v, 'old'));
    if (snap.newPhotoId) jobs.push(tiles.enqueue(snap.id, v, 'new'));
    send(res, 202, { jobs: jobs.map((j) => ({ id: j.id, status: j.status })) });
  },
  'GET /api/pair/:id/tiles': async (req, res, q) => {
    const v = q.v ? Number(q.v) : store.getPair(req.params.id).currentVersion;
    const snap = store.getVersion(req.params.id, v);
    if (!snap) return send(res, 404, { error: 'VERSION_NOT_FOUND' });
    send(res, 200, { version: v, tileSet: snap.tileSet });
  },

  'POST /api/pair/:id/approve': async (req, res) => {
    const body = await readBody(req);
    try {
      const snap = store.approve(req.params.id, body.version, body.reviewer, body.note);
      send(res, 200, { version: snap.version, approval: snap.approval });
    } catch (e) { errRes(res, e); }
  },

  // 让一侧授权过期（演示“授权过期”）
  'POST /api/photo/:id/expire-license': async (req, res) => {
    const ph = store.getPhoto(req.params.id); if (!ph) return send(res, 404, { error: 'PHOTO_GONE' });
    ph.license.status = 'EXPIRED'; ph.license.expiresAt = new Date(Date.now() - 86400000).toISOString();
    store.data.photos = store.data.photos; // 直接改对象；触发持久化
    store._save();
    send(res, 200, { id: ph.id, license: ph.license });
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const q = Object.fromEntries(u.searchParams);
    const pathname = decodeURIComponent(u.pathname);
    if (pathname.startsWith('/api/')) {
      // 路由匹配 :param
      let matched = null;
      for (const key of Object.keys(routes)) {
        const [method, pat] = key.split(' ');
        if (method !== req.method) continue;
        const params = matchPath(pat, pathname);
        if (params) { matched = { handler: routes[key], params }; break; }
      }
      if (!matched) return send(res, 404, { error: 'NO_ROUTE' });
      req.params = matched.params;
      return await matched.handler(req, res, q);
    }
    // 静态
    return serveStatic(pathname, res);
  } catch (e) { errRes(res, e); }
});

function matchPath(pat, pathname) {
  const ps = pat.split('/'), as = pathname.split('/');
  if (ps.length !== as.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) params[ps[i].slice(1)] = as[i];
    else if (ps[i] !== as[i]) return null;
  }
  return params;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUB, path.normalize(rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`修复对照档案服务: http://localhost:${PORT}`));
}
module.exports = { server, store, service, tiles };

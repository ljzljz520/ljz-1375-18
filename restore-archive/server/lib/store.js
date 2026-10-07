'use strict';
// JSON 文件持久化的版本化数据存储。无第三方依赖。
// 关键不变量：Pair 版本不可变；已批准快照永久保留；锚点乐观锁。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.dbPath = path.join(dir, 'db.json');
    this.lockPath = path.join(dir, '.lock');
    this.data = { projects: [], pairs: [], photos: [], users: [] };
    this._load();
  }
  _load() {
    try { this.data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8')); }
    catch { this._save(); }
  }
  // 演示用：串行化关键写操作，避免并发交错
  _transaction(fn) {
    const release = this._lock();
    try { this._load(); const r = fn(); this._save(); return r; }
    finally { release(); }
  }
  _lock() {
    const start = Date.now();
    for (;;) {
      try { fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' }); break; }
      catch { if (Date.now() - start > 5000) { try { fs.unlinkSync(this.lockPath); } catch {} } else { wait(10); } }
    }
    return () => { try { fs.unlinkSync(this.lockPath); } catch {} };
  }
  _save() {
    const tmp = this.dbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dbPath);
  }

  // ---------- projects ----------
  createProject(p) {
    return this._transaction(() => {
      const proj = { id: 'proj_' + id(), name: p.name, createdAt: now(), pairs: [] };
      this.data.projects.push(proj); return proj;
    });
  }
  getProject(id) { return this.data.projects.find((x) => x.id === id); }

  // ---------- photos ----------
  addPhoto(ph) {
    return this._transaction(() => {
      const photo = {
        id: 'ph_' + id(),
        sha256: ph.sha256,
        file: ph.file,
        width: ph.width, height: ph.height,
        orientation: ph.orientation || 1,
        crop: ph.crop || null,
        sourceTransform: ph.sourceTransform || null,
        capture: ph.capture || {},
        license: ph.license || { holder: '', scope: '', expiresAt: null, status: 'VALID' },
        uploadedAt: now(),
      };
      this.data.photos.push(photo); return photo;
    });
  }
  getPhoto(id) { return this.data.photos.find((x) => x.id === id); }

  // ---------- pairs（版本化）----------
  createPair({ projectId, stage, oldPhotoId, newPhotoId }) {
    return this._transaction(() => {
      const pairId = 'pair_' + id();
      const v1 = this._snapshot({
        id: pairId, projectId, stage: stage || 'BEFORE',
        oldPhotoId: oldPhotoId || null, newPhotoId: newPhotoId || null,
        anchors: [], annotations: [], registration: null, tileSet: null, approval: null,
        masks: { occlusions: [], addedStructure: [] },
      }, 1);
      this.data.pairs.push({ id: pairId, currentVersion: 1, versions: [v1] });
      const proj = this.getProject(projectId); if (proj) proj.pairs.push(pairId);
      return { pairId, version: 1, snapshot: v1 };
    });
  }
  getPair(id) { return this.data.pairs.find((x) => x.id === id); }
  // 读取指定版本；缺省读当前。已批准版本即使授权过期也存在。
  getVersion(pairId, version) {
    const p = this.getPair(pairId); if (!p) return null;
    const v = version || p.currentVersion;
    return p.versions.find((x) => x.version === v) || null;
  }
  statusOf(snap) {
    if (snap.approval) return 'APPROVED';
    if (!snap.oldPhotoId || !snap.newPhotoId) return 'INCOMPLETE';
    return 'DRAFT';
  }
  // 通用编辑：基于某版本做修改，生成新版本（不可变）
  edit(pairId, baseVersion, mutator, editor) {
    return this._transaction(() => {
      const p = this.getPair(pairId); if (!p) throw httpError(404, 'PAIR_NOT_FOUND');
      if (baseVersion !== p.currentVersion) {
        throw Object.assign(httpError(409, 'VERSION_CONFLICT'), { currentVersion: p.currentVersion });
      }
      const base = p.versions.find((x) => x.version === baseVersion);
      if (base.approval) throw httpError(409, 'APPROVED_VERSION_IMMUTABLE');
      const draft = JSON.parse(JSON.stringify(base));
      mutator(draft);
      const nv = p.currentVersion + 1;
      const snap = this._snapshot(draft, nv, { editor, basedOn: baseVersion });
      // 任何内容编辑都使旧瓦片失效
      snap.tileSet = null;
      p.versions.push(snap); p.currentVersion = nv;
      return { pairId, version: nv, snapshot: snap };
    });
  }
  // 不产生新版本的原地更新（仅瓦片状态等派生产物）
  patchDerivative(pairId, version, patch) {
    return this._transaction(() => {
      const snap = this.getVersion(pairId, version); if (!snap) throw httpError(404, 'VERSION_NOT_FOUND');
      Object.assign(snap, patch);
      return snap;
    });
  }
  _snapshot(d, version, extra = {}) {
    return {
      version,
      id: d.id, projectId: d.projectId, stage: d.stage,
      oldPhotoId: d.oldPhotoId, newPhotoId: d.newPhotoId,
      anchors: d.anchors || [], annotations: d.annotations || [],
      registration: d.registration || null, tileSet: d.tileSet || null,
      approval: d.approval || null, masks: d.masks || { occlusions: [], addedStructure: [] },
      createdAt: now(),
      ...extra,
    };
  }

  // ---------- anchors：乐观锁 ----------
  saveAnchor(pairId, baseVersion, anchor) {
    return this._transaction(() => {
      const p = this.getPair(pairId); if (!p) throw httpError(404, 'PAIR_NOT_FOUND');
      if (baseVersion !== p.currentVersion) {
        throw Object.assign(httpError(409, 'VERSION_CONFLICT'), { currentVersion: p.currentVersion });
      }
      const base = p.versions.find((x) => x.version === baseVersion);
      if (base.approval) throw httpError(409, 'APPROVED_VERSION_IMMUTABLE');
      const existing = base.anchors.find((a) => a.id === anchor.id);
      if (existing) {
        if (anchor.version !== existing.version) {
          // 两编辑同改一锚点：拒绝静默覆盖，返回服务器当前值供三方合并
          throw Object.assign(httpError(409, 'ANCHOR_VERSION_CONFLICT'), { anchor: existing });
        }
      }
      const draft = JSON.parse(JSON.stringify(base));
      let saved;
      if (existing) {
        saved = { ...existing, ...anchor, version: existing.version + 1 };
        const i = draft.anchors.findIndex((a) => a.id === anchor.id);
        draft.anchors[i] = saved;
      } else {
        saved = {
          id: anchor.id || ('anc_' + id()),
          version: 1,
          label: anchor.label || '',
          u: anchor.u, v: anchor.v,
          createdAt: now(),
        };
        draft.anchors.push(saved);
      }
      const nv = p.currentVersion + 1;
      const snap = this._snapshot(draft, nv, { editor: anchor.editor, basedOn: baseVersion });
      snap.tileSet = null;
      p.versions.push(snap); p.currentVersion = nv;
      return { pairId, version: nv, anchor: saved, snapshot: snap };
    });
  }

  // ---------- approval ----------
  approve(pairId, version, reviewer, note) {
    return this._transaction(() => {
      const snap = this.getVersion(pairId, version); if (!snap) throw httpError(404, 'VERSION_NOT_FOUND');
      const blockers = this.approvalBlockers(snap);
      if (blockers.length) throw Object.assign(httpError(412, 'APPROVAL_BLOCKED'), { blockers });
      const approval = { pairId, version, reviewer, note, approvedAt: now() };
      snap.approval = approval; // 批准标记写在该不可变版本上
      // 登记瓦片缓存保留策略（授权过期后仍可访问已批准快照）
      if (snap.tileSet) snap.tileSet.retainWithApproval = true;
      return snap;
    });
  }
  approvalBlockers(snap) {
    const b = [];
    if (!snap.oldPhotoId || !snap.newPhotoId) b.push('INCOMPLETE_SIDE');
    const chk = (pid, role) => {
      const ph = this.getPhoto(pid);
      if (!ph) { b.push(role + '_MISSING'); return; }
      if (ph.license.status !== 'VALID') b.push(role + '_LICENSE_' + ph.license.status);
      else if (ph.license.expiresAt && Date.parse(ph.license.expiresAt) < Date.now()) b.push(role + '_LICENSE_EXPIRED');
    };
    chk(snap.oldPhotoId, 'OLD'); chk(snap.newPhotoId, 'NEW');
    if (snap.annotations.some((a) => a.reviewStatus === 'PENDING')) b.push('PENDING_ANNOTATIONS');
    if (snap.registration && snap.registration.status === 'REJECTED') b.push('REGISTRATION_REJECTED');
    return b;
  }
  list() { return this.data; }
}

function httpError(status, code) { const e = new Error(code); e.status = status; e.code = code; return e; }
function wait(ms) { const until = Date.now() + ms; while (Date.now() < until) {} }
function id() { return crypto.randomBytes(6).toString('hex'); }
function now() { return new Date().toISOString(); }

module.exports = { Store, httpError };

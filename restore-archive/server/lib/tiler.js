'use strict';
// 大图瓦片金字塔异步生成。
// 资源限制：maxDecodePixels 解码预算、maxConcurrent、单任务超时；超限 REJECTED_RESOURCE_LIMIT。
// 版本安全：逐瓦片生成前检查 pairVersion，照片被替换/版本推进 => SUPERSEDED 中止。
const fs = require('fs');
const path = require('path');
const png = require('./png');

const LIMITS = {
  maxDecodePixels: 8000 * 8000, // 单次解码像素预算
  maxConcurrent: 1,
  tileSize: 256,
  taskTimeoutMs: 20000,
};

class TileQueue {
  constructor(store, opts = {}) {
    this.store = store;
    this.dataDir = opts.dataDir;
    this.tileRoot = opts.tileRoot;
    this.limits = { ...LIMITS, ...opts.limits };
    this.running = 0;
    this.jobs = new Map(); // jobId -> job
    this.queue = [];
  }

  // 入队；同一 pairVersion 去重
  enqueue(pairId, version, photoRole) {
    const jobId = `${pairId}#v${version}#${photoRole}`;
    if (this.jobs.has(jobId)) return this.jobs.get(jobId);
    const job = { id: jobId, pairId, version, photoRole, status: 'PENDING', progress: 0, error: null, startedAt: null };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    this._pump();
    return job;
  }
  getJob(jobId) { return this.jobs.get(jobId) || null; }

  _pump() {
    while (this.running < this.limits.maxConcurrent && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'PENDING') continue;
      this.running++;
      job.status = 'RUNNING'; job.startedAt = Date.now();
      this._run(job)
        .catch((e) => { if (job.status === 'RUNNING') job.status = 'FAILED', job.error = e.message; })
        .finally(() => { this.running--; this._pump(); });
    }
  }

  async _run(job) {
    const timer = setTimeout(() => { if (job.status === 'RUNNING') { job.status = 'FAILED'; job.error = 'TASK_TIMEOUT'; } }, this.limits.taskTimeoutMs);
    try {
      const snap = this.store.getVersion(job.pairId, job.version);
      if (!snap) { job.status = 'FAILED'; job.error = 'VERSION_GONE'; return; }
      const photoId = job.photoRole === 'old' ? snap.oldPhotoId : snap.newPhotoId;
      const photo = this.store.getPhoto(photoId);
      if (!photo) { job.status = 'FAILED'; job.error = 'PHOTO_GONE'; return; }

      // 1) 解码预算检查（在真正解码前拦截超大图，防止服务器爆内存）
      const file = path.join(this.dataDir, photo.file);
      const buf = fs.readFileSync(file);
      // PNG 头部读取尺寸
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      if (w * h > this.limits.maxDecodePixels) {
        job.status = 'REJECTED_RESOURCE_LIMIT';
        job.error = `DECODE_PIXELS ${w}x${h} > ${this.limits.maxDecodePixels}`;
        this._writeState(job, snap, photo, null);
        return;
      }

      // 2) 解码（受预算保护）
      const img = png.decode(buf);
      const outDir = path.join(this.tileRoot, `${snap.id}_v${snap.version}_${job.photoRole}_${photo.sha256.slice(0, 12)}`);
      fs.mkdirSync(outDir, { recursive: true });

      // 3) 金字塔：从原图逐级降采样，逐瓦片落盘；每片前检查版本是否被替换
      const levels = Math.max(1, Math.ceil(Math.log2(Math.max(img.width, img.height) / this.limits.tileSize)) + 1);
      let cur = img;
      for (let z = levels - 1; z >= 0; z--) {
        const cols = Math.ceil(cur.width / this.limits.tileSize);
        const rows = Math.ceil(cur.height / this.limits.tileSize);
        for (let ty = 0; ty < rows; ty++) {
          for (let tx = 0; tx < cols; tx++) {
            // 版本安全：照片替换 / 版本推进 => 中止，绝不把旧瓦片挂到新版本
            const live = this.store.getPair(job.pairId);
            if (!live || live.currentVersion !== job.version || this._photoChanged(job, snap)) {
              job.status = 'SUPERSEDED';
              this._cleanup(outDir);
              return;
            }
            const tile = png.extractTile(cur, tx, ty, this.limits.tileSize);
            fs.writeFileSync(path.join(outDir, `${z}-${tx}-${ty}.png`), png.encode(tile));
            job.progress = Math.round(((levels - 1 - z + (ty * cols + tx + 1) / (cols * rows)) / levels) * 100);
          }
        }
        if (z > 0) cur = png.downsample(cur, 2);
      }

      // 4) 写元数据并绑定到该不可变版本
      const meta = {
        pairId: snap.id, pairVersion: snap.version, photoRole: job.photoRole,
        photoId: photo.id, photoSha: photo.sha256,
        width: img.width, height: img.height, tileSize: this.limits.tileSize,
        levels, dir: path.basename(outDir), readyAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));
      job.status = 'READY';
      this._writeState(job, snap, photo, meta);
    } finally {
      clearTimeout(timer);
    }
  }

  _photoChanged(job, snapAtStart) {
    const liveSnap = this.store.getVersion(job.pairId, job.version);
    if (!liveSnap) return true;
    const a = job.photoRole === 'old' ? liveSnap.oldPhotoId : liveSnap.newPhotoId;
    const b = job.photoRole === 'old' ? snapAtStart.oldPhotoId : snapAtStart.newPhotoId;
    return a !== b;
  }
  _writeState(job, snap, photo, meta) {
    // 从最新快照取 tileSet（两个角色 old/new 的任务状态都要保留），再合并本角色
    const liveSnap = this.store.getVersion(job.pairId, job.version) || snap;
    const tileSet = (liveSnap.tileSet && liveSnap.tileSet.jobs)
      ? JSON.parse(JSON.stringify(liveSnap.tileSet))
      : { jobs: {} };
    tileSet.jobs[job.photoRole] = { status: job.status, error: job.error, meta: meta || null };
    this.store.patchDerivative(job.pairId, job.version, { tileSet });
  }
  _cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

module.exports = { TileQueue, LIMITS };

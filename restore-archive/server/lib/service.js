'use strict';
// 领域编排：配准、标注迁移（裁切/方向/翻转）、配准可用域与误差界限。
const math = require('./math');

class Service {
  constructor(store) { this.store = store; }

  // 依据当前锚点对计算配准。旧照锚点 u -> 新照锚点 v。
  // 只使用“非遮挡、双方都可见”的锚点；新增构件区域的锚点不参与。
  computeRegistration(pairId, baseVersion, kind) {
    const snap = this.store.getVersion(pairId, baseVersion);
    if (!snap) throw e(404, 'PAIR_NOT_FOUND');
    if (!snap.oldPhotoId || !snap.newPhotoId) throw e(400, 'INCOMPLETE_SIDE');
    const oldPh = this.store.getPhoto(snap.oldPhotoId);
    const newPh = this.store.getPhoto(snap.newPhotoId);

    // 待复核锚点不参与配准
    const usable = snap.anchors.filter((a) => a.reviewStatus !== 'PENDING' && a.u && a.v);
    // 位于遮挡遮罩或新增构件遮罩内的 v 点不参与（无同源对应）
    const pairs = usable
      .filter((a) => !this._inMasks(snap, a.v))
      .map((a, i) => ({ id: a.id, label: a.label, u: a.u, v: a.v }));

    const diag = Math.hypot(newPh.width, newPh.height);
    const result = math.register(pairs, { kind, diagPx: diag });
    result.photoMeta = {
      old: { id: oldPh.id, w: oldPh.width, h: oldPh.height, capture: oldPh.capture },
      new: { id: newPh.id, w: newPh.width, h: newPh.height, capture: newPh.capture },
      viewpointNote: this._viewpointNote(oldPh, newPh),
    };
    result.usedAnchors = pairs.map((p) => p.id);
    result.excludedAnchors = usable.filter((a) => this._inMasks(snap, a.v)).map((a) => a.id);
    return result;
  }

  saveRegistration(pairId, baseVersion, kind, editor) {
    const reg = this.computeRegistration(pairId, baseVersion, kind);
    return this.store.edit(pairId, baseVersion, (draft) => { draft.registration = reg; }, editor);
  }

  _inMasks(snap, p) {
    const inPoly = (poly) => poly && poly.length >= 3 && math.pointInPolygon(p, poly);
    return (snap.masks.occlusions || []).some(inPoly) ||
           (snap.masks.addedStructure || []).some(inPoly);
  }
  _viewpointNote(oldPh, newPh) {
    const o = oldPh.capture || {}, n = newPh.capture || {};
    const notes = [];
    if (o.focalMm && n.focalMm && Math.abs(o.focalMm - n.focalMm) / Math.max(o.focalMm, 1) > 0.15) {
      notes.push(`焦距不同(${o.focalMm}mm vs ${n.focalMm}mm)，存在变焦/视场差异`);
    }
    if (o.gps && n.gps && (Math.abs(o.gps.lat - n.gps.lat) > 1e-5 || Math.abs(o.gps.lng - n.gps.lng) > 1e-5)) {
      notes.push('机位坐标不同，存在视差');
    }
    if (o.lighting && n.lighting && o.lighting !== n.lighting) notes.push(`光照条件不同(${o.lighting} vs ${n.lighting})`);
    return notes;
  }

  // 照片方向/裁切改变后，迁移所有标注与锚点坐标。
  // 新 sourceTransform 无法唯一确定（如手工翻转）=> 全部 PENDING。
  // 照片方向/裁切改变后迁移锚点与文字注释坐标（均存于规范帧）。
  // R = 旧规范帧 -> 新规范帧；无法唯一确定（手工翻转）=> 全部 PENDING。
  remapAfterTransform(pairId, baseVersion, role, next, editor) {
    const snap = this.store.getVersion(pairId, baseVersion);
    if (!snap) throw e(404, 'PAIR_NOT_FOUND');
    const photoId = role === 'old' ? snap.oldPhotoId : snap.newPhotoId;
    const photo = this.store.getPhoto(photoId);
    if (!photo) throw e(404, 'PHOTO_GONE');

    let R, dims;
    if (next.ambiguousFlip) {
      return this._markAllPending(pairId, baseVersion, role, 'AMBIGUOUS_FLIP', editor);
    } else if (next.explicitRelative) {
      R = next.explicitRelative;
      dims = { w: next.newWidth || photo.width, h: next.newHeight || photo.height };
    } else if (next.orientation && next.orientation !== (photo.orientation || 1)) {
      const w0 = next.sourceWidth || photo.width, h0 = next.sourceHeight || photo.height;
      const MOld = math.orientationMatrix(photo.orientation || 1, w0, h0);
      const MNew = math.orientationMatrix(next.orientation, w0, h0);
      R = math.matMul(MNew, math.matInv(MOld));
      const oldSwap = [6, 8].includes(photo.orientation || 1);
      const newSwap = [6, 8].includes(next.orientation);
      // 新规范画布尺寸：按当前规范帧(photo.width×height)是否需互换判断
      dims = (oldSwap !== newSwap)
        ? { w: photo.height, h: photo.width }
        : { w: photo.width, h: photo.height };
    } else if (next.crop) {
      R = math.trCrop(next.crop);
      dims = { w: next.crop.w, h: next.crop.h };
    } else {
      throw e(400, 'NO_TRANSFORM_SPECIFIED');
    }

    const applyR = (p) => math.applyMat(R, p);
    return this.store.edit(pairId, baseVersion, (draft) => {
      const field = role === 'old' ? 'u' : 'v';
      draft.anchors = draft.anchors.map((a) => {
        if (!a[field]) return a;
        try {
          const np = applyR(a[field]);
          const inside = np.x >= 0 && np.y >= 0 && np.x <= dims.w && np.y <= dims.h;
          return { ...a, [field]: np,
            reviewStatus: inside ? 'CONFIRMED' : 'PENDING',
            reviewReason: inside ? undefined : 'MIGRATED_OUT_OF_FRAME' };
        } catch (err) {
          return { ...a, reviewStatus: 'PENDING', reviewReason: err.code || 'MIGRATION_FAILED' };
        }
      });
      draft.annotations = (draft.annotations || []).map((an) => {
        try {
          const np = applyR({ x: an.x, y: an.y });
          const inside = np.x >= 0 && np.y >= 0 && np.x <= dims.w && np.y <= dims.h;
          return { ...an, x: np.x, y: np.y,
            reviewStatus: inside ? (an.reviewStatus === 'PENDING' ? 'PENDING' : 'CONFIRMED') : 'PENDING',
            reviewReason: inside ? an.reviewReason : 'MIGRATED_OUT_OF_FRAME' };
        } catch (err) {
          return { ...an, reviewStatus: 'PENDING', reviewReason: err.code || 'MIGRATION_FAILED' };
        }
      });
      draft.registration = null;
      draft._transformContext = { role, relative: R, newDims: dims, at: new Date().toISOString() };
    }, editor);
  }

  _markAllPending(pairId, baseVersion, role, reason, editor) {
    return this.store.edit(pairId, baseVersion, (draft) => {
      draft.anchors = draft.anchors.map((a) => ({ ...a, reviewStatus: 'PENDING', reviewReason: reason }));
      draft.annotations = (draft.annotations || []).map((a) => ({ ...a, reviewStatus: 'PENDING', reviewReason: reason }));
      draft.registration = null;
    }, editor);
  }

  // 新增文字注释；pinnedRestricted 的“未开放区域”说明常驻不随图层消失（前端强制，后端标记）
  addAnnotation(pairId, baseVersion, ann, editor) {
    return this.store.edit(pairId, baseVersion, (draft) => {
      draft.annotations.push({
        id: 'ann_' + Math.random().toString(16).slice(2, 10),
        x: ann.x, y: ann.y, text: ann.text,
        layer: ann.layer || 'notes',
        pinnedRestricted: !!ann.pinnedRestricted,
        reviewStatus: ann.reviewStatus || 'CONFIRMED',
        createdAt: new Date().toISOString(),
      });
    }, editor);
  }
  setMasks(pairId, baseVersion, masks, editor) {
    return this.store.edit(pairId, baseVersion, (draft) => { draft.masks = { ...draft.masks, ...masks }; }, editor);
  }
  setStage(pairId, baseVersion, stage, editor) {
    return this.store.edit(pairId, baseVersion, (draft) => { draft.stage = stage; }, editor);
  }
}

function e(status, code) { const x = new Error(code); x.status = status; x.code = code; return x; }
module.exports = { Service };

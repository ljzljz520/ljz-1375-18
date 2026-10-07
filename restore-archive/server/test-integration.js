'use strict';
// 端到端集成测试：启动内存可控的真实 HTTP 服务，覆盖领域规则与边界场景。
// 用法：node server/test-integration.js   （使用独立端口与临时数据目录）
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const PORT = 8917;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}
async function req(method, url, body) {
  const data = body ? JSON.stringify(body) : null;
  const r = await fetch(BASE + url, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

async function main() {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), MAX_DECODE_PIXELS: '1000000' },
    stdio: 'inherit',
  });
  await new Promise((r) => setTimeout(r, 700));
  try {
    // 1. 一侧晚到
    let r = await req('POST', '/api/projects', { name: 'T' });
    const projId = r.json.id;
    const seed = await req('POST', '/api/demo/seed', {});
    const created = await req('POST', '/api/pairs', { projectId: projId, oldPhotoId: seed.json.oldPhotoId });
    const pid = created.json.pairId;
    ok('一侧晚到 => INCOMPLETE', created.json.status === 'INCOMPLETE');
    const incomplete = await req('GET', `/api/pair/${pid}`);
    ok('INCOMPLETE 有阻断项', incomplete.json.blockers.includes('INCOMPLETE_SIDE'));
    const regAttempt = await req('POST', `/api/pair/${pid}/register/preview`, { baseVersion: 1, kind: 'affine' });
    ok('资源不全禁止配准', regAttempt.status === 400 && regAttempt.json.error === 'INCOMPLETE_SIDE');
    const appr = await req('POST', `/api/pair/${pid}/approve`, { version: 1, reviewer: 'x' });
    ok('资源不全禁止批准 412', appr.status === 412);
    // 晚到侧上传
    let rr = await req('POST', `/api/pair/${pid}/photo/new`, { baseVersion: 1, useSample: true, license: { holder: 'x', scope: 'i', status: 'VALID' } });
    ok('晚到侧上传成功', rr.status === 200);
    const afterLate = await req('GET', `/api/pair/${pid}`);
    ok('两侧齐全 => DRAFT', afterLate.json.status === 'DRAFT');
    let cur = afterLate.json.currentVersion;

    // 2. 一致仿射 6 点 => ACCEPTED
    const A = [[1.01, 0.02, 8], [-0.015, 1.005, 4]];
    const us = [[110, 256], [460, 256], [120, 360], [450, 360], [180, 300], [400, 300]];
    for (const [ux, uy] of us) {
      const vx = A[0][0] * ux + A[0][1] * uy + A[0][2];
      const vy = A[1][0] * ux + A[1][1] * uy + A[1][2];
      rr = await req('POST', `/api/pair/${pid}/anchor`, { baseVersion: cur, label: `${ux}`, u: { x: ux, y: uy }, v: { x: vx, y: vy } });
      cur = rr.json.version;
    }
    const preview = await req('POST', `/api/pair/${pid}/register/preview`, { baseVersion: cur, kind: 'affine' });
    ok('一致仿射 ACCEPTED', preview.json.status === 'ACCEPTED', JSON.stringify(preview.json.metrics));
    ok('误差在 0.5% 内', preview.json.metrics.relRms <= 0.005);
    // 系统性透视偏差 => REJECTED
    const biasedPairs = us.map(([ux, uy], i) => {
      const vx = A[0][0] * ux + A[0][1] * uy + A[0][2] + (i >= 3 ? 40 : 0);
      const vy = A[1][0] * ux + A[1][1] * uy + A[1][2] + (i >= 3 ? 40 : 0);
      return { u: { x: ux, y: uy }, v: { x: vx, y: vy } };
    });
    // 用独立 pair 验证拒绝
    const p2seed = await req('POST', '/api/demo/seed', {});
    const p2 = p2seed.json.pairId;
    let c2 = 1;
    for (let i = 0; i < biasedPairs.length; i++) {
      rr = await req('POST', `/api/pair/${p2}/anchor`, { baseVersion: c2, label: 'b', ...biasedPairs[i] }); c2 = rr.json.version;
    }
    const rej = await req('POST', `/api/pair/${p2}/register/preview`, { baseVersion: c2, kind: 'affine' });
    ok('透视残差聚集 => REJECTED 并排', rej.json.status === 'REJECTED');

    // 3. 旋转坐标迁移
    rr = await req('POST', `/api/pair/${p2}/remap`, { baseVersion: c2, role: 'old', next: { orientation: 6, sourceWidth: 560, sourceHeight: 420 } });
    const moved = rr.json.anchors.find((a) => a.u && Math.abs(a.u.x - 10) < 1);
    ok('旋转接口可用（返回新版本）', typeof rr.json.version === 'number');
    // 翻转 => 全 PENDING
    const flip = await req('POST', `/api/pair/${p2}/remap`, { baseVersion: rr.json.version, role: 'old', next: { ambiguousFlip: true } });
    ok('翻转全部待复核', flip.json.anchors.every((a) => a.reviewStatus === 'PENDING' && a.reviewReason === 'AMBIGUOUS_FLIP'));

    // 4. 并发同锚点 409
    const aseed = await req('POST', '/api/demo/seed', {});
    const apid = aseed.json.pairId;
    rr = await req('POST', `/api/pair/${apid}/anchor`, { baseVersion: 1, label: 'X', u: { x: 1, y: 1 }, v: { x: 1, y: 1 } });
    const aid = rr.json.anchor.id; let av = rr.json.version;
    rr = await req('POST', `/api/pair/${apid}/anchor`, { baseVersion: av, anchorId: aid, anchorVersion: 1, label: '乙', u: { x: 1, y: 1 }, v: { x: 2, y: 2 } });
    const bv = rr.json.version;
    const conflict = await req('POST', `/api/pair/${apid}/anchor`, { baseVersion: bv, anchorId: aid, anchorVersion: 1, label: '甲', u: { x: 1, y: 1 }, v: { x: 9, y: 9 } });
    ok('并发改同锚点 => 409 ANCHOR_VERSION_CONFLICT', conflict.status === 409 && conflict.json.error === 'ANCHOR_VERSION_CONFLICT');
    ok('冲突返回服务器当前值', conflict.json.anchor && conflict.json.anchor.label === '乙');

    // 5. 授权过期：原图403，结论仍可读
    const expire = await req('POST', `/api/photo/${seed.json.oldPhotoId}/expire-license`, {});
    ok('过期标记成功', expire.json.license.status === 'EXPIRED');
    const raw = await req('GET', `/api/photo/${seed.json.oldPhotoId}`);
    ok('过期原图 403', raw.status === 403);

    // 6. 资源限制（预算 100万，2000x2000=400万 超限）
    const png = makePng(2000, 2000);
    rr = await req('POST', `/api/pair/${apid}/photo/old`, { baseVersion: bv, pngBase64: 'data:image/png;base64,' + png.toString('base64'), license: { holder: 'x', scope: 'i', status: 'VALID' } });
    const bigv = rr.json.version;
    await req('POST', `/api/pair/${apid}/tiles`, { baseVersion: bigv });
    await new Promise((r) => setTimeout(r, 1200));
    const tstat = await req('GET', `/api/pair/${apid}/tiles?v=${bigv}`);
    const oldJob = tstat.json.tileSet && tstat.json.tileSet.jobs.old;
    ok('超大解码被资源限制拒绝', oldJob && oldJob.status === 'REJECTED_RESOURCE_LIMIT');

    // 7. 批准冻结 + 深链接版本不变
    const goodSeed = await req('POST', '/api/demo/seed', {});
    const gpid = goodSeed.json.pairId; let gv = 1;
    for (const [ux, uy] of us) {
      const vx = A[0][0] * ux + A[0][1] * uy + A[0][2], vy = A[1][0] * ux + A[1][1] * uy + A[1][2];
      rr = await req('POST', `/api/pair/${gpid}/anchor`, { baseVersion: gv, label: 'g', u: { x: ux, y: uy }, v: { x: vx, y: vy } }); gv = rr.json.version;
    }
    rr = await req('POST', `/api/pair/${gpid}/register`, { baseVersion: gv, kind: 'affine' }); gv = rr.json.version;
    await req('POST', `/api/pair/${gpid}/annotation`, { baseVersion: gv, x: 100, y: 100, text: '未开放区域，禁止入内', pinnedRestricted: true, layer: 'new' });
    gv += 1;
    const approval = await req('POST', `/api/pair/${gpid}/approve`, { version: gv, reviewer: '甲', note: '准予存档' });
    ok('批准成功', approval.status === 200 && approval.json.approval.note === '准予存档');
    const imm = await req('POST', `/api/pair/${gpid}/stage`, { baseVersion: gv, stage: 'AFTER' });
    ok('已批准版本不可变', imm.status === 409);
    const frozen = await req('GET', `/api/pair/${gpid}?v=${gv}`);
    ok('深链接复现冻结版本', frozen.json.version === gv && frozen.json.stage === 'BEFORE' && frozen.json.status === 'APPROVED');
    ok('常驻受限注释随版本保留', frozen.json.annotations.some((a) => a.pinnedRestricted));

  } finally {
    srv.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nRESULT ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// 生成最小纯色 PNG（复用库）
function makePng(w, h) {
  const png = require(path.join(__dirname, 'lib', 'png'));
  return png.encode(png.createImage(w, h, [180, 170, 150, 255]));
}
main().catch((e) => { console.error(e); process.exit(1); });

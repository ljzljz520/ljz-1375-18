'use strict';
// 生成合成古建“旧照/新照”，用于离线演示。无外部素材依赖。
const png = require('./png');

function sky(img, top, bottom, c1, c2) {
  for (let y = top; y < bottom; y++) {
    const t = (y - top) / (bottom - top);
    const c = [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[1] - c1[2] + c2[2] - c1[2]) * 0 + (c2[2] - c1[2]) * t, 255];
    for (let x = 0; x < img.width; x++) png.setPx(img, x, y, c);
  }
}
function addNoise(img, amount, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < img.width * img.height; i++) {
    const n = (rnd() - 0.5) * amount;
    const k = i * 4;
    img.data[k] = Math.max(0, Math.min(255, img.data[k] + n));
    img.data[k + 1] = Math.max(0, Math.min(255, img.data[k + 1] + n));
    img.data[k + 2] = Math.max(0, Math.min(255, img.data[k + 2] + n));
  }
}

// 一栋简化歇山顶殿堂。shiftX/shiftY + skew 模拟不同视点；damaged 控制旧照残损
function hall(img, o) {
  const W = img.width;
  const red = [150, 44, 34, 255], darkRed = [110, 30, 24, 255], wood = [122, 84, 46, 255];
  const roof = [64, 62, 70, 255], roofEdge = [40, 38, 44, 255], wall = [214, 200, 168, 255];
  const baseY = o.baseY || (img.height - 40);
  // 台基
  png.polygon(img, [
    { x: 60 + o.shiftX, y: baseY }, { x: W - 60 + o.shiftX, y: baseY },
    { x: W - 90 + o.shiftX, y: baseY + 34 }, { x: 90 + o.shiftX, y: baseY + 34 },
  ], [150, 140, 120, 255]);
  // 屋身
  const bodyTop = baseY - 150 + o.shiftY;
  png.rect(img, 90 + o.shiftX, bodyTop, W - 180, 150, wall);
  // 柱子（结构锚点候选）
  const cols = [110, 180, 250, 320, 390, 460].map((x) => x + o.shiftX + (o.skew ? 0 : 0));
  cols.forEach((x, idx) => {
    if (o.damaged && idx === 4) {
      // 旧照：右二柱残损（短柱 + 裂缝）
      png.rect(img, x - 6, bodyTop + 70, 12, 80, wood);
      png.line(img, x - 6, bodyTop + 90, x + 6, bodyTop + 120, [30, 20, 10, 255], 2);
    } else png.rect(img, x - 6, bodyTop + 20, 12, 130, wood);
  });
  // 门窗
  png.rect(img, 250 + o.shiftX, bodyTop + 50, 60, 100, [80, 50, 30, 255]);
  png.line(img, 280 + o.shiftX, bodyTop + 50, 280 + o.shiftX, bodyTop + 150, [200, 170, 120, 255]);
  // 斗拱（檐下一排）——新照右上角多出一组（新增构件）
  for (let x = 100; x <= W - 100; x += 34) {
    const xx = x + o.shiftX;
    png.rect(img, xx, bodyTop - 12, 18, 12, wood);
    png.rect(img, xx + 3, bodyTop - 20, 12, 8, [90, 60, 34, 255]);
  }
  if (!o.damaged && o.showAddedBracket) {
    // 新增斗拱组：旧照此处是空的（残损缺失）
    png.rect(img, 100 + o.shiftX, bodyTop - 40, 22, 18, [176, 128, 60, 255]);
    png.rect(img, 104 + o.shiftX, bodyTop - 52, 14, 12, [150, 104, 44, 255]);
  }
  // 屋顶（歇山，上窄下宽；skew 制造透视差异）
  const eaveY = bodyTop - 22;
  const ridgeY = eaveY - 90;
  const skL = o.skew || 0, skR = -skL;
  png.polygon(img, [
    { x: 70 + o.shiftX + skL, y: eaveY + 6 },
    { x: W - 70 + o.shiftX + skR, y: eaveY + 6 },
    { x: W - 150 + o.shiftX + skR * 0.4, y: ridgeY },
    { x: 150 + o.shiftX + skL * 0.4, y: ridgeY },
  ], roof);
  png.line(img, 150 + o.shiftX + skL * 0.4, ridgeY, W - 150 + o.shiftX + skR * 0.4, ridgeY, roofEdge, 4);
  // 檐口
  png.line(img, 60 + o.shiftX + skL, eaveY + 8, W - 60 + o.shiftX + skR, eaveY + 8, roofEdge, 6);
  // 旧照屋面破损（缺瓦黑洞 + 裂纹）
  if (o.damaged) {
    png.polygon(img, [{ x: 230 + o.shiftX, y: ridgeY + 18 }, { x: 300 + o.shiftX, y: ridgeY + 12 }, { x: 285 + o.shiftX, y: ridgeY + 46 }, { x: 240 + o.shiftX, y: ridgeY + 50 }], [20, 18, 22, 255]);
    png.line(img, 200 + o.shiftX, ridgeY + 60, 260 + o.shiftX, eaveY - 10, [20, 18, 22, 255], 2);
  } else {
    // 新照：瓦垄整齐
    for (let x = 170; x < W - 160; x += 22) png.line(img, x + o.shiftX, ridgeY + 6, x + 20 + o.shiftX, eaveY - 4, [90, 88, 96, 255]);
  }
  return { cols, bodyTop, eaveY, ridgeY, baseY };
}

function scaffold(img, x0, x1, y0, y1) {
  const c = [180, 120, 30, 255];
  for (let x = x0; x <= x1; x += 26) png.line(img, x, y0, x, y1, c, 2);
  for (let y = y0; y <= y1; y += 30) png.line(img, x0, y, x1, y, c, 2);
  png.line(img, x0, y0, x1, y1, c, 1);
}

function makeOld() {
  const W = 560, H = 420;
  const img = png.createImage(W, H, [235, 230, 220, 255]);
  sky(img, 0, H, [120, 130, 150], [200, 190, 170]);
  hall(img, { shiftX: 0, shiftY: 6, skew: 10, damaged: true, showAddedBracket: false, baseY: 386 });
  // 旧照片污渍/划痕 + 颗粒
  addNoise(img, 34, 7);
  png.line(img, 40, 30, 520, 90, [255, 255, 255, 40], 1);
  // 遮挡：一棵树
  png.rect(img, 40, 250, 14, 120, [70, 50, 30, 255]);
  png.polygon(img, [{ x: 47, y: 150 }, { x: 10, y: 260 }, { x: 84, y: 260 }], [60, 90, 50, 255]);
  return img;
}

function makeNew() {
  const W = 560, H = 420;
  const img = png.createImage(W, H, [235, 230, 220, 255]);
  sky(img, 0, H, [150, 170, 200], [225, 215, 195]);
  const geom = hall(img, { shiftX: 6, shiftY: 0, skew: 26, damaged: false, showAddedBracket: true, baseY: 386 });
  addNoise(img, 8, 13);
  // 施工侧仍有脚手架遮挡一部分
  scaffold(img, 470, 550, 200, 380);
  return img;
}

module.exports = { makeOld, makeNew };

'use strict';
// 零依赖 PNG 编解码（仅依赖 zlib）。支持 8-bit RGB/RGBA；解码支持灰度/RGB/RGBA + 所有滤波器。
const zlib = require('zlib');
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

// image: {width,height,channels,data(Buffer RGBA or RGB)}
function encode(img) {
  const { width: w, height: h, data, channels = 4 } = img;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    raw[rowStart + y] = 1; // filter Sub，简单且对合成图足够
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[rowStart + x - channels] : 0;
      raw[rowStart + y + 1 + x] = (data[rowStart + x] - a + 256) & 0xff;
    }
    prev = data.slice(rowStart, rowStart + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function decode(buf) {
  if (buf.length < 8 || buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('NOT_PNG');
  let pos = 8, w = 0, h = 0, depth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4);
    const data = buf.slice(pos + 4, pos + 4 + len); pos += 4 + len + 4;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8) throw new Error('ONLY_8BIT');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('UNSUPPORTED_COLORTYPE');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);
  let rp = 0;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error('BAD_FILTER');
      }
      cur[x] = r & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x * channels, di = (y * w + x) * 4;
      if (colorType === 0) { out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = 255; }
      else if (colorType === 4) { out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = cur[si + 1]; }
      else { out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = channels === 4 ? cur[si + 3] : 255; }
    }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}

// 生成画布
function createImage(w, h, bg = [240, 235, 224, 255]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = bg[3]; }
  return { width: w, height: h, data };
}
function setPx(img, x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  // alpha 混合
  const a = (c[3] ?? 255) / 255;
  img.data[i] = Math.round(c[0] * a + img.data[i] * (1 - a));
  img.data[i + 1] = Math.round(c[1] * a + img.data[i + 1] * (1 - a));
  img.data[i + 2] = Math.round(c[2] * a + img.data[i + 2] * (1 - a));
  img.data[i + 3] = 255;
}
function line(img, x0, y0, x1, y1, c, thick = 1) {
  // 取整为整数端点：浮点在水平/竖直特例下会越过终点，使 x0===x1 永不成立（死循环）
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    for (let ox = -Math.floor(thick / 2); ox <= thick / 2; ox++) for (let oy = -Math.floor(thick / 2); oy <= thick / 2; oy++) setPx(img, x0 + ox, y0 + oy, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}
function rect(img, x, y, w, h, c, fill = true) {
  if (fill) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) setPx(img, x + i, y + j, c); }
  else { line(img, x, y, x + w - 1, y, c); line(img, x, y + h - 1, x + w - 1, y + h - 1, c); line(img, x, y, x, y + h - 1, c); line(img, x + w - 1, y, x + w - 1, y + h - 1, c); }
}
function polygon(img, pts, c) {
  let minY = Infinity, maxY = -Infinity;
  pts.forEach((p) => { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0, j = (i + 1) % pts.length; i < pts.length; i++) {
      const p = pts[i], q = pts[j];
      if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y)) xs.push(p.x + ((y - p.y) / (q.y - p.y)) * (q.x - p.x));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = xs[k]; x <= xs[k + 1]; x++) setPx(img, x, y, c);
  }
}

// 最近邻降采样（面积平均，盒滤波），返回新图
function downsample(img, factor) {
  if (factor <= 1) return img;
  const w = Math.ceil(img.width / factor), h = Math.ceil(img.height / factor);
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = 0; j < factor && y * factor + j < img.height; j++) {
        for (let i = 0; i < factor && x * factor + i < img.width; i++) {
          const si = ((y * factor + j) * img.width + (x * factor + i)) * 4;
          r += img.data[si]; g += img.data[si + 1]; b += img.data[si + 2]; n++;
        }
      }
      const di = (y * w + x) * 4;
      out.data[di] = r / n; out.data[di + 1] = g / n; out.data[di + 2] = b / n; out.data[di + 3] = 255;
    }
  }
  return out;
}
// 提取瓦片（256），越界透明
function extractTile(img, tx, ty, tileSize = 256) {
  const tile = createImage(tileSize, tileSize, [0, 0, 0, 0]);
  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const sx = tx * tileSize + x, sy = ty * tileSize + y;
      if (sx < img.width && sy < img.height) {
        const si = (sy * img.width + sx) * 4, di = (y * tileSize + x) * 4;
        tile.data[di] = img.data[si]; tile.data[di + 1] = img.data[si + 1];
        tile.data[di + 2] = img.data[si + 2]; tile.data[di + 3] = img.data[si + 3];
      }
    }
  }
  return tile;
}

module.exports = { encode, decode, createImage, setPx, line, rect, polygon, downsample, extractTile, crc32, adler32 };

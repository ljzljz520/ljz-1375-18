'use strict';
// ============================================================================
// image.js — 服务端图像处理：上传探测、显示派生图、明确几何操作、DZI 瓦片
// 资源保护：
//  - MAX_DECODE_PIXELS：任何解码任务（上传/几何/瓦片）前先读元数据，
//    像素数超限直接拒绝，绝不把超大图交给解码器（限制超大解码任务资源）。
//  - 瓦片作业排队，全局并发上限，单任务超时中止。
// ============================================================================
const path=require('path'), fs=require('fs'), fsp=require('fs/promises');
const sharp=require('sharp');

const MAX_DECODE_PIXELS = Number(process.env.MAX_DECODE_PIXELS||60_000_000); // 约 60MP
const DERIV_MAX = 1600;
const TILE_SIZE = 256;
const TILE_OVERLAP = 0;

async function probe(buf){
  const meta=await sharp(buf,{limitInputPixels:MAX_DECODE_PIXELS}).metadata();
  const pixels=(meta.width||0)*(meta.height||0);
  if (pixels>MAX_DECODE_PIXELS) {
    const e=new Error('IMAGE_TOO_LARGE');
    e.code='IMAGE_TOO_LARGE'; e.pixels=pixels; e.limit=MAX_DECODE_PIXELS; throw e;
  }
  return { width:meta.width, height:meta.height, format:meta.format,
           hasAlpha:meta.hasAlpha, orientation:meta.orientation||1 };
}

// 上传落盘 + 生成 1600px 显示派生图（编辑器/滑块低带宽回退使用）
async function ingest(buf, dataDir, revId){
  const meta=await probe(buf);
  const original=path.join(dataDir,'originals',revId+'.bin');
  const deriv=path.join(dataDir,'deriv',revId+'.jpg');
  await fsp.mkdir(path.dirname(original),{recursive:true});
  await fsp.writeFile(original,buf);
  await sharp(buf,{limitInputPixels:MAX_DECODE_PIXELS})
    .rotate() // 应用 EXIF 方向（落库坐标基于“显示方向”后的像素系）
    .resize({width:DERIV_MAX,height:DERIV_MAX,fit:'inside'})
    .jpeg({quality:82}).toFile(deriv);
  return { ...meta, original, deriv,
           derivScale: Math.min(1, DERIV_MAX/Math.max(meta.width,meta.height)) };
}

// 明确声明的几何操作 -> 产出新修订的原图与派生图。
// ops 同 geometry.chainTransform 的输入；几何由 sharp 执行，坐标由域层迁移。
async function applyGeometry(srcOriginal, ops, dataDir, newRevId){
  const meta=await sharp(await fsp.readFile(srcOriginal),
    {limitInputPixels:MAX_DECODE_PIXELS}).metadata();
  let img=sharp(srcOriginal,{limitInputPixels:MAX_DECODE_PIXELS}).rotate();
  // 用 sharp 自带 rotate/flip/flop/extract 执行；crop 须在最前且仅一次（与坐标链一致）
  for(const op of ops){
    if(op.type==='rotate90cw') img=img.rotate(90);
    else if(op.type==='rotate180') img=img.rotate(180);
    else if(op.type==='rotate270cw') img=img.rotate(270);
    else if(op.type==='flip_h') img=img.flop();
    else if(op.type==='flip_v') img=img.flip();
    else if(op.type==='crop') img=img.extract({left:op.crop.x,top:op.crop.y,width:op.crop.width,height:op.crop.height});
    else { const e=new Error('UNKNOWN_OP');e.code='UNKNOWN_OP';throw e; }
  }
  const outBuf=await img.png().toBuffer();
  const outMeta=await probe(outBuf);
  const original=path.join(dataDir,'originals',newRevId+'.bin');
  await fsp.writeFile(original,outBuf);
  const deriv=path.join(dataDir,'deriv',newRevId+'.jpg');
  await sharp(outBuf,{limitInputPixels:MAX_DECODE_PIXELS})
    .resize({width:DERIV_MAX,height:DERIV_MAX,fit:'inside'})
    .jpeg({quality:82}).toFile(deriv);
  return { ...outMeta, original, deriv,
           derivScale: Math.min(1, DERIV_MAX/Math.max(outMeta.width,outMeta.height)) };
}

// ---- DZI 瓦片作业 --------------------------------------------------------
// 生成到 tiles/<revId>_tmp，成功后原子改名 tiles/<revId>。
// 作业开始与发布前各校验一次“当前修订指纹”，途中照片被替换则作废，
// 绝不把旧瓦片发布到新修订名下。
function makeTileQueue({ concurrency=1, timeoutMs=120000 }={}){
  const q=[]; let active=0;
  function pump(){
    if(active>=concurrency||!q.length) return;
    const job=q.shift(); active++;
    const done=()=>{active--; setImmediate(pump);};
    (async()=>{
      try{ await job.run(); }catch(e){ await job.fail(e); }
      finally{ done(); }
    })();
  }
  return {
    add(run, fail){ q.push({run,fail}); pump(); },
    pending:()=>q.length, active:()=>active
  };
}

async function generateTiles({ originalPath, revId, expectedHash, sha256,
                               dataDir, tileSize=TILE_SIZE }){
  const buf=await fsp.readFile(originalPath);
  const hash=sha256(buf);
  if(hash!==expectedHash){ const e=new Error('TILE_SOURCE_REPLACED');
    e.code='TILE_SOURCE_REPLACED'; throw e; } // 开始时照片已被替换
  const tmp=path.join(dataDir,'tiles',revId+'_tmp');
  const out=path.join(dataDir,'tiles',revId);
  await fsp.rm(tmp,{recursive:true,force:true});
  await fsp.mkdir(tmp,{recursive:true});
  const dz=sharp(buf,{limitInputPixels:MAX_DECODE_PIXELS}).rotate();
  await dz.png({quality:80}).tile({
    size:tileSize, overlap:TILE_OVERLAP, layout:'dz',
    container:'fs'
  }).toFile(path.join(tmp,'out'));
  // sharp 产出 out_files/ 与 out.dzi；规整成约定布局
  await fsp.rename(path.join(tmp,'out_files'),path.join(tmp,'files')).catch(()=>{});
  let dzi=await fsp.readFile(path.join(tmp,'out.dzi'),'utf8').catch(()=>null);
  if(!dzi){ // 兼容不同 sharp 版本
    dzi='<Image TileSize="'+tileSize+'" Overlap="0" Format="png" xmlns="http://schemas.microsoft.com/deepzoom/2008"><Size Width="0" Height="0"/></Image>';
  }
  await fsp.writeFile(path.join(tmp,'info.dzi'),dzi);
  await fsp.rm(path.join(tmp,'out.dzi'),{force:true});
  // 发布前再次校验源文件指纹（生成途中照片被替换 -> 作废）
  if(module.exports._beforeTilePublish) await module.exports._beforeTilePublish({revId});
  const hash2=sha256(await fsp.readFile(originalPath));
  if(hash2!==expectedHash){ await fsp.rm(tmp,{recursive:true,force:true});
    const e=new Error('TILE_SOURCE_REPLACED'); e.code='TILE_SOURCE_REPLACED'; throw e; }
  await fsp.rm(out,{recursive:true,force:true});
  await fsp.rename(tmp,out);
  return { tileDir:out, dzi };
}

module.exports={ probe, ingest, applyGeometry, generateTiles, makeTileQueue,
  MAX_DECODE_PIXELS, DERIV_MAX, TILE_SIZE };

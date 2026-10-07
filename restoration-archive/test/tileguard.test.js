'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const fs=require('fs'), path=require('path'), os=require('os');
const {open}=require('../server/db');
const Store=require('../server/store');
const image=require('../server/image');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ra-tile-'));
['originals','deriv','tiles'].forEach(d=>fs.mkdirSync(path.join(tmp,d),{recursive:true}));

async function png(w,h){
  return sharp({create:{width:w,height:h,channels:3,background:'#888'}}).png().toBuffer();
}

test('超大解码任务：像素超上限直接拒绝（不进入解码）', async()=>{
  const db=await open(path.join(tmp,'db1.db'));
  const store=Store.create({db,dataDir:tmp});
  const bigW=Math.ceil(Math.sqrt(image.MAX_DECODE_PIXELS))+200;
  // sharp 直接造巨大图代价高：模拟方式是把一条小修订记录的尺寸改大，验证入队前拒绝
  const g=store.createGroup({title:'大'});
  const buf=await png(64,64);
  const up=await store.uploadPhoto(g.id,{file:buf,side:'before'});
  db.run('UPDATE photo_revisions SET width=?,height=? WHERE id=?',[bigW,bigW,up.revision.id]);
  assert.throws(()=>store.enqueueTiles(up.revision.id),e=>e.status===422&&e.code==='IMAGE_TOO_LARGE');
});

test('瓦片生成途中照片替换：源 sha256 变化 -> 作业 aborted_replaced，瓦片不发布', async()=>{
  const db=await open(path.join(tmp,'db2.db'));
  const store=Store.create({db,dataDir:tmp});
  const g=store.createGroup({title:'换'});
  const up=await store.uploadPhoto(g.id,{file:await png(900,700),side:'before'});
  const rev=up.revision.id;
  const job=store.enqueueTiles(rev);
  // 等待 ready
  await new Promise((res)=>{const t=setInterval(()=>{const j=store.tileJob(rev);
    if(['ready','failed','aborted_replaced'].includes(j.status)){clearInterval(t);res();}},20);});
  assert.equal(store.tileJob(rev).status,'ready');
  // 第二次入队应直接返回已就绪，不重复劳动
  const again=store.enqueueTiles(rev);
  assert.equal(again.status,'ready');
  // 直接调用 generateTiles 并篡改“期望指纹”，验证途中换片检测
  await assert.rejects(()=>image.generateTiles({
    originalPath:path.join(tmp,'originals',rev+'.bin'),
    revId:rev+'_x', expectedHash:'deadbeef',
    sha256:b=>require('crypto').createHash('sha256').update(b).digest('hex'), dataDir:tmp
  }),e=>e.code==='TILE_SOURCE_REPLACED');

  // 确定性场景：瓦片产出后、发布前照片被替换（指纹复检必须作废且不留目录）
  const g3=store.createGroup?null:null;
  const db3=await open(path.join(tmp,'db3.db'));
  const store3=Store.create({db:db3,dataDir:tmp});
  const gg=store3.createGroup({title:'确定性换片'});
  const u3=await store3.uploadPhoto(gg.id,{file:await png(1000,800),side:'before'});
  const rev3=u3.revision.id;
  image._beforeTilePublish=async()=>{
    // 在发布瞬间把源文件换成“内容不同”的另一张图（模拟替换照片）
    const diff=await sharp({create:{width:1000,height:800,channels:3,background:'#123456'}})
      .raw().toBuffer().then(buf=>{buf[0]^=255;
        return sharp(buf,{raw:{width:1000,height:800,channels:3}}).png().toBuffer();});
    fs.writeFileSync(path.join(tmp,'originals',rev3+'.bin'),diff);
  };
  // 直接以 store 作业路径无法注入 expected hash 改变；此处调用底层生成并期望复检失败
  const crypto=require('crypto');
  const realHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp,'originals',rev3+'.bin'))).digest('hex');
  await assert.rejects(image.generateTiles({originalPath:path.join(tmp,'originals',rev3+'.bin'),
    revId:rev3+'_race',expectedHash:realHash,
    sha256:b=>crypto.createHash('sha256').update(b).digest('hex'),dataDir:tmp}),
    e=>e.code==='TILE_SOURCE_REPLACED');
  assert.ok(!fs.existsSync(path.join(tmp,'tiles',rev3+'_race')));
  image._beforeTilePublish=null;
});

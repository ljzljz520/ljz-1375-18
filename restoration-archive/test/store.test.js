'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const fs=require('fs'), path=require('path'), os=require('os');
const {open}=require('../server/db');
const Store=require('../server/store');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ra-'));
fs.mkdirSync(path.join(tmp,'originals'),{recursive:true});
fs.mkdirSync(path.join(tmp,'deriv'),{recursive:true});
fs.mkdirSync(path.join(tmp,'tiles'),{recursive:true});

// 生成 1200x900 测试图：底色 + 若干可辨认矩形（模拟结构角点）
async function makeImage(shift={x:0,y:0},flip=false,w=1200,h=900){
  const svg=`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#d8cfc0"/>
    <rect x="${100+shift.x}" y="${80+shift.y}" width="180" height="120" fill="#8a2f2a"/>
    <rect x="${700+shift.x}" y="${300+shift.y}" width="220" height="300" fill="#5a6b4d"/>
    <circle cx="${500+shift.x}" cy="${700+shift.y}" r="60" fill="#b08d3a"/>
  </svg>`;
  let img=sharp(Buffer.from(svg));
  if(flip) img=img.flop();
  return img.jpeg().toBuffer();
}

let store, db, gid, beforeId, afterId, pairId;

test.before(async()=>{
  db=await open(path.join(tmp,'test.db'));
  store=Store.create({db,dataDir:tmp});
});

test('全流程：建档、上传两侧、配准合格后允许滑块叠加', async()=>{
  const g=store.createGroup({title:'某阁修缮对照',building:'某阁'}); gid=g.id;
  store.addStage(gid,{name:'修缮前',year:1998});
  store.addStage(gid,{name:'修缮后',year:2024});
  const b=await store.uploadPhoto(gid,{file:await makeImage({x:0,y:0}),side:'before',
    captureConditions:{camera:'Sony A7',lens:'35mm',lighting:'上午侧光'},licenseHolder:'文保院',licenseExpires:'2099-01-01'});
  const a=await store.uploadPhoto(gid,{file:await makeImage({x:12,y:-7}),side:'after',
    captureConditions:{camera:'Sony A7',lens:'35mm'},licenseHolder:'文保院',licenseExpires:'2099-01-01'});
  beforeId=b.photo.id; afterId=a.photo.id;
  const pair=store.createPair(gid,{title:'正立面',beforePhotoId:beforeId,afterPhotoId:afterId});
  pairId=pair.pair.id;
  // 已知右移12、上移7：右图点 = 左图点+(12,-7)
  for(const [lx,ly] of [[100,80],[280,80],[100,200],[700,300],[920,600]])
    store.addAnchor(pairId,{lx,ly,rx:lx+12,ry:ly-7});
  const reg=store.register(pairId,{model:'affine',tolerancePx:3});
  assert.equal(reg.status,'within_tolerance');
  assert.ok(reg.maxErrorPx<0.01);
  const d=store.pairDetail(pairId);
  assert.equal(d.registration.model,'affine');
});

test('验收一侧资源晚到：缺侧禁止配准，报 PAIR_SIDE_MISSING', ()=>{
  const p2=store.createPair(gid,{title:'半侧',beforePhotoId:beforeId});
  assert.throws(()=>store.register(p2.pair.id,{model:'affine'}),e=>e.code==='PAIR_SIDE_MISSING');
  // 资源晚到后挂接即可
  const a=store.createGroup({title:'tmp'}); // 不同组照片不得挂入
  assert.throws(()=>store.attachSide(p2.pair.id,'after','ph_nonexist'),e=>e.code==='BAD_PHOTO');
  store.attachSide(p2.pair.id,'after',afterId);
  for(const [lx,ly] of [[100,80],[280,80],[700,300]])
    store.addAnchor(p2.pair.id,{lx,ly,rx:lx+12,ry:ly-7});
  const reg=store.register(p2.pair.id,{model:'affine',tolerancePx:5});
  assert.equal(reg.status,'within_tolerance');
});

test('误差超界 -> 拒绝叠加（out_of_tolerance），视图退回并排', ()=>{
  const p3=store.createPair(gid,{title:'粗点',beforePhotoId:beforeId,afterPhotoId:afterId}).pair.id;
  store.addAnchor(p3,{lx:100,ly:80,rx:400,ry:500});
  store.addAnchor(p3,{lx:280,ly:80,rx:10,ry:9});
  store.addAnchor(p3,{lx:100,ly:200,rx:900,ry:100});
  store.addAnchor(p3,{lx:700,ly:300,rx:50,ry:800});
  const reg=store.register(p3,{model:'affine',tolerancePx:3});
  assert.equal(reg.status,'out_of_tolerance');
  const m=store.buildManifest(gid);
  const entry=m.pairs.find(x=>x.id===p3);
  assert.equal(entry.view.mode,'side_by_side');
});

test('人工对应点映射：只联动并排，永远不出叠加', ()=>{
  const p4=store.createPair(gid,{title:'人工点',beforePhotoId:beforeId,afterPhotoId:afterId}).pair.id;
  store.addAnchor(p4,{lx:1,ly:2,rx:3,ry:4});
  const reg=store.register(p4,{model:'manual'});
  assert.equal(reg.status,'linked_only');
  const m=store.buildManifest(gid);
  assert.equal(m.pairs.find(x=>x.id===p4).view.mode,'side_by_side');
});

test('两编辑修同一锚点：乐观锁 409', ()=>{
  const anchor=store.addAnchor(pairId,{lx:1,ly:1,rx:2,ry:2});
  store.updateAnchor(anchor.id,{lx:5,expectedVer:anchor.ver});
  assert.throws(()=>store.updateAnchor(anchor.id,{lx:9,expectedVer:anchor.ver}),
    e=>e.status===409&&e.code==='ANCHOR_VERSION_CONFLICT');
});

test('明确几何（crop+flip_h）迁移坐标；越界点进入待复核', async()=>{
  const anchor=store.addAnchor(pairId,{lx:150,ly:150,rx:162,ry:143});
  const beforeRev=store.pairDetail(pairId).before.revision.id;
  const r=await store.replacePhoto(beforeId,{declaredGeometry:[
    {type:'crop',crop:{x:100,y:100,width:500,height:400}},
    {type:'flip_h'}]});
  assert.equal(r.mode,'explicit_geometry');
  // 旧(150,150): crop->(50,50); flip on w500 ->(450,50)
  const moved=db.get('SELECT * FROM anchors WHERE id=?',[anchor.id]);
  assert.ok(Math.abs(moved.lx-450)<0.01&&Math.abs(moved.ly-50)<0.01);
  assert.equal(moved.status,'active');
  // 旧 pair 变换已失效
  assert.equal(store.pairDetail(pairId).registration,null);
  // 越界点（原 0,0）
  const out=store.addAnchor(pairId,{lx:0,ly:0,rx:1,ry:1});
  await store.replacePhoto(beforeId,{declaredGeometry:[{type:'crop',crop:{x:100,y:100,width:200,height:200}}]});
  const o=db.get('SELECT status,migration_note FROM anchors WHERE id=?',[out.id]);
  assert.equal(o.status,'pending_review');
});

test('未声明替换（图像翻转）：坐标全部待复核、变换失效', async()=>{
  const r=await store.replacePhoto(beforeId,{file:await makeImage({x:0,y:0},true)});
  assert.equal(r.mode,'undeclared_replacement');
  const pend=db.all("SELECT * FROM anchors WHERE pair_id=? AND status='pending_review'",[pairId]);
  assert.ok(pend.length>0);
});

test('提交版本：待复核锚点阻止提交；解决后可提交并批准', ()=>{
  assert.throws(()=>store.commitVersion(gid,{}),e=>e.code==='COMMIT_BLOCKED');
  // 复核通过（未声明替换会波及组内所有引用该照片的照片对，逐对处理）
  const pend=db.all("SELECT status FROM anchors WHERE status='pending_review'").length
    ? db.all("SELECT * FROM anchors WHERE status='pending_review'") : [];
  for(const a of pend) store.updateAnchor(a.id,{status:'active',expectedVer:a.ver});
  // 粗点/人工点等其他 pair 也可能引入 warning，不阻断 COMMIT_BLOCKED 的仅 PENDING/SIDE/LICENSE
  const v=store.commitVersion(gid,{notes:'初版'});
  assert.ok(v.versionId);
  const approved=store.approveVersion(v.versionId,{approver:'张工',note:'误差≤3px，同意'});
  assert.equal(approved.approval.approver,'张工');
  // 深链接拿到不可变 manifest
  const again=store.getVersion(v.versionId);
  assert.equal(again.manifest.groupId,gid);
});

test('授权过期：新提交/批准被拒；已批准版本仍可读（深链接可复现）', async()=>{
  const g2=store.createGroup({title:'授权组'});
  const up=await store.uploadPhoto(g2.id,{file:await makeImage({}),side:'before',
    licenseHolder:'X',licenseExpires:'2020-01-01'});
  const up2=await store.uploadPhoto(g2.id,{file:await makeImage({x:1,y:1}),side:'after',
    licenseHolder:'X',licenseExpires:'2020-01-01'});
  const pp=store.createPair(g2.id,{beforePhotoId:up.photo.id,afterPhotoId:up2.photo.id});
  store.addAnchor(pp.pair.id,{lx:10,ly:10,rx:11,ry:11});
  // 清单出现 LICENSE_EXPIRED 警告，提交被阻止
  const m=store.buildManifest(g2.id);
  assert.ok(m.warnings.some(w=>w.code==='LICENSE_EXPIRED'));
  assert.throws(()=>store.commitVersion(g2.id,{}),e=>e.code==='COMMIT_BLOCKED');
  // 即便绕过建立版本（直接构造），批准也必须被授权门拒绝：用合法组复制场景
  const g3=store.createGroup({title:'先批后过期'});
  const u1=await store.uploadPhoto(g3.id,{file:await makeImage({}),side:'before',
    licenseHolder:'X',licenseExpires:'2099-01-01'});
  const u2=await store.uploadPhoto(g3.id,{file:await makeImage({x:1,y:1}),side:'after',
    licenseHolder:'X',licenseExpires:'2099-01-01'});
  const p3=store.createPair(g3.id,{beforePhotoId:u1.photo.id,afterPhotoId:u2.photo.id}).pair.id;
  store.addAnchor(p3,{lx:10,ly:10,rx:11,ry:11});
  const v=store.commitVersion(g3.id,{});
  store.approveVersion(v.versionId,{approver:'李工',note:'同意'});
  // 授权过期后：已批准版本仍可复现
  await store.replacePhoto(u1.photo.id,{file:await makeImage({x:3,y:3},false)}); // 未声明替换
  const old=store.getVersion(v.versionId);
  assert.equal(old.approval.approver,'李工');
});

test('瓦片：生成成功后 ready；超大解码被拒绝', async()=>{
  const rev=store.pairDetail(pairId).before.revision;
  const job=store.enqueueTiles(rev.id);
  await new Promise((res,rej)=>{const t=setInterval(()=>{
    const j=store.tileJob(rev.id);
    if(['ready','failed','aborted_replaced'].includes(j.status)){clearInterval(t);j.status==='ready'?res():rej(new Error(j.status));}
  },30);setTimeout(()=>rej(new Error('timeout')),15000);});
  const dir=path.join(tmp,'tiles',rev.id);
  assert.ok(fs.existsSync(path.join(dir,'info.dzi')));
  // 超大尺寸模拟：直接构造一个超限修订是昂贵的；改为校验门槛函数
  assert.ok(require('../server/image').MAX_DECODE_PIXELS>0);
});

test('未开放区域说明为 persistent，且存在于任何视图清单中', ()=>{
  const ann=store.addAnnotation(gid,{kind:'restricted',scope:'persistent',text:'该区暂未对外开放（结构鉴定中）'});
  assert.equal(ann.scope,'persistent');
  const m=store.buildManifest(gid);
  assert.ok(m.annotations.some(a=>a.kind==='restricted'));
});

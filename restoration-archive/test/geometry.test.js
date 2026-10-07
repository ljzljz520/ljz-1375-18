'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../server/geometry');

test('完美仿射对应残差为0', ()=>{
  // x'=2x+0.1y+5 ; y'=0x+1.5y-3
  const T=[2,0,0.1,1.5,5,-3];
  const pts=[[10,20],[30,40],[50,10],[70,80],[90,60]];
  const corrs=pts.map(([x,y])=>{const [rx,ry]=G.applyAffine(T,x,y);return {lx:x,ly:y,rx,ry};});
  const r=G.evaluateAffine(corrs,{tolerancePx:3});
  assert.equal(r.status,'within_tolerance');
  assert.ok(r.maxErrorPx<1e-6);
  assert.equal(r.fallback,null);
});

test('对应点不足3个 -> unavailable，退回并排', ()=>{
  const r=G.evaluateAffine([{lx:0,ly:0,rx:1,ry:1},{lx:2,ly:2,rx:3,ry:3}],{tolerancePx:3});
  assert.equal(r.status,'unavailable');
  assert.equal(r.fallback,'side_by_side');
  assert.equal(G.decideView(r).mode,'side_by_side');
});

test('共线点导致退化 -> unavailable', ()=>{
  const c=[{lx:0,ly:0,rx:0,ry:0},{lx:10,ly:10,rx:10,ry:10},{lx:20,ly:20,rx:20,ry:20}];
  const r=G.evaluateAffine(c,{tolerancePx:3});
  assert.equal(r.status,'unavailable');
  assert.equal(r.reason,'AFFINE_DEGENERATE');
});

test('误差超界 -> out_of_tolerance 并强制并排（不得仅拉宽高冒充可比）', ()=>{
  const c=[{lx:0,ly:0,rx:0,ry:0},{lx:100,ly:0,rx:101,ry:0},{lx:0,ly:100,rx:0,ry:90},{lx:100,ly:100,rx:130,ry:100}];
  const r=G.evaluateAffine(c,{tolerancePx:3});
  assert.equal(r.status,'out_of_tolerance');
  assert.ok(r.maxErrorPx>3);
  assert.equal(G.decideView(r).mode,'side_by_side');
});

test('拟合出镜像翻转的行列式 -> 拒绝叠加', ()=>{
  // 手工构造 y 翻转对应
  const c=[{lx:0,ly:0,rx:0,ry:100},{lx:100,ly:0,rx:100,ry:100},{lx:0,ly:100,rx:0,ry:0},{lx:100,ly:100,rx:100,ry:0}];
  const r=G.evaluateAffine(c,{tolerancePx:1000});
  assert.notEqual(r.status,'within_tolerance');
});

test('人工对应点映射永远 linked_only，不产生滑块叠加', ()=>{
  const m=G.evaluateManual([{id:'a',lx:1,ly:2,rx:3,ry:4}]);
  assert.equal(m.status,'linked_only');
  assert.equal(G.decideView(m).mode,'side_by_side');
  assert.equal(G.evaluateManual([]).status,'unavailable');
});

test('仿射复合与求逆互逆', ()=>{
  const T=[2,0.3,0.1,1.5,5,-3];
  const inv=G.invert(T); assert.ok(inv);
  const id=G.compose(inv,T);
  for(let i=0;i<6;i++) assert.ok(Math.abs(id[i]-(i%3===0?1:0))<1e-9);
});

test('裁切迁移：落在裁切框内的点平移，框外点 -> 待复核(null)', ()=>{
  const step=G.opTransform({type:'crop',width:1000,height:800,crop:{x:100,y:50,width:400,height:300}});
  assert.deepEqual(G.migratePoint(200,150,step.transform,step.width,step.height),[100,100]);
  assert.equal(G.migratePoint(0,0,step.transform,step.width,step.height),null);
});

test('方向变化迁移：rotate90cw (x,y)->(h-y,x)', ()=>{
  const step=G.opTransform({type:'rotate90cw',width:1000,height:800});
  assert.deepEqual(G.migratePoint(10,20,step.transform,step.width,step.height),[780,10]);
  assert.equal(step.width,800); assert.equal(step.height,1000);
});

test('flip_h 迁移且复合链 crop->flip 可复算', ()=>{
  const s1=G.opTransform({type:'crop',width:100,height:100,crop:{x:10,y:10,width:80,height:80}});
  const s2=G.opTransform({type:'flip_h',width:s1.width,height:s1.height});
  const chain=G.chainTransform([
    {type:'crop',width:100,height:100,crop:{x:10,y:10,width:80,height:80}},
    {type:'flip_h'}]);
  // 旧点(20,30): crop->(10,20); flip on w80 ->(70,20)
  assert.deepEqual(G.migratePoint(20,30,chain.transform,chain.width,chain.height),[70,20]);
});

test('凸包与点包含', ()=>{
  const hull=G.convexHull([[0,0],[10,0],[10,10],[0,10],[5,5]]);
  assert.equal(hull.length,4);
  assert.equal(G.pointInPoly(5,5,hull),true);
  assert.equal(G.pointInPoly(20,20,hull),false);
});

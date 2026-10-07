'use strict';
/* 比较渲染：滑块叠加 / 并排联动 / 文字注释引用同一 manifest 版本
 * 规则落地：
 *  - 只有 affine & within_tolerance 才允许滑块叠加；否则并排
 *  - 叠加裁剪到两侧锚点凸包交集，并挖除“修复新增部分”多边形
 *  - 未开放区域说明(kind=restricted,scope=persistent)任何图层切换都不消失 */
function polyHull(anchors,side){
  const pts=anchors.filter(a=>a.status==='active').map(a=>side==='L'?[a.lx,a.ly]:[a.rx,a.ry]);
  return convexHull(pts);
}
function convexHull(points){
  const pts=[...points].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if(pts.length<=2)return pts;
  const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lo=[];for(const p of pts){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}
  const up=[];for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}
  lo.pop();up.pop();return lo.concat(up);
}
// 左侧 hull 经 T 映射到右坐标系后，与右侧 hull 求交集：用 canvas 裁剪路径近似（双重 clip 与 evenodd 不够，
// 改为逐点判断保留左hull中落在右hull内的顶点，再求凸包）。
function warpHull(hull,T){ return hull.map(([x,y])=>[T[0]*x+T[2]*y+T[4],T[1]*x+T[3]*y+T[5]]); }
function pointInPoly(x,y,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
  if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside;}return inside;}
function intersectHull(hA,hB){
  if(hA.length<3||hB.length<3)return [];
  const keep=hA.filter(p=>pointInPoly(p[0],p[1],hB))
    .concat(hB.filter(p=>pointInPoly(p[0],p[1],hA)));
  // 再加边交点
  for(let i=0;i<hA.length;i++)for(let j=0;j<hB.length;j++){
    const p=segInt(hA[i],hA[(i+1)%hA.length],hB[j],hB[(j+1)%hB.length]); if(p)keep.push(p);
  }
  return convexHull(keep);
}
function segInt(a,b,c,d){
  const r=[b[0]-a[0],b[1]-a[1]],s=[d[0]-c[0],d[1]-c[1]];
  const den=r[0]*s[1]-r[1]*s[0]; if(!den)return null;
  const t=((c[0]-a[0])*s[1]-(c[1]-a[1])*s[0])/den;
  const u=((c[0]-a[0])*r[1]-(c[1]-a[1])*r[0])/den;
  if(t>=0&&t<=1&&u>=0&&u<=1)return [a[0]+t*r[0],a[1]+t*r[1]];
  return null;
}

async function renderComparison({host,pairEntry,photosById,annotations,layerState,onViewChange}){
  host.innerHTML='';
  const reg=pairEntry.registration;
  const beforeRevId=pairEntry.beforeRevId, afterRevId=pairEntry.afterRevId;
  if(!beforeRevId||!afterRevId){
    host.innerHTML='<div class="banner bad">照片对不完整：一侧验收资源晚到，仅可并排占位，暂不能比较。</div>';
    return;
  }
  const [dziB,dziA]=await Promise.all([loadDzi(beforeRevId),loadDzi(afterRevId)]);

  // 未开放区域说明：持久层，独立 DOM，切图层不移除
  const persistent=annotations.filter(a=>(!a.pairId||a.pairId===pairEntry.id)&&a.kind==='restricted');

  const mode=pairEntry.view&&pairEntry.view.mode; // overlay_slider | side_by_side
  if(mode==='overlay_slider'){
    const T=reg.transform;
    const hL=polyHull(pairEntry.anchors,'L'), hR=polyHull(pairEntry.anchors,'R');
    const wL=warpHull(hL,T);
    const hull=intersectHull(wL,hR);
    const holes=pairEntry.newStructurePolys||[]; // 右坐标系：挖除修复新增部分
    host.innerHTML=`
      <div class="slider-bar">
        <span class="muted">修缮前（经仿射配准）</span>
        <input type="range" min="0" max="100" value="50" id="split">
        <span class="muted">修缮后</span>
        <span class="tag ok">仿射叠加 maxErr=${reg.maxErrorPx}px ≤ ${reg.tolerancePx}px</span>
        ${hull.length<3?'<span class="tag bad">锚点凸包不足以界定有效域，不叠加</span>':'<span class="tag ok">叠加仅在锚点有效域内</span>'}
        ${holes.length?'<span class="tag warn">新增结构 '+holes.length+' 处不被旧图变形覆盖</span>':''}
      </div>
      <div class="canvas-host" id="ovhost"></div>
      <div class="muted">视角差异被限制在配准模型内：透视/遮挡/结构变化超出仿射能力时，本视图自动不可用并退回并排。</div>`;
    const ovhost=host.querySelector('#ovhost');
    const rightHost=document.createElement('div');
    rightHost.style.cssText='position:absolute;inset:0';
    const leftHost=document.createElement('div');
    leftHost.style.cssText='position:absolute;inset:0;clip-path:inset(0 50% 0 0)';
    const line=document.createElement('div');
    line.style.cssText='position:absolute;top:0;bottom:0;width:2px;background:var(--gold);left:50%;z-index:20;pointer-events:none';
    ovhost.append(rightHost,leftHost,line);
    persistent.forEach(n=>ovhost.appendChild(persistNode(n)));
    // 两个视图都以“右图像素系”为基准屏幕布局；左图瓦片绘制前乘配准矩阵 T
    const vR=new DziViewer(rightHost,dziA,{layers:[{revId:afterRevId,dzi:dziA}]});
    const vL=new DziViewer(leftHost,dziA,{layers:[{revId:beforeRevId,dzi:dziB,pre:T,
      clip:hull.length>=3?{hull,holes}:null}]});
    vR.fit();
    const f={scale:vR.scale,tx:vR.tx,ty:vR.ty};
    vL.setView(f.scale,f.tx,f.ty);
    const sync=(src,dst)=>{src.onview=()=>{dst.setView(src.scale,src.tx,src.ty);f.scale=src.scale;f.tx=src.tx;f.ty=src.ty;};};
    sync(vR,vL);sync(vL,vR);
    const splitEl=host.querySelector('#split');
    splitEl.oninput=()=>{const sp=+splitEl.value;
      leftHost.style.clipPath=`inset(0 ${100-sp}% 0 0)`; line.style.left=sp+'%';};
    bindLayerChips(host,layerState,()=>applyLayers(vR,vL,pairEntry,layerState,T,hull,holes));
    applyLayers(vR,vL,pairEntry,layerState,T,hull,holes);
    drawAnchorMarks(vR,host,pairEntry,'R',layerState);
    onViewChange&&onViewChange({mode:'overlay_slider',rmse:reg.rmsePx,maxError:reg.maxErrorPx});
  }else{
    const reason=pairEntry.view?pairEntry.view.reason:'NO_REGISTRATION';
    host.innerHTML=`
      <div class="pillbar">
        <span class="tag warn">并排观察（未通过配准门：${reason}）</span>
        ${reg?`<span class="tag ${reg.status==='linked_only'?'':'bad'}">模型=${reg.model} 状态=${reg.status}${reg.maxErrorPx!=null?' 最大误差='+reg.maxErrorPx+'px / 界限 '+reg.tolerancePx+'px':''}</span>`:''}
        <span class="muted">两侧联动平移缩放；不做像素叠加，避免把视点差异伪装成可比性。</span>
      </div>
      <div class="pair-grid">
        <div><div class="muted">修缮前</div><div class="canvas-host" id="bhost"></div></div>
        <div><div class="muted">修缮后</div><div class="canvas-host" id="ahost"></div></div>
      </div>`;
    const grid=host.querySelector('.pair-grid');
    persistent.forEach(n=>{const el=persistNode(n);el.style.right='20px';el.style.bottom='20px';grid.style.position='relative';grid.appendChild(el);});
    const vB=new DziViewer(host.querySelector('#bhost'),dziB,{layers:[{revId:beforeRevId,dzi:dziB}]});
    const vA=new DziViewer(host.querySelector('#ahost'),dziA,{layers:[{revId:afterRevId,dzi:dziA}]});
    vB.fit();vA.fit();
    // 并排用各自图像坐标系，联动只同步“相对视图参数”（fit 后比例一致即可）
    vB.link(vA);
    drawCorrespondence(vB,vA,pairEntry,host);
    bindLayerChips(host,layerState,()=>{vB.requestDraw();vA.requestDraw();drawCorrespondence(vB,vA,pairEntry,host);});
    onViewChange&&onViewChange({mode:'side_by_side',reason});
  }
}

function applyLayers(vR,vL,pairEntry,layerState,T,hull,holes){
  const showBefore=layerState.baseline!==false, showAfter=layerState.restoration!==false;
  vR.opts.layers=[{revId:pairEntry.afterRevId,visible:showAfter}];
  vL.opts.layers=[{revId:pairEntry.beforeRevId,pre:T,visible:showBefore,
    clip:hull.length>=3?{hull,holes}:null}];
  vR.requestDraw();vL.requestDraw();
}
function bindLayerChips(host,state,cb){
  const bar=document.createElement('div');
  bar.className='pillbar';
  bar.innerHTML=`
    <span class="layer-chip ${state.baseline!==false?'':'off'}" data-l="baseline">◳ 修缮前图层</span>
    <span class="layer-chip ${state.restoration!==false?'':'off'}" data-l="restoration">◳ 修缮后图层</span>
    <span class="layer-chip ${state.anchors!==false?'':'off'}" data-l="anchors">⚑ 锚点</span>
    <span class="tag" style="cursor:default">⛳ 未开放区域说明（持久，不可关闭）</span>`;
  bar.querySelectorAll('[data-l]').forEach(el=>el.onclick=()=>{
    const l=el.dataset.l; state[l]=state[l]===false;
    el.classList.toggle('off',state[l]===false); cb();
  });
  host.prepend(bar);
}
function persistNode(n){
  const d=document.createElement('div');d.className='persist-note';
  d.innerHTML=`<b>未开放区域</b><br>${escapeHtml(n.text)}`;
  if(n.x!=null)d.style.left='10px',d.style.top='10px';
  else {d.style.right='14px';d.style.top='14px';}
  return d;
}
function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

function drawAnchorMarks(viewer,host,pairEntry,side,state){
  // 轻量：在 overlay canvas 上绘制右图侧锚点
  const orig=viewer.drawExtra;
  viewer.drawExtra=(ctx)=>{
    if(state.anchors===false)return;
    ctx.fillStyle='#ffe08a';ctx.strokeStyle='#8a2f2a';ctx.lineWidth=1.5;
    for(const a of pairEntry.anchors){
      const x=side==='R'?a.rx:a.rx, y=side==='R'?a.ry:a.ry;
      const [sx,sy]=viewer.toScreen(x,y);
      ctx.beginPath();ctx.arc(sx,sy,5,0,Math.PI*2);ctx.fill();ctx.stroke();
      if(a.status!=='active'){ctx.fillStyle='#f66';ctx.fillText('待复核',sx+8,sy);ctx.fillStyle='#ffe08a';}
    }
  };
  viewer.requestDraw();
}
function drawCorrespondence(vB,vA,pairEntry,host){
  // 并排模式：各画布自身 overlay 上画锚点；跨图连线在网格上方另建一层用屏幕坐标连接
  host.querySelectorAll('.conn-svg').forEach(e=>e.remove());
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','conn-svg');
  svg.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:15';
  host.querySelector('.pair-grid').appendChild(svg);
  function redraw(){
    svg.innerHTML='';
    for(const a of pairEntry.anchors){
      if(a.status!=='active')continue;
      const [x1,y1]=vB.toScreen(a.lx,a.ly),[x2,y2]=vA.toScreen(a.rx,a.ry);
      const r1=vB.host.getBoundingClientRect(),gr=svg.getBoundingClientRect(),
            r2=vA.host.getBoundingClientRect();
      const ln=document.createElementNS('http://www.w3.org/2000/svg','line');
      ln.setAttribute('x1',r1.left-gr.left+x1);ln.setAttribute('y1',r1.top-gr.top+y1);
      ln.setAttribute('x2',r2.left-gr.left+x2);ln.setAttribute('y2',r2.top-gr.top+y2);
      ln.setAttribute('stroke','rgba(255,224,138,.9)');ln.setAttribute('stroke-dasharray','5 4');
      svg.appendChild(ln);
    }
  }
  vB.onview=()=>{vA.setView(vB.scale,vB.tx,vB.ty);redraw();};
  vA.onview=()=>{vB.setView(vA.scale,vA.tx,vA.ty);redraw();};
  setTimeout(redraw,60);
}

window.renderComparison=renderComparison;

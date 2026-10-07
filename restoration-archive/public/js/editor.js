'use strict';
const $=s=>document.querySelector(s);
const api=async(p,opts={})=>{
  const res=await fetch('/api'+p,opts);
  const j=await res.json().catch(()=>({}));
  if(!res.ok){ const e=new Error(j.error||('HTTP'+res.status));e.status=res.status;e.details=j.details;throw e; }
  return j;
};
const j=(o)=>JSON.stringify(o);
const postJSON=(p,o)=>api(p,{method:'POST',headers:{'Content-Type':'application/json'},body:j(o||{})});
const patchJSON=(p,o)=>api(p,{method:'PATCH',headers:{'Content-Type':'application/json'},body:j(o||{})});

let state={gid:null,detail:null,pairId:null,draftL:null,draftR:null,selected:null,layers:{baseline:true,restoration:true,anchors:true}};

async function init(){
  await loadGroups();
  $('#newGroup').onclick=async()=>{
    const g=await postJSON('/groups',{title:$('#gTitle').value||'未命名',building:$('#gBuilding').value});
    location.hash='#/g/'+g.id; await refresh();
  };
  $('#addStage').onclick=async()=>{await postJSON(`/groups/${state.gid}/stages`,{name:$('#stName').value,year:+$('#stYear').value||null});await refresh();};
  $('#uploadBtn').onclick=onUpload;
  $('#newPair').onclick=()=>createPair(false);
  $('#pairLate').onclick=()=>createPair(true);
  $('#btnAffine').onclick=()=>register('affine');
  $('#btnManual').onclick=()=>register('manual');
  $('#btnTiles').onclick=onTiles;
  $('#btnPoly').onclick=onPoly;
  $('#btnRestricted').onclick=onRestricted;
  $('#btnGeo').onclick=onGeo;
  $('#btnReplace').onclick=onReplace;
  $('#btnCommit').onclick=onCommit;
  $('#btnApprove').onclick=onApprove;
  window.addEventListener('hashchange',refresh);
  await refresh();
}
async function loadGroups(){
  const {groups}=await api('/groups');
  $('#groupList').innerHTML=groups.map(g=>`<a class="vlink" href="#/g/${g.id}" style="margin-right:14px">${g.title}</a>`).join('')||'<span class="muted">尚无档案</span>';
}
async function refresh(){
  await loadGroups();
  const m=location.hash.match(/#\/g\/([\w]+)/);
  if(!m){$('#workspace').style.display='none';return;}
  state.gid=m[1]; $('#workspace').style.display='block';
  try{ state.detail=await api('/groups/'+state.gid); }
  catch(e){ alert('档案不存在'); return; }
  $('#gTitle2').textContent=state.detail.group.title+' — '+ (state.detail.group.building||'');
  $('#stageList').innerHTML=state.detail.stages.map(s=>`<span class="tag">${s.name} ${s.year||''}</span>`).join(' ');
  renderPhotoList(); renderPairSelects(); renderPairs(); renderVersions();
  if(state.pairId) await openPair(state.pairId);
}
function photoTag(ph){return `${ph.id.slice(-5)} [${ph.side==='before'?'前':'后'}] ${ph.revision.width}×${ph.revision.height}`;}
function renderPhotoList(){
  $('#photoList').html='';
  $('#photoList').innerHTML=state.detail.photos.map(ph=>{
    const cc=JSON.parse(ph.revision.capture_conditions||'{}');
    const exp=ph.revision.license_expires;
    const expired=exp&&exp<new Date().toISOString().slice(0,10);
    return `<div>📷 ${photoTag(ph)} rev${ph.revision.rev_no}
      <span class="tag ${expired?'bad':'ok'}">授权：${ph.revision.license_holder||'—'} ${exp?('至 '+exp+(expired?'（已过期）':'')):'长期'}</span>
      <span class="muted">${Object.entries(cc).map(([k,v])=>k+'='+v).join(' ')}</span></div>`;
  }).join('');
}
function renderPairSelects(){
  for(const [sel,side] of [['#pairB','before'],['#pairA','after']]){
    $(sel).innerHTML='<option value="">（晚到，留空）</option>'+
      state.detail.photos.filter(p=>p.side===side).map(p=>`<option value="${p.id}">${photoTag(p)}</option>`).join('');
  }
}
function renderPairs(){
  $('#pairList').innerHTML=state.detail.pairs.map(d=>{
    const p=d.pair; const complete=d.before&&d.after;
    const reg=d.registration;
    return `<div style="margin:4px 0"><a class="vlink" href="#" data-pid="${p.id}">${p.title||p.id.slice(-5)}</a>
      ${complete?'':'<span class="tag warn">一侧晚到</span>'}
      ${reg?`<span class="tag ${reg.status==='within_tolerance'?'ok':'warn'}">${reg.model}/${reg.status}${reg.max_error_px!=null?' '+reg.max_error_px+'px':''}</span>`:'<span class="tag">未配准</span>'}
      </div>`;
  }).join('');
  $('#pairList').querySelectorAll('a[data-pid]').forEach(a=>a.onclick=e=>{
    e.preventDefault(); state.pairId=a.dataset.pid; openPair(state.pairId);
  });
}
async function createPair(late){
  const body={title:$('#pairTitle').value||'对照',
    beforePhotoId:$('#pairB').value||null,
    afterPhotoId:late?null:($('#pairA').value||null)};
  const d=await postJSON(`/groups/${state.gid}/pairs`,body);
  state.pairId=d.pair.id; await refresh();
}
async function onUpload(){
  const f=$('#upFile').files[0]; if(!f)return alert('选文件');
  const fd=new FormData();
  fd.append('file',f); fd.append('side',$('#upSide').value);
  fd.append('captureConditions',JSON.stringify({camera:$('#upCamera').value,lighting:$('#upLight').value}));
  fd.append('licenseHolder',$('#upLicense').value);
  if($('#upExpires').value)fd.append('licenseExpires',$('#upExpires').value);
  try{
    await api(`/groups/${state.gid}/photos`,{method:'POST',body:fd}); await refresh();
  }catch(e){ if(e.status===422)alert('拒绝：超大解码任务，像素超过服务器上限（'+(e.details?.limit)+'）'); else alert(e.message); }
}

// ---------- 照片对编辑 ----------
let imgs={before:null,after:null};
async function openPair(pairId){
  $('#pairEditor').style.display='block';
  const d=await api('/pairs/'+pairId); state._pair=d;
  $('#peTitle').textContent=d.pair.title||'照片对';
  banners(d);
  imgs.before=await loadImg(d.before.revision.id).catch(()=>null);
  imgs.after=d.after?await loadImg(d.after.revision.id).catch(()=>null):null;
  drawCanvas('cvB',imgs.before,d,'L'); drawCanvas('cvA',imgs.after,d,'R');
  drawAnchorTable(d);
  await mountViewer(d);
}
function banners(d){
  const m=state.detail.manifest;
  const w=(m.warnings||[]).filter(x=>x.pairId===d.pair.id);
  let html='';
  if(!d.before||!d.after){ const missing=!d.before?'before':'after';
    const opts=state.detail.photos.filter(x=>x.side===missing).map(x=>`<option value="${x.id}">${photoTag(x)}</option>`).join('');
    html+=`<div class="banner bad">一侧验收资源晚到：照片对不完整，不可配准。资源到达后挂接：
      <select id="lateSel">${opts}</select> <button id="lateAttach" class="ghost">挂接${missing==='before'?'前':'后'}侧</button></div>`;
  }
  if(d.registration?.stale) html+=`<div class="banner warn">照片几何已变化，旧配准失效，需重新设置锚点并配准。</div>`;
  for(const x of w) html+=`<div class="banner ${x.code==='LICENSE_EXPIRED'?'bad':'info'}">${x.text||x.code} ${x.date||x.count||''}</div>`;
  $('#peBanners').innerHTML=html;
  const la=$('#lateAttach'); if(la)la.onclick=async()=>{const missing=!d.before?'before':'after';
    await postJSON(`/pairs/${state.pairId}/attach`,{side:missing,photoId:$('#lateSel').value});await refresh();};
}
async function loadImg(revId){
  // 优先瓦片就绪后可在此换 DZI；编辑器统一用 1600px 派生图，坐标按比例换算
  return new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src='/deriv/'+revId+'.jpg';});
}
function drawCanvas(id,img,d,side){
  const cv=$(id); const ctx=cv.getContext('2d');
  cv.width=560;cv.height=420;ctx.fillStyle='#222';ctx.fillRect(0,0,cv.width,cv.height);
  if(!img){ctx.fillStyle='#caa';ctx.fillText('该侧资源未到达',20,40);return;}
  const rev=side==='L'?d.before.revision:d.after.revision;
  const k=Math.min(cv.width/img.width,cv.height/img.height);
  const w=img.width*k,h=img.height*k,ox=(cv.width-w)/2,oy=(cv.height-h)/2;
  ctx.drawImage(img,ox,oy,w,h);
  ctx.scaleK={k,ox,oy,revW:rev.width,revH:rev.height};
  // 新增结构多边形
  if(side==='R') for(const poly of JSON.parse(d.pair.new_structure_polys||'[]')){
    ctx.beginPath();poly.forEach(([x,y],i)=>{const [sx,sy]=toScreen(ctx,x,y);i?ctx.lineTo(sx,sy):ctx.moveTo(sx,sy);});
    ctx.closePath();ctx.fillStyle='rgba(176,141,58,.28)';ctx.strokeStyle='#ffcf5c';ctx.fill();ctx.stroke();
  }
  // 锚点
  for(const a of d.anchors){
    const x=side==='L'?a.lx:a.rx,y=side==='L'?a.ly:a.ry;
    if(x==null)continue; const [sx,sy]=toScreen(ctx,x,y);
    ctx.beginPath();ctx.arc(sx,sy,5,0,Math.PI*2);ctx.fillStyle=a.status==='active'?'#ffe08a':'#ff6b6b';ctx.fill();
    ctx.strokeStyle='#5a1a16';ctx.stroke();
    ctx.fillStyle='#fff';ctx.font='11px sans-serif';ctx.fillText(a.label||'',sx+7,sy-6);
  }
  if(!cv.bound){cv.bound=true;
    cv.onclick=e=>{
      if(cv.drawingPoly)return; // 新增结构圈选占用该画布
      const rect=cv.getBoundingClientRect();
      const ctx=cv.getContext('2d');const K=ctx.scaleK;
      const ix=(e.clientX-rect.left-K.ox)/K.k, iy=(e.clientY-rect.top-K.oy)/K.k;
      if(ix<0||iy<0||ix>K.revW||iy>K.revH)return;
      const d=state._pair, side=id==='cvB'?'L':'R';
      const sel=state.selected;
      if(sel){
        (sel.draft=sel.draft||{})[side]={x:+ix.toFixed(1),y:+iy.toFixed(1)};
        if(sel.draft.L&&sel.draft.R){
          const dd=sel.draft;
          patchJSON('/anchors/'+sel.id,{lx:dd.L.x,ly:dd.L.y,rx:dd.R.x,ry:dd.R.y,expectedVer:sel.ver})
            .then(()=>{state.selected=null;openPair(state.pairId)})
            .catch(err=>{state.selected=null; if(err.status===409){alert('409 冲突：另一编辑已修改该锚点（当前版本 '+err.details.currentVer+'），请重新选择');}openPair(state.pairId);});
        }
      }else{
        (state.draft=state.draft||{})[side]={x:+ix.toFixed(1),y:+iy.toFixed(1)};
        if(state.draft.L&&state.draft.R){
          const dd=state.draft;
          postJSON(`/pairs/${state.pairId}/anchors`,{lx:dd.L.x,ly:dd.L.y,rx:dd.R.x,ry:dd.R.y,label:'锚'+(d.anchors.length+1)})
            .then(()=>{state.draft=null;openPair(state.pairId);});
        }else{
          const c2=cv.getContext('2d');const [sx,sy]=toScreen(c2,ix,iy);
          c2.beginPath();c2.arc(sx,sy,6,0,Math.PI*2);c2.strokeStyle='#7fffd4';c2.lineWidth=2;c2.stroke();
        }
      }
    };
  }
}
function toScreen(ctx,x,y){const K=ctx.scaleK;return [x*K.k+K.ox,y*K.k+K.oy];}
function drawAnchorTable(d){
  const tb=$('#anchorTable').querySelector('tbody');
  tb.innerHTML=d.anchors.map(a=>`<tr>
    <td>${a.label||''}</td><td>${a.lx},${a.ly}</td><td>${a.rx},${a.ry}</td>
    <td><span class="tag ${a.status==='active'?'ok':'bad'}">${a.status==='active'?'有效':'待复核'}</span>
        ${a.migration_note?`<div class="muted">${a.migration_note}</div>`:''}</td>
    <td>v${a.ver}</td>
    <td><button class="ghost" data-sel="${a.id}">选点改位</button>
        <button class="ghost" data-ok="${a.id}" ${a.status==='active'?'disabled':''}>复核通过</button>
        <button class="ghost" data-del="${a.id}">删</button></td></tr>`).join('');
  tb.querySelectorAll('[data-sel]').forEach(b=>b.onclick=()=>{state.selected=d.anchors.find(x=>x.id===b.dataset.sel);
    alert('已选择锚点 '+state.selected.label+'，请依次在左、右画布点击同名实物点的新位置（两侧都点完才提交）');});
  tb.querySelectorAll('[data-ok]').forEach(b=>b.onclick=async()=>{
    const a=d.anchors.find(x=>x.id===b.dataset.ok);
    await patchJSON('/anchors/'+a.id,{status:'active',migration_note:'人工复核确认',expectedVer:a.ver});
    openPair(state.pairId);});
  tb.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{
    await fetch('/api/anchors/'+b.dataset.del,{method:'DELETE'});openPair(state.pairId);});
}
async function register(model){
  try{
    const r=await postJSON(`/pairs/${state.pairId}/register`,{model,tolerancePx:+$('#tol').value||3});
    const map={within_tolerance:`仿射合格：RMSE=${r.rmsePx}px，最大误差=${r.maxErrorPx}px（界限 ${r.tolerancePx}px），允许滑块叠加`,
      out_of_tolerance:`误差超界（最大 ${r.maxErrorPx}px > ${r.tolerancePx}px）：强制并排，不得叠加`,
      linked_only:'人工对应点映射：仅并排联动+连线，不产生全局叠加',
      unavailable:'无法配准（'+r.reason+'）：退回并排观察'};
    alert((map[r.status]||r.status)+(r.anchorsExcluded?`\n排除了 ${r.anchorsExcluded} 个非当前修订/待复核锚点`:''));
    await refresh();
  }catch(e){alert(e.message+(e.details?.reason?('\n'+e.details.reason):''));}
}
async function onTiles(){
  const d=state._pair;
  for(const side of ['before','after']){
    if(!d[side])continue;
    const rev=d[side].revision.id;
    const job=await postJSON('/tiles/jobs/'+rev,{});
    if(job.status==='rejected_oversize')return alert('超大图，服务器拒绝瓦片解码');
  }
  alert('瓦片作业已入队（服务端并发受限，生成中）。完成后视图自动使用瓦片。');
  pollTiles();
}
async function pollTiles(){
  const d=state._pair;
  const timer=setInterval(async()=>{
    for(const side of ['before','after']){
      if(!d[side])continue;
      const j=await api('/tiles/jobs/'+d[side].revision.id);
      if(j.status==='ready'){clearInterval(timer);await openPair(state.pairId);}
      if(j.status==='aborted_replaced'){clearInterval(timer);alert('瓦片作废：生成途中照片被替换');}
    }
  },1200);
}
let polyDraft=[];
async function onPoly(){
  alert('在“修缮后”画布上依次点击 ≥3 个点，圈出修复后新增结构；该区域将从旧图叠加中挖除，不被扭曲。完成后再点一次本按钮。');
  const cv=$('#cvA');
  if(cv.drawingPoly){
    cv.drawingPoly=false;
    cv.removeEventListener('click',cv._polyHandler);
    await patchJSON(`/pairs/${state.pairId}/new-structure`,{polys:[polyDraft]});
    polyDraft=[];openPair(state.pairId);return;
  }
  cv.drawingPoly=true;
  cv._polyHandler=e=>{
    const rect=cv.getBoundingClientRect(),ctx=cv.getContext('2d'),K=ctx.scaleK;
    const px=+((e.clientX-rect.left-K.ox)/K.k).toFixed(1),
          py=+((e.clientY-rect.top-K.oy)/K.k).toFixed(1);
    polyDraft.push([px,py]);
    const [sx,sy]=toScreen(ctx,px,py);
    ctx.beginPath();ctx.arc(sx,sy,5,0,Math.PI*2);ctx.strokeStyle='#ffcf5c';ctx.lineWidth=2;ctx.stroke();
  };
  cv.addEventListener('click',cv._polyHandler);
}
async function onRestricted(){
  const text=prompt('未开放区域说明（切任何图层都保持显示）：');
  if(text) await postJSON(`/groups/${state.gid}/annotations`,{kind:'restricted',scope:'persistent',pairId:state.pairId,text});
  await refresh();
}
async function onGeo(){
  const side=$('#geoSide').value, type=$('#geoOp').value;
  const d=state._pair; const photoId=side==='before'?d.pair.before_photo_id:d.pair.after_photo_id;
  const rev=side==='before'?d.before.revision:d.after.revision;
  const ops=[];
  if(type==='crop') ops.push({type:'crop',crop:{x:Math.round(rev.width*0.2),y:Math.round(rev.height*0.2),
    width:Math.round(rev.width*0.6),height:Math.round(rev.height*0.6)}});
  else ops.push({type});
  if(!confirm(`对${side==='before'?'前':'后'}侧执行：${ops.map(o=>o.type).join('+')}\n标注坐标将按明确变换迁移，越界点进入待复核。继续？`))return;
  const fd=new FormData();fd.append('declaredGeometry',JSON.stringify(ops));
  try{ await api('/photos/'+photoId+'/revisions',{method:'POST',body:fd}); await refresh(); }
  catch(e){alert(e.message);}
}
async function onReplace(){
  const f=$('#replaceFile').files[0]; if(!f)return alert('选替换文件');
  const side=$('#geoSide').value, d=state._pair;
  const photoId=side==='before'?d.pair.before_photo_id:d.pair.after_photo_id;
  if(!confirm('未声明几何关系直接替换（可能含翻转）：该侧所有锚点将进入待复核。继续？'))return;
  const fd=new FormData();fd.append('file',f);
  try{ await api('/photos/'+photoId+'/revisions',{method:'POST',body:fd}); await refresh(); }
  catch(e){ if(e.status===422)alert('超大解码被服务器拒绝');else alert(e.message); }
}
async function mountViewer(d){
  await refreshManifest();
  const host=$('#viewerHost');
  const entry=state.detail.manifest.pairs.find(x=>x.id===state.pairId);
  const photosById=Object.fromEntries(state.detail.photos.map(p=>[p.id,p]));
  await window.renderComparison({host, pairEntry:entry, photosById,
    annotations:state.detail.manifest.annotations, layerState:state.layers});
}
async function refreshManifest(){ state.detail.manifest=await api('/groups/'+state.gid+'/manifest'); }
async function onCommit(){
  try{ const v=await postJSON(`/groups/${state.gid}/versions`,{notes:$('#commitNote').value});
    alert('已提交版本 v'+v.verNo+'\n访客链接：/viewer.html#/v/'+v.versionId); await refresh(); }
  catch(e){ if(e.status===409){alert('提交被阻止：\n'+(e.details.warnings||[]).map(w=>'· '+(w.text||w.code)).join('\n'));} else alert(e.message); }
}
async function onApprove(){
  const list=(await api(`/groups/${state.gid}/versions`)).versions;
  const v=list[list.length-1]; if(!v)return alert('先提交版本');
  try{ await postJSON('/versions/'+v.id+'/approve',{approver:$('#approver').value,note:$('#approvalNote').value});
    alert('已批准 v'+v.ver_no); await refresh(); }
  catch(e){ if(e.status===409)alert('批准被拒：授权已过期\n'+JSON.stringify(e.details.expired));else alert('批准人必填'); }
}
function renderVersions(){
  const vs=state.detail?null:null;
  api(`/groups/${state.gid}/versions`).then(({versions})=>{
    $('#versionList').innerHTML=versions.map(v=>`<div>版本 v${v.ver_no}
      <span class="tag ${v.approved?'ok':''}">${v.approved?'已批准':'待批准'}</span>
      <a class="vlink" target="_blank" href="/viewer.html#/v/${v.id}">访客深链接 ↗</a></div>`).join('')||'<span class="muted">无版本</span>';
  });
}
init();

'use strict';
// ============================================================================
// store.js — 业务规则编排
// ============================================================================
const { id, sha256 }=require('./db');
const G=require('./geometry');
const IMG=require('./image');

class ApiError extends Error{ constructor(status,code,details){super(code);this.status=status;this.code=code;this.details=details||{};} }

function create({ db, dataDir }){
  const tileQueue=IMG.makeTileQueue({concurrency:Number(process.env.TILE_CONCURRENCY||1)});

  function currentRev(photoId){
    return db.get(`SELECT * FROM photo_revisions WHERE photo_id=? AND status='active' ORDER BY rev_no DESC LIMIT 1`,[photoId]);
  }
  function photo(pid){ return db.get('SELECT * FROM photos WHERE id=?',[pid]); }
  function pairCurrent(pairId){
    const p=db.get('SELECT * FROM pairs WHERE id=?',[pairId]);
    if(!p) throw new ApiError(404,'PAIR_NOT_FOUND');
    return p;
  }

  // ---------- 组 / 阶段 ----------
  function createGroup({title,building}){
    const gid=id('g'); db.run('INSERT INTO groups(id,title,building,created_at,updated_at) VALUES(?,?,?,?,?)',
      [gid,title,building||'',Date.now(),Date.now()]);
    return getGroup(gid);
  }
  function getGroup(gid){
    const g=db.get('SELECT * FROM groups WHERE id=?',[gid]);
    if(!g) throw new ApiError(404,'GROUP_NOT_FOUND');
    return g;
  }
  function listGroups(){ return db.all('SELECT * FROM groups ORDER BY created_at DESC'); }
  function addStage(gid,{name,year}){
    getGroup(gid); const sid=id('st');
    const ord=(db.get('SELECT COALESCE(MAX(ord),0)+1 o FROM stages WHERE group_id=?',[gid])||{}).o;
    db.run('INSERT INTO stages(id,group_id,name,year,ord) VALUES(?,?,?,?,?)',[sid,gid,name,year||null,ord]);
    return db.get('SELECT * FROM stages WHERE id=?',[sid]);
  }

  // ---------- 照片上传（验收一侧资源晚到 -> pair 缺侧，不允许配准）----------
  async function uploadPhoto(gid,{file,filename,mimetype,stageId,side,captureConditions,licenseHolder,licenseExpires}){
    getGroup(gid);
    const pid=id('ph'), rid=id('rv');
    try{
      const saved=await IMG.ingest(file,dataDir,rid);
      const hash=sha256(file);
      db.transaction(()=>{
        db.run(`INSERT INTO photos(id,group_id,stage_id,side,created_at) VALUES(?,?,?,?,?)`,
          [pid,gid,stageId||null,side,Date.now()]);
        db.run(`INSERT INTO photo_revisions
          (id,photo_id,rev_no,parent_rev_id,sha256,width,height,format,capture_conditions,
           license_holder,license_expires,declared_geometry,status,created_at)
          VALUES(?,?,1,NULL,?,?,?,?,?,?,?,?, 'active',?)`,
          [rid,pid,hash,saved.width,saved.height,saved.format,
           JSON.stringify(captureConditions||{}),licenseHolder||'',licenseExpires||null,
           JSON.stringify(null),Date.now()]);
      });
      return { photo:photo(pid), revision:currentRev(pid) };
    }catch(e){
      if(e.code==='IMAGE_TOO_LARGE') throw new ApiError(422,'IMAGE_TOO_LARGE',{pixels:e.pixels,limit:e.limit});
      throw e;
    }
  }

  // ---------- 照片几何操作（明确声明）或 被替换（未声明 -> 待复核）----------
  // 场景：裁切/旋转/翻转/方向变化（有 ops，显式迁移）；
  //       瓦片途中换片/换图（无 ops，坐标无法信任）。
  async function replacePhoto(photoId,{file,declaredGeometry,captureConditions,licenseHolder,licenseExpires}){
    const ph=photo(photoId); if(!ph) throw new ApiError(404,'PHOTO_NOT_FOUND');
    const oldRev=currentRev(photoId);
    const newRid=id('rv');
    const revNo=oldRev.rev_no+1;
    let saved, declared=null, mode;
    if(!file && !(Array.isArray(declaredGeometry) && declaredGeometry.length))
      throw new ApiError(400,'NO_FILE');
    if(Array.isArray(declaredGeometry) && declaredGeometry.length){
      // 明确变换：服务端执行几何 + 域层迁移标注坐标
      const oldPath=require('path').join(dataDir,'originals',oldRev.id+'.bin');
      try{ saved=await IMG.applyGeometry(oldPath,declaredGeometry,dataDir,newRid); }
      catch(e){ if(e.code==='IMAGE_TOO_LARGE') throw new ApiError(422,'IMAGE_TOO_LARGE',{pixels:e.pixels,limit:e.limit}); throw e; }
      declared=declaredGeometry; mode='explicit_geometry';
    }else{
      try{ saved=await IMG.ingest(file,dataDir,newRid); }
      catch(e){ if(e.code==='IMAGE_TOO_LARGE') throw new ApiError(422,'IMAGE_TOO_LARGE',{pixels:e.pixels,limit:e.limit}); throw e; }
      mode='undeclared_replacement';
    }
    const hash=sha256(require('fs').readFileSync(require('path').join(dataDir,'originals',newRid+'.bin')));

    db.transaction(()=>{
      db.run(`UPDATE photo_revisions SET status='replaced' WHERE id=?`,[oldRev.id]);
      db.run(`INSERT INTO photo_revisions
        (id,photo_id,rev_no,parent_rev_id,sha256,width,height,format,capture_conditions,
         license_holder,license_expires,declared_geometry,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active',?)`,
        [newRid,photoId,revNo,oldRev.id,hash,saved.width,saved.height,saved.format,
         JSON.stringify(captureConditions||JSON.parse(oldRev.capture_conditions||'{}')),
         licenseHolder??oldRev.license_holder, licenseExpires??oldRev.license_expires,
         JSON.stringify(declared),Date.now()]);

      // 找所有引用该照片的 pair
      const pairs=db.all(`SELECT * FROM pairs WHERE before_photo_id=? OR after_photo_id=?`,[photoId,photoId]);
      for(const p of pairs){
        const anchors=db.all(`SELECT * FROM anchors WHERE pair_id=?`,[p.id]);
        if(mode==='explicit_geometry'){
          // 用声明链复合变换迁移；链的原始尺寸取旧修订
          const chain=declared.map((op,i)=>({...op,
            width:i===0?oldRev.width:undefined, height:i===0?oldRev.height:undefined}));
          // chainTransform 需要每步 width/height，服务端按顺序推
          let t=[1,0,0,1,0,0], w=oldRev.width, h=oldRev.height;
          for(const op of declared){
            const step=G.opTransform({...op,width:w,height:h});
            if(step.error) throw new ApiError(400,step.error,{op});
            t=G.compose(step.transform,t); w=step.width; h=step.height;
          }
          for(const a of anchors){
            const isLeft=p.before_photo_id===photoId;
            const sx=isLeft?a.lx:a.rx, sy=isLeft?a.ly:a.ry;
            const moved=G.migratePoint(sx,sy,t,w,h);
            if(moved){
              db.run(`UPDATE anchors SET ${isLeft?'lx=?,ly=?':'rx=?,ry=?'},
                       ${isLeft?'left_rev_id=?':'right_rev_id=?'}, status='active',
                       migration_note=?, ver=ver+1, updated_at=? WHERE id=?`,
                isLeft?[moved[0],moved[1],newRid,'explicit:'+declared.map(o=>o.type).join('+'),Date.now(),a.id]
                      :[moved[0],moved[1],newRid,'explicit:'+declared.map(o=>o.type).join('+'),Date.now(),a.id]);
            }else{
              db.run(`UPDATE anchors SET ${isLeft?'left_rev_id=?':'right_rev_id=?'},
                       status='pending_review', migration_note=?, ver=ver+1, updated_at=? WHERE id=?`,
                [newRid,'迁移后越界，待复核',Date.now(),a.id]);
            }
          }
        }else{
          // 未声明替换（含图像翻转无法自动辨识）：坐标一律待复核
          for(const a of anchors){
            const isLeft=p.before_photo_id===photoId;
            db.run(`UPDATE anchors SET ${isLeft?'left_rev_id=?':'right_rev_id=?'},
                     status='pending_review', migration_note=?, ver=ver+1, updated_at=? WHERE id=?`,
              [newRid,'照片被替换且未声明几何关系（可能含翻转），坐标待复核',Date.now(),a.id]);
          }
        }
        // 无论哪种方式，旧对齐变换都基于旧像素系 -> 置 stale，需重新配准
        db.run(`UPDATE pair_transforms SET stale=1 WHERE pair_id=?`,[p.id]);
        // 新增结构多边形基于旧坐标系：显式迁移其顶点；未声明则清空待重绘
        if(mode==='explicit_geometry'){
          const polys=JSON.parse(p.new_structure_polys||'[]');
          let t=[1,0,0,1,0,0], w=oldRev.width, h=oldRev.height;
          for(const op of declared){ const st=G.opTransform({...op,width:w,height:h});
            t=G.compose(st.transform,t); w=st.width; h=st.height; }
          const np=polys.map(poly=>poly.map(([x,y])=>G.migratePoint(x,y,t,w,h)).filter(Boolean));
          db.run('UPDATE pairs SET new_structure_polys=?, ver=ver+1, updated_at=? WHERE id=?',
            [JSON.stringify(np.filter(poly=>poly.length>=3)),Date.now(),p.id]);
        }else{
          db.run(`UPDATE pairs SET new_structure_polys='[]', ver=ver+1, updated_at=? WHERE id=?`,[Date.now(),p.id]);
        }
      }
    });
    // 使任何在途瓦片作业失效（它们绑定旧 revId；针对旧 rev 的作业由其 hash 自检中止）
    return { mode, revision:currentRev(photoId) };
  }

  // ---------- 照片对 ----------
  function createPair(gid,{title,beforePhotoId,afterPhotoId}){
    getGroup(gid);
    if(beforePhotoId){ const b=photo(beforePhotoId); if(!b||b.group_id!==gid) throw new ApiError(400,'BAD_BEFORE_PHOTO'); }
    if(afterPhotoId){ const a=photo(afterPhotoId); if(!a||a.group_id!==gid) throw new ApiError(400,'BAD_AFTER_PHOTO'); }
    const pid=id('pr');
    db.run(`INSERT INTO pairs(id,group_id,before_photo_id,after_photo_id,title,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?)`,[pid,gid,beforePhotoId||null,afterPhotoId||null,title||'',Date.now(),Date.now()]);
    return pairDetail(pid);
  }
  // 一侧资源晚到：允许稍后挂接
  function attachSide(pairId,side,photoId){
    const p=pairCurrent(pairId);
    if(side!=='before'&&side!=='after') throw new ApiError(400,'BAD_SIDE');
    const ph=photo(photoId); if(!ph||ph.group_id!==p.group_id) throw new ApiError(400,'BAD_PHOTO');
    db.run(`UPDATE pairs SET ${side==='before'?'before_photo_id':'after_photo_id'}=?, ver=ver+1, updated_at=? WHERE id=?`,
      [photoId,Date.now(),pairId]);
    return pairDetail(pairId);
  }
  function setNewStructure(pairId,polys){
    pairCurrent(pairId);
    if(!Array.isArray(polys)) throw new ApiError(400,'BAD_POLYS');
    for(const poly of polys) if(!Array.isArray(poly)||poly.length<3) throw new ApiError(400,'POLY_NEEDS_3_POINTS');
    db.run('UPDATE pairs SET new_structure_polys=?, ver=ver+1, updated_at=? WHERE id=?',
      [JSON.stringify(polys),Date.now(),pairId]);
    return pairDetail(pairId);
  }

  // ---------- 锚点（乐观锁）----------
  function addAnchor(pairId,{label,lx,ly,rx,ry}){
    const p=pairCurrent(pairId);
    const before=p.before_photo_id?currentRev(p.before_photo_id):null;
    const after=p.after_photo_id?currentRev(p.after_photo_id):null;
    const aid=id('an');
    db.run(`INSERT INTO anchors(id,pair_id,label,lx,ly,rx,ry,left_rev_id,right_rev_id,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?, 'active',?,?)`,
      [aid,pairId,label||'',lx,ly,rx,ry,before?.id||null,after?.id||null,Date.now(),Date.now()]);
    return db.get('SELECT * FROM anchors WHERE id=?',[aid]);
  }
  function updateAnchor(aid,patch){
    const cur=db.get('SELECT * FROM anchors WHERE id=?',[aid]);
    if(!cur) throw new ApiError(404,'ANCHOR_NOT_FOUND');
    if(patch.expectedVer!=null && patch.expectedVer!==cur.ver)
      throw new ApiError(409,'ANCHOR_VERSION_CONFLICT',{currentVer:cur.ver});
    const fields=['label','lx','ly','rx','ry','status','migration_note'];
    const sets=[], vals=[];
    for(const f of fields) if(patch[f]!==undefined){ sets.push(f+'=?'); vals.push(patch[f]); }
    if('status' in patch && !['active','pending_review'].includes(patch.status))
      throw new ApiError(400,'BAD_ANCHOR_STATUS');
    if(!sets.length) return cur;
    sets.push('ver=ver+1','updated_at=?'); vals.push(Date.now(),aid);
    db.run(`UPDATE anchors SET ${sets.join(',')} WHERE id=?`,vals);
    return db.get('SELECT * FROM anchors WHERE id=?',[aid]);
  }
  function deleteAnchor(aid){
    const cur=db.get('SELECT * FROM anchors WHERE id=?',[aid]);
    if(!cur) throw new ApiError(404,'ANCHOR_NOT_FOUND');
    db.run('DELETE FROM anchors WHERE id=?',[aid]); return {deleted:true};
  }

  // ---------- 配准 ----------
  function register(pairId,{model='affine',tolerancePx=3}={}){
    const p=pairCurrent(pairId);
    if(!p.before_photo_id||!p.after_photo_id)
      throw new ApiError(409,'PAIR_SIDE_MISSING',{reason:'一侧资源晚到，尚不可配准'});
    const before=currentRev(p.before_photo_id), after=currentRev(p.after_photo_id);
    const anchors=db.all(`SELECT * FROM anchors WHERE pair_id=? AND status='active'
       AND left_rev_id=? AND right_rev_id=?`,[pairId,before.id,after.id]);
    const corrs=anchors.map(a=>({id:a.id,lx:a.lx,ly:a.ly,rx:a.rx,ry:a.ry}));
    let result;
    if(model==='manual') result=G.evaluateManual(corrs);
    else if(model==='affine') result=G.evaluateAffine(corrs,{tolerancePx});
    else throw new ApiError(400,'BAD_MODEL');
    const tid=id('tf');
    db.run(`INSERT INTO pair_transforms
      (id,pair_id,model,transform,rmse_px,max_error_px,tolerance_px,status,fallback,basis_revs,stale,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,0,?)`,
      [tid,pairId,model,result.transform?JSON.stringify(result.transform):null,
       result.rmsePx??null,result.maxErrorPx??null,tolerancePx,result.status,
       result.fallback||null,JSON.stringify({left:before.id,right:after.id}),Date.now()]);
    return { ...result, id:tid, basis:{left:before.id,right:after.id},
             anchorsUsed:corrs.length, anchorsExcluded:db.all('SELECT id,status,left_rev_id,right_rev_id FROM anchors WHERE pair_id=?',[pairId]).length-corrs.length };
  }
  function latestTransform(pairId){
    const t=db.get('SELECT * FROM pair_transforms WHERE pair_id=? ORDER BY created_at DESC LIMIT 1',[pairId]);
    return t&&!t.stale?t:null;
  }

  // ---------- 注释（未开放区域说明 = persistent，不随图层切换消失）----------
  function addAnnotation(gid,{pairId,kind,scope,layer,x,y,photoRevId,text}){
    getGroup(gid);
    const aid=id('an');
    db.run(`INSERT INTO annotations(id,group_id,pair_id,kind,scope,layer,x,y,photo_rev_id,text,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [aid,gid,pairId||null,kind,scope||(kind==='restricted'?'persistent':'layer'),
       layer||null,x??null,y??null,photoRevId||null,text,Date.now()]);
    return db.get('SELECT * FROM annotations WHERE id=?',[aid]);
  }

  // ---------- 版本快照与批准 ----------
  function buildManifest(gid){
    getGroup(gid);
    const photos=db.all('SELECT * FROM photos WHERE group_id=?',[gid]);
    const stages=db.all('SELECT * FROM stages WHERE group_id=? ORDER BY ord',[gid]);
    const pairs=db.all('SELECT * FROM pairs WHERE group_id=?',[gid]);
    const anns=db.all('SELECT * FROM annotations WHERE group_id=?',[gid]);
    const photoOut=[], pairOut=[];
    const warnings=[];
    for(const ph of photos){
      const rev=currentRev(ph.id);
      photoOut.push({ id:ph.id, side:ph.side, stageId:ph.stage_id,
        revision:{ id:rev.id, revNo:rev.rev_no, sha256:rev.sha256,
          width:rev.width, height:rev.height,
          captureConditions:JSON.parse(rev.capture_conditions||'{}'),
          licenseHolder:rev.license_holder, licenseExpires:rev.license_expires,
          hasTiles:!!db.get("SELECT id FROM tile_jobs WHERE rev_id=? AND status='ready'",[rev.id]) }});
    }
    const today=new Date().toISOString().slice(0,10);
    for(const p of pairs){
      const before=p.before_photo_id?currentRev(p.before_photo_id):null;
      const after=p.after_photo_id?currentRev(p.after_photo_id):null;
      if(!before||!after) warnings.push({pairId:p.id,code:'SIDE_MISSING',text:'一侧照片晚到，未形成照片对'});
      const anchors=before&&after?db.all(`SELECT * FROM anchors WHERE pair_id=? AND left_rev_id=? AND right_rev_id=?`,
        [p.id,before.id,after.id]):[];
      const pending=anchors.filter(a=>a.status!=='active');
      if(pending.length) warnings.push({pairId:p.id,code:'ANCHORS_PENDING',count:pending.length,text:'存在待复核锚点'});
      const t=latestTransform(p.id);
      let view={mode:'side_by_side',reason:'NO_CURRENT_TRANSFORM'};
      let reg=null;
      if(t){
        reg={ model:t.model, status:t.status, rmsePx:t.rmse_px, maxErrorPx:t.max_error_px,
          tolerancePx:t.tolerance_px, transform:t.transform?JSON.parse(t.transform):null,
          fallback:t.fallback };
        view=G.decideView(t.model==='affine'
          ? {model:'affine',status:t.status,transform:reg.transform}
          : {model:'manual',status:t.status});
      }
      if(before&&after&&!t) warnings.push({pairId:p.id,code:'NOT_REGISTERED',text:'尚未完成当前修订上的配准'});
      pairOut.push({ id:p.id, title:p.title,
        beforeRevId:before?.id||null, afterRevId:after?.id||null,
        anchors:anchors.map(a=>({id:a.id,label:a.label,lx:a.lx,ly:a.ly,rx:a.rx,ry:a.ry,status:a.status,migrationNote:a.migration_note})),
        registration:reg, view,
        newStructurePolys:JSON.parse(p.new_structure_polys||'[]'),
        pairVer:p.ver });
      for(const rev of [before,after]) if(rev?.license_expires && rev.license_expires<today)
        warnings.push({pairId:p.id,revId:rev.id,code:'LICENSE_EXPIRED',date:rev.license_expires,text:'授权已过期'});
    }
    return {
      schema:'restoration-archive/manifest.v1', groupId:gid,
      generatedAt:new Date().toISOString(), today,
      stages, photos:photoOut, pairs:pairOut,
      annotations:anns.map(a=>({id:a.id,pairId:a.pair_id,kind:a.kind,scope:a.scope,
        layer:a.layer,x:a.x,y:a.y,photoRevId:a.photo_rev_id,text:a.text})),
      warnings
    };
  }
  function commitVersion(gid,{notes}={}){
    const m=buildManifest(gid);
    const blockers=m.warnings.filter(w=>['SIDE_MISSING','LICENSE_EXPIRED','ANCHORS_PENDING'].includes(w.code));
    if(blockers.length) throw new ApiError(409,'COMMIT_BLOCKED',{warnings:blockers});
    const vno=(db.get('SELECT COALESCE(MAX(ver_no),0)+1 n FROM versions WHERE group_id=?',[gid])||{}).n;
    const vid=id('v');
    const manifest={...m,versionId:vid,notes:notes||''};
    db.run('INSERT INTO versions(id,group_id,ver_no,manifest,created_at) VALUES(?,?,?,?,?)',
      [vid,gid,vno,JSON.stringify(manifest),Date.now()]);
    db.run('UPDATE groups SET updated_at=? WHERE id=?',[Date.now(),gid]);
    return { versionId:vid, verNo:vno, warnings:m.warnings };
  }
  function listVersions(gid){
    return db.all(`SELECT v.id,v.ver_no,v.created_at,
        (SELECT COUNT(*) FROM approvals a WHERE a.version_id=v.id) approved
        FROM versions v WHERE group_id=? ORDER BY ver_no`,[gid]);
  }
  function getVersion(vid){
    const row=db.get('SELECT * FROM versions WHERE id=?',[vid]);
    if(!row) throw new ApiError(404,'VERSION_NOT_FOUND');
    const approval=db.get('SELECT * FROM approvals WHERE version_id=? ORDER BY created_at DESC LIMIT 1',[vid]);
    return { ...row, manifest:JSON.parse(row.manifest), approval };
  }
  function approveVersion(vid,{approver,note}){
    if(!approver) throw new ApiError(400,'APPROVER_REQUIRED');
    const v=getVersion(vid);
    const today=new Date().toISOString().slice(0,10);
    const m=v.manifest;
    const expired=m.photos.filter(ph=>ph.revision.licenseExpires&&ph.revision.licenseExpires<today);
    if(expired.length) throw new ApiError(409,'LICENSE_EXPIRED_CANNOT_APPROVE',{expired:expired.map(e=>({revId:e.revision.id,date:e.revision.licenseExpires}))});
    const aid=id('ap');
    db.run('INSERT INTO approvals(id,version_id,approver,note,created_at) VALUES(?,?,?,?,?)',
      [aid,vid,approver,note||'',Date.now()]);
    return getVersion(vid);
  }

  // ---------- 瓦片作业 ----------
  function enqueueTiles(revId){
    const rev=db.get('SELECT * FROM photo_revisions WHERE id=?',[revId]);
    if(!rev) throw new ApiError(404,'REVISION_NOT_FOUND');
    if(rev.width*rev.height>IMG.MAX_DECODE_PIXELS)
      throw new ApiError(422,'IMAGE_TOO_LARGE',{pixels:rev.width*rev.height,limit:IMG.MAX_DECODE_PIXELS});
    const existing=db.get("SELECT * FROM tile_jobs WHERE rev_id=? AND status IN('ready','queued','running')",[revId]);
    if(existing) return existing;
    const jobId=id('tj');
    db.run(`INSERT INTO tile_jobs(id,rev_id,status,sha256,created_at,updated_at) VALUES(?,?, 'queued',?,?,?)`,
      [jobId,revId,rev.sha256,Date.now(),Date.now()]);
    const originalPath=require('path').join(dataDir,'originals',revId+'.bin');
    tileQueue.add(async()=>{
      db.run("UPDATE tile_jobs SET status='running',updated_at=? WHERE id=?",[Date.now(),jobId]);
      const tilesPath=require('path').join(dataDir,'tiles',revId);
      try{
        const r=await IMG.generateTiles({originalPath,revId,expectedHash:rev.sha256,sha256,dataDir});
        db.run("UPDATE tile_jobs SET status='ready',tiles_path=?,updated_at=? WHERE id=?",[tilesPath,Date.now(),jobId]);
        return r;
      }catch(e){
        const status=e.code==='TILE_SOURCE_REPLACED'?'aborted_replaced':'failed';
        db.run("UPDATE tile_jobs SET status=?,error=?,updated_at=? WHERE id=?",[status,e.code||String(e),Date.now(),jobId]);
      }
    },async(e)=>{
      db.run("UPDATE tile_jobs SET status='failed',error=?,updated_at=? WHERE id=?",[e.code||String(e),Date.now(),jobId]);
    });
    return db.get('SELECT * FROM tile_jobs WHERE id=?',[jobId]);
  }
  function tileJob(revId){
    return db.get('SELECT id,rev_id,status,error,updated_at FROM tile_jobs WHERE rev_id=? ORDER BY created_at DESC LIMIT 1',[revId]);
  }

  // ---------- 聚合读取 ----------
  function pairDetail(pairId){
    const p=pairCurrent(pairId);
    const b=p.before_photo_id?{photo:photo(p.before_photo_id),revision:currentRev(p.before_photo_id)}:null;
    const a=p.after_photo_id?{photo:photo(p.after_photo_id),revision:currentRev(p.after_photo_id)}:null;
    const anchors=db.all('SELECT * FROM anchors WHERE pair_id=? ORDER BY created_at',[pairId]);
    const reg=latestTransform(pairId);
    return { pair:p, before:b&&{...b,tileJob:tileJob(b.revision.id)},
      after:a&&{...a,tileJob:tileJob(a.revision.id)}, anchors,
      registration:reg&&{ model:reg.model,status:reg.status,rmsePx:reg.rmse_px,
        maxErrorPx:reg.max_error_px,tolerancePx:reg.tolerance_px,stale:!!reg.stale,
        transform:reg.transform?JSON.parse(reg.transform):null,fallback:reg.fallback } };
  }
  function groupDetail(gid){
    const g=getGroup(gid);
    return { group:g,
      stages:db.all('SELECT * FROM stages WHERE group_id=? ORDER BY ord',[gid]),
      photos:db.all('SELECT * FROM photos WHERE group_id=?',[gid]).map(ph=>({...ph,revision:currentRev(ph.id)})),
      pairs:db.all('SELECT * FROM pairs WHERE group_id=?',[gid]).map(p=>pairDetail(p.id)),
      annotations:db.all('SELECT * FROM annotations WHERE group_id=?',[gid]),
      manifest:buildManifest(gid) };
  }

  return { createGroup,getGroup,listGroups,addStage,uploadPhoto,replacePhoto,
    createPair,attachSide,setNewStructure,addAnchor,updateAnchor,deleteAnchor,
    register,addAnnotation,buildManifest,commitVersion,listVersions,getVersion,
    approveVersion,enqueueTiles,tileJob,pairDetail,groupDetail, ApiError };
}

module.exports={ create, ApiError };

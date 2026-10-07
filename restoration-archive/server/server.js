'use strict';
const http=require('http'), path=require('path'), fs=require('fs'), fsp=require('fs/promises'), url=require('url');
const Busboy=require('busboy');
const {open}=require('./db');
const Store=require('./store');

const PORT=Number(process.env.PORT||3000);
const ROOT=path.join(__dirname,'..');
const DATA=process.env.DATA_DIR||path.join(ROOT,'data');
fs.mkdirSync(path.join(DATA,'originals'),{recursive:true});
fs.mkdirSync(path.join(DATA,'deriv'),{recursive:true});
fs.mkdirSync(path.join(DATA,'tiles'),{recursive:true});

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.dzi':'application/xml'};

function send(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(body);
}
function readJson(req){return new Promise((resolve,reject)=>{
  let b=''; req.on('data',c=>{b+=c;if(b.length>2e6)reject(Object.assign(new Error('PAYLOAD_LARGE'),{status:413}));});
  req.on('end',()=>{try{resolve(b?JSON.parse(b):{});}catch(e){reject(Object.assign(new Error('BAD_JSON'),{status:400}));}});
  req.on('error',reject);
});}
function readMultipart(req){return new Promise((resolve,reject)=>{
  let bb;
  try{ bb=Busboy({headers:req.headers,limits:{fileSize:300*1024*1024,files:4,fields:40}});}
  catch(e){return reject(Object.assign(new Error('BAD_MULTIPART'),{status:400}));}
  const out={fields:{},files:[]};
  bb.on('file',(name,stream,info)=>{
    const chunks=[]; let size=0, tooBig=false;
    stream.on('data',d=>{size+=d.length; if(size>300*1024*1024){tooBig=true;stream.destroy();}chunks.push(d);});
    stream.on('limit',()=>{tooBig=true;});
    stream.on('end',()=>{ if(!tooBig) out.files.push({name,filename:info.filename,mimetype:info.mimeType,buffer:Buffer.concat(chunks)}); });
    stream.on('error',()=>{reject(Object.assign(new Error('UPLOAD_TOO_LARGE'),{status:413}));});
  });
  bb.on('field',(n,val)=>{out.fields[n]=val;});
  bb.on('close',()=>resolve(out));
  bb.on('error',e=>reject(e));
  req.pipe(bb);
});}

async function serveStatic(req,res,p){
  // 仅开放 public 与 data/deriv、data/tiles（后者以 rev id 段为界）
  let base, file;
  if(p.startsWith('/tiles/')){
    base=path.join(DATA,'tiles'); file=path.join(base,p.slice('/tiles/'.length));
  }else if(p.startsWith('/deriv/')){
    base=path.join(DATA,'deriv'); file=path.join(base,p.slice('/deriv/'.length));
  }else{
    base=path.join(ROOT,'public'); file=path.join(base,p==='/'?'index.html':p);
  }
  const resolved=path.resolve(file);
  if(!resolved.startsWith(path.resolve(base)+path.sep) && resolved!==path.resolve(base)){res.writeHead(403);return res.end('forbidden');}
  let stat;
  try{ stat=await fsp.stat(resolved); if(stat.isDirectory()){const idx=path.join(resolved,'index.html');await fsp.access(idx);return serveStatic(req,res,p.endsWith('/')?p:p+'/');} }
  catch{ res.writeHead(404); return res.end('not found'); }
  const ext=path.extname(resolved).toLowerCase();
  res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream',
    'Cache-Control':p.startsWith('/tiles/')||p.startsWith('/deriv/')?'public, max-age=31536000, immutable':'no-cache'});
  fs.createReadStream(resolved).pipe(res);
}

async function main(){
  const db=await open(path.join(DATA,'archive.db'));
  const store=Store.create({db,dataDir:DATA});

  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x'); const p=decodeURIComponent(u.pathname);
    try{
      if(!p.startsWith('/api/')) return await serveStatic(req,res,p);
      const seg=p.split('/').filter(Boolean); // ['api', ...]
      const body=req.method==='POST'||req.method==='PATCH'
        ? (req.headers['content-type']||'').includes('multipart')
          ? await readMultipart(req) : await readJson(req)
        : {};
      const fields=body.fields||body; const files=body.files||[];
      const q=Object.fromEntries(u.searchParams);

      // ---- groups ----
      if(seg[1]==='groups' && !seg[2] && req.method==='POST')
        return send(res,200,store.createGroup(fields));
      if(seg[1]==='groups' && !seg[2] && req.method==='GET')
        return send(res,200,{groups:store.listGroups()});
      if(seg[1]==='groups' && seg[2]){
        const gid=seg[2];
        if(seg.length===3 && req.method==='GET') return send(res,200,store.groupDetail(gid));
        if(seg[3]==='stages' && req.method==='POST') return send(res,200,store.addStage(gid,fields));
        if(seg[3]==='photos' && req.method==='POST'){
          const f=files[0]; if(!f) throw Object.assign(new Error('NO_FILE'),{status:400});
          return send(res,200,await store.uploadPhoto(gid,{
            file:f.buffer, filename:f.filename, mimetype:f.mimetype,
            stageId:fields.stageId||null, side:fields.side||null,
            captureConditions:fields.captureConditions?JSON.parse(fields.captureConditions):{},
            licenseHolder:fields.licenseHolder||'', licenseExpires:fields.licenseExpires||null}));
        }
        if(seg[3]==='pairs' && req.method==='POST')
          return send(res,200,store.createPair(gid,{title:fields.title,beforePhotoId:fields.beforePhotoId,afterPhotoId:fields.afterPhotoId}));
        if(seg[3]==='annotations' && req.method==='POST')
          return send(res,200,store.addAnnotation(gid,{...fields,x:fields.x!==undefined?Number(fields.x):undefined,y:fields.y!==undefined?Number(fields.y):undefined}));
        if(seg[3]==='manifest' && req.method==='GET')
          return send(res,200,store.buildManifest(gid));
        if(seg[3]==='versions' && req.method==='GET')
          return send(res,200,{versions:store.listVersions(gid)});
        if(seg[3]==='versions' && req.method==='POST')
          return send(res,200,store.commitVersion(gid,{notes:fields.notes}));
      }
      // ---- photos: 几何/替换 ----
      if(seg[1]==='photos' && seg[2] && seg[3]==='revisions' && req.method==='POST'){
        const pid=seg[2];
        let declared=null;
        if(fields.declaredGeometry) declared=JSON.parse(fields.declaredGeometry);
        const f=files[0];
        return send(res,200,await store.replacePhoto(pid,{
          file:f?f.buffer:null, declaredGeometry:declared,
          captureConditions:fields.captureConditions?JSON.parse(fields.captureConditions):undefined,
          licenseHolder:fields.licenseHolder, licenseExpires:fields.licenseExpires}));
      }
      // ---- pairs ----
      if(seg[1]==='pairs' && seg[2]){
        const pairId=seg[2];
        if(seg.length===3 && req.method==='GET') return send(res,200,store.pairDetail(pairId));
        if(seg[3]==='attach' && req.method==='POST')
          return send(res,200,store.attachSide(pairId,fields.side,fields.photoId));
        if(seg[3]==='new-structure' && req.method==='PATCH')
          return send(res,200,store.setNewStructure(pairId,fields.polys));
        if(seg[3]==='anchors' && req.method==='POST')
          return send(res,200,store.addAnchor(pairId,{...fields,lx:+fields.lx,ly:+fields.ly,rx:+fields.rx,ry:+fields.ry}));
        if(seg[3]==='register' && req.method==='POST')
          return send(res,200,store.register(pairId,{model:fields.model||'affine',tolerancePx:fields.tolerancePx!==undefined?+fields.tolerancePx:3}));
      }
      if(seg[1]==='anchors' && seg[2] && req.method==='PATCH')
        return send(res,200,store.updateAnchor(seg[2],{...fields,
          lx:fields.lx!==undefined?+fields.lx:undefined, ly:fields.ly!==undefined?+fields.ly:undefined,
          rx:fields.rx!==undefined?+fields.rx:undefined, ry:fields.ry!==undefined?+fields.ry:undefined,
          expectedVer:fields.expectedVer!==undefined?+fields.expectedVer:undefined}));
      if(seg[1]==='anchors' && seg[2] && req.method==='DELETE')
        return send(res,200,store.deleteAnchor(seg[2]));
      // ---- versions / approval (访客深链接复现已批准比较) ----
      if(seg[1]==='versions' && seg[2] && seg.length===3 && req.method==='GET')
        return send(res,200,store.getVersion(seg[2]));
      if(seg[1]==='versions' && seg[2] && seg[3]==='approve' && req.method==='POST')
        return send(res,200,store.approveVersion(seg[2],{approver:fields.approver,note:fields.note}));
      // ---- tiles ----
      if(seg[1]==='tiles' && seg[2]==='jobs' && seg[3] && req.method==='POST')
        return send(res,200,store.enqueueTiles(seg[3]));
      if(seg[1]==='tiles' && seg[2]==='jobs' && seg[3] && req.method==='GET')
        return send(res,200,store.tileJob(seg[3]));

      send(res,404,{error:'NOT_FOUND',path:p});
    }catch(e){
      const code=e.code||e.message||'INTERNAL';
      const st=e.status||(/NOT_FOUND$/.test(code)?404:/^(BAD_JSON|NO_FILE|BAD_MULTIPART|PAYLOAD_LARGE|UPLOAD_TOO_LARGE)/.test(code)?400:500);
      if(st>=500) console.error(e);
      send(res,st,{error:code,details:e.details||null});
    }
  });
  server.listen(PORT,()=>console.log(`修复对照档案服务已启动: http://localhost:${PORT}`));
}
main();

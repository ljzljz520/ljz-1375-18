'use strict';
/* ============================================================================
 * DziViewer：服务端 DZI 大图瓦片查看
 *  - modelSpace：全分辨率图像像素坐标（与数据库锚点坐标同一坐标系）
 *  - 仿射叠加：左图先经“配准变换 T”映射到右图像素系，再按右图视图绘制；
 *    裁剪到两侧锚点凸包交集的有效域，并挖除“修复新增部分”多边形，
 *    确保新增结构不会被旧图纹理扭曲覆盖。
 *  - 误差超界/人工映射：不做叠加，createPairViewer 退回并排联动。
 * ==========================================================================*/

async function loadDzi(revId){
  const xml=await (await fetch(`/tiles/${revId}/info.dzi`,{cache:'force-cache'})).text();
  const size=xml.match(/Width="(\d+)"\s+Height="(\d+)"/);
  const ts=(xml.match(/TileSize="(\d+)"/)||[])[1]||256;
  const overlap=(xml.match(/Overlap="(\d+)"/)||[])[1]||0;
  const fmt=(xml.match(/Format="(\w+)"/)||[])[1]||'png';
  const width=+size[1],height=+size[2];
  // sharp DZI：level 0 = 1×1 金字塔顶，maxLevel = 满分辨率层
  return {revId,width,height,tileSize:+ts,overlap:+overlap,fmt,
    maxLevel:Math.ceil(Math.log2(Math.max(width,height)))};
}

const tileCache=new Map(); // key -> Image
function loadTile(revId,level,x,y,fmt){
  const key=`${revId}/${level}/${x}_${y}.${fmt}`;
  if(tileCache.has(key)) return tileCache.get(key);
  const p=new Promise((resolve,reject)=>{
    const im=new Image();
    im.onload=()=>resolve(im); im.onerror=()=>reject(new Error('tile404'));
    im.src=`/tiles/${revId}/files/${level}/${x}_${y}.${fmt}`;
  });
  tileCache.set(key,p); return p;
}

class DziViewer{
  constructor(host, dzi, opts={}){
    this.host=host; this.dzi=dzi; this.opts=opts;
    this.canvas=document.createElement('canvas');
    this.overlay=document.createElement('canvas'); // 锚点/连线层
    this.host.appendChild(this.canvas); this.host.appendChild(this.overlay);
    this.scale=1; this.tx=0; this.ty=0; // image(screen=img*scale+t)
    this.anim=null;
    this.drawExtra=null;
    this._bind();
    this.resize();
    requestAnimationFrame(()=>this.fit());
    new ResizeObserver(()=>this.resize()).observe(host);
  }
  resize(){
    const r=this.host.getBoundingClientRect();
    for(const c of [this.canvas,this.overlay]){c.width=r.width;c.height=r.height;c.style.width=r.width+'px';c.style.height=r.height+'px';}
    this.requestDraw();
  }
  fit(){
    const r=this.host.getBoundingClientRect();
    this.scale=Math.min(r.width/this.dzi.width,r.height/this.dzi.height)*0.92;
    this.tx=(r.width-this.dzi.width*this.scale)/2;
    this.ty=(r.height-this.dzi.height*this.scale)/2;
    this.requestDraw();
  }
  toScreen(x,y){return [x*this.scale+this.tx,y*this.scale+this.ty];}
  toImage(sx,sy){return [(sx-this.tx)/this.scale,(sy-this.ty)/this.scale];}
  setView(scale,tx,ty){this.scale=scale;this.tx=tx;this.ty=ty;this.requestDraw();}
  _bind(){
    let drag=null;
    this.host.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,tx:this.tx,ty:this.ty};this.host.setPointerCapture(e.pointerId);});
    this.host.addEventListener('pointermove',e=>{if(drag){this.tx=drag.tx+(e.clientX-drag.x);this.ty=drag.ty+(e.clientY-drag.y);this.requestDraw();
      this.onview&&this.onview();}});
    this.host.addEventListener('pointerup',()=>drag=null);
    this.host.addEventListener('wheel',e=>{e.preventDefault();
      const r=this.host.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
      const f=e.deltaY<0?1.15:1/1.15, ns=Math.min(40,Math.max(0.02,this.scale*f));
      this.tx=mx-(mx-this.tx)*(ns/this.scale); this.ty=my-(my-this.ty)*(ns/this.scale);
      this.scale=ns; this.requestDraw(); this.onview&&this.onview();
    },{passive:false});
    this.host.addEventListener('click',e=>{
      const r=this.host.getBoundingClientRect();
      const [ix,iy]=this.toImage(e.clientX-r.left,e.clientY-r.top);
      this.onclickimg&&this.onclickimg(ix,iy,e);
    });
  }
  requestDraw(){ if(this.anim)return; this.anim=requestAnimationFrame(()=>{this.anim=null;this.draw();}); }
  // 以 ctx 变换把“图像像素 -> 屏幕”；可选前置模型变换 pre（如配准矩阵）
  _applyView(ctx,pre){
    const s=this.scale;
    if(pre){ // screen = (pre * img)*s + t
      ctx.transform(pre[0]*s,pre[1]*s,pre[2]*s,pre[3]*s,pre[4]*s+this.tx,pre[5]*s+this.ty);
    }else{
      ctx.translate(this.tx,this.ty); ctx.scale(s,s);
    }
  }
  async draw(){
    const {width,height,tileSize,maxLevel}=this.dzi;
    const ctx=this.canvas.getContext('2d');
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    const layers=this.opts.layers||[{revId:this.dzi.revId,pre:null}];
    for(const layer of layers){
      if(layer.visible===false) continue;
      const dzi=layer.dzi||this.dzi;
      // 该层“满分辨率像素 -> 屏幕”的缩放；选使瓦片屏幕宽≈tileSize 的金字塔层
      const effScale=this.scale*(layer.pre?Math.hypot(layer.pre[0],layer.pre[1]):1);
      let level=Math.round(maxLevel+Math.log2(effScale));
      level=Math.max(0,Math.min(dzi.maxLevel,level));
      ctx.save();
      if(layer.clip){
        const path=pts=>{ctx.beginPath();pts.forEach((pt,i)=>{const p=this._prePt(layer.pre,pt[0],pt[1]);
          i?ctx.lineTo(p[0]*this.scale+this.tx,p[1]*this.scale+this.ty):ctx.moveTo(p[0]*this.scale+this.tx,p[1]*this.scale+this.ty);});ctx.closePath();};
        if(layer.clip.rect){ const rc=layer.clip.rect;
          ctx.beginPath();ctx.rect(rc.x,rc.y,rc.w,rc.h);ctx.clip(); }
        if(layer.clip.hull){ path(layer.clip.hull); ctx.clip(); }
        for(const hole of (layer.clip.holes||[])){ path(hole); ctx.clip('evenodd'); }
      }
      ctx.globalAlpha=layer.alpha??1;
      const lvDiv=Math.pow(2,dzi.maxLevel-level);
      const lvW=dzi.width/lvDiv, lvH=dzi.height/lvDiv;
      const nx=Math.ceil(lvW/tileSize), ny=Math.ceil(lvH/tileSize);
      // 视锥裁剪（在屏幕坐标判断可见块）
      for(let ty=0;ty<ny;ty++)for(let tx=0;tx<nx;tx++){
        const fx=tx*tileSize*lvDiv, fy=ty*tileSize*lvDiv;
        const fw=Math.min(tileSize*lvDiv,dzi.width-fx), fh=Math.min(tileSize*lvDiv,dzi.height-fy);
        const corners=[[fx,fy],[fx+fw,fy],[fx+fw,fy+fh],[fx,fy+fh]]
          .map(c=>this._prePt(layer.pre,c[0],c[1]));
        const xs=corners.map(c=>c[0]*this.scale+this.tx), ys=corners.map(c=>c[1]*this.scale+this.ty);
        if(Math.max(...xs)<0||Math.min(...xs)>this.canvas.width||Math.max(...ys)<0||Math.min(...ys)>this.canvas.height)continue;
        try{
          const im=await loadTile(dzi.revId,level,tx,ty,dzi.fmt);
          // level 瓦片像素 = full-res 的 1/lvDiv；放大到 full-res 坐标后再套视图/配准
          ctx.save(); this._applyView(ctx,layer.pre);
          ctx.drawImage(im, fx, fy, fw, fh);
          ctx.restore();
        }catch(e){/*缺块：保留底色，不阻塞渲染*/}
      }
      ctx.restore();
    }
    if(this.drawExtra) this.drawExtra(ctx);
  }
  _prePt(pre,x,y){ return pre?[pre[0]*x+pre[2]*y+pre[4],pre[1]*x+pre[3]*y+pre[5]]:[x,y]; }
  link(other){
    const sync=(src,dst)=>{src.onview=()=>{dst.setView(src.scale,src.tx,src.ty);};};
    sync(this,other); sync(other,this);
  }
}

window.DziViewer=window.DziViewer||DziViewer;
window.loadDzi=window.loadDzi||loadDzi;

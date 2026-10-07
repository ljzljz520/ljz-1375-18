'use strict';
// ============================================================================
// geometry.js — 配准几何域：仿射配准、误差界限、人工对应、坐标迁移
// 坐标系约定：图像左上为原点，x 向右、y 向下，单位为像素。
// 一个 2D 仿射变换记为 [a,b,c,d,e,f]，表示：
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// ============================================================================

// ---- 最小二乘仿射拟合 ----------------------------------------------------
// 用 >=3 对对应点求 best-fit affine（左图 -> 右图）。
// 正规方程 (AᵀA) p = Aᵀb，分别解 x、y 两通道。
function fitAffine(corrs) {
  const n = corrs.length;
  if (n < 3) return { ok: false, error: 'AFFINE_NEED_3_POINTS', points: n };
  let Sxx=0,Sxy=0,Sx=0,Syy=0,Sy=0,S=0;
  let blx=0,bly=0,brx=0,bry=0;
  for (const p of corrs) {
    const x=p.lx, y=p.ly, u=p.rx, v=p.ry;
    Sxx+=x*x; Sxy+=x*y; Sx+=x; Syy+=y*y; Sy+=y; S+=1;
    blx+=u*x; bly+=u*y;
    brx+=v*x; bry+=v*y;
  }
  // M = [[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,S]]
  const M=[[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,S]];
  const inv=inv3(M);
  if (!inv) return { ok:false, error:'AFFINE_DEGENERATE' };
  // 右侧常数向量（u 通道：[Σu x, Σu y, Σu]；v 通道同理）
  let Su=0,Sv=0; for (const p of corrs){Su+=p.rx;Sv+=p.ry;}
  const bu=[blx,bly,Su], bv=[brx,bry,Sv];
  const a=dot3(inv[0],bu), c=dot3(inv[1],bu), e=dot3(inv[2],bu);
  const b=dot3(inv[0],bv), d=dot3(inv[1],bv), f=dot3(inv[2],bv);
  return { ok:true, transform:[a,b,c,d,e,f] };
}

function applyAffine(t,x,y){ return [t[0]*x+t[2]*y+t[4], t[1]*x+t[3]*y+t[5]]; }

// 残差（像素）：每个对应点到拟合映射位置的欧氏距离
function residuals(t,corrs){
  return corrs.map(p=>{
    const [x,y]=applyAffine(t,p.lx,p.ly);
    return Math.hypot(x-p.rx,y-p.ry);
  });
}

// 误差界限评估：最大残差 RMSE。阈值默认 3px（可按照片尺度/拍摄条件调整）。
function evaluateAffine(corrs, opts={}) {
  const tol = opts.tolerancePx ?? 3;
  const fit = fitAffine(corrs);
  if (!fit.ok) return { model:'affine', status:'unavailable', reason:fit.error,
                        tolerancePx:tol, fallback:'side_by_side' };
  const res = residuals(fit.transform,corrs);
  const rms = Math.sqrt(res.reduce((s,r)=>s+r*r,0)/res.length);
  const max = Math.max(...res);
  const determinant = fit.transform[0]*fit.transform[3]-fit.transform[2]*fit.transform[1];
  // 仿射叠加必须保向：行列式<=0 意味着镜像翻转（图像翻转未声明）或退化，
  // 此时允许叠加会把右侧影像左右颠倒地压到旧结构上，拒绝之。
  const orientationPreserving = determinant > 1e-6;
  const status = (max<=tol && orientationPreserving) ? 'within_tolerance' : 'out_of_tolerance';
  return {
    model:'affine', status, transform:fit.transform,
    rmsePx:+rms.toFixed(3), maxErrorPx:+max.toFixed(3), tolerancePx:tol,
    determinant:+determinant.toFixed(6), pointCount:corrs.length,
    fallback: status==='within_tolerance' ? null : 'side_by_side',
    reason: !orientationPreserving ? 'AFFINE_DEGENERATE_OR_FLIPPED' : undefined
  };
}

// ---- 人工对应点映射 ------------------------------------------------------
// 不假设全局变换：每对锚点独立成立。没有全域误差，只有逐点对应，
// 因此无法产生可信的连续叠加；渲染退回“并排联动 + 对应连线”。
function evaluateManual(corrs) {
  if (!corrs.length) return { model:'manual', status:'unavailable',
    reason:'NO_CORRESPONDENCES', fallback:'side_by_side' };
  return { model:'manual', status:'linked_only', pointCount:corrs.length,
    correspondence:corrs.map(p=>({left:[p.lx,p.ly],right:[p.rx,p.ry],id:p.id})),
    note:'人工对应不构成全局映射，滑块叠加被禁用，仅并排联动与连线。',
    fallback:'side_by_side' };
}

// 不同视点：仅当存在合格仿射（误差在界限内）时才允许叠加；否则退回并排。
function decideView(reg) {
  if (reg && reg.model==='affine' && reg.status==='within_tolerance')
    return { mode:'overlay_slider', transform:reg.transform, error:reg.maxErrorPx };
  return { mode:'side_by_side', reason: reg ? (reg.reason||reg.status) : 'NO_REGISTRATION' };
}

// ---- 线性代数小工具 ------------------------------------------------------
function dot3(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function inv3(m){
  const [r0,r1,r2]=m;
  const c0=r0[0],c1=r0[1],c2=r0[2],c3=r1[0],c4=r1[1],c5=r1[2],c6=r2[0],c7=r2[1],c8=r2[2];
  const A= [[c4*c8-c5*c7, c2*c7-c1*c8, c1*c5-c2*c4],
            [c5*c6-c3*c8, c0*c8-c2*c6, c2*c3-c0*c5],
            [c3*c7-c4*c6, c1*c6-c0*c7, c0*c4-c1*c3]];
  const det=c0*A[0][0]+c1*A[1][0]+c2*A[2][0];
  if (Math.abs(det)<1e-12) return null;
  return A.map(row=>row.map(v=>v/det));
}
function compose(t1,t2){ // 先 t2 后 t1：apply(compose(t1,t2),p) == t1(t2(p))
  return [
    t1[0]*t2[0]+t1[2]*t2[1],
    t1[1]*t2[0]+t1[3]*t2[1],
    t1[0]*t2[2]+t1[2]*t2[3],
    t1[1]*t2[2]+t1[3]*t2[3],
    t1[0]*t2[4]+t1[2]*t2[5]+t1[4],
    t1[1]*t2[4]+t1[3]*t2[5]+t1[5]
  ];
}
function invert(t){
  const det=t[0]*t[3]-t[2]*t[1];
  if (Math.abs(det)<1e-12) return null;
  const id=1/det;
  return [( t[3]*id),(-t[1]*id),(-t[2]*id),( t[0]*id),
          (t[2]*t[5]-t[3]*t[4])*id, (t[1]*t[4]-t[0]*t[5])*id];
}

// ---- 凸包（限制叠加有效域）与点在多边形内 -------------------------------
function convexHull(points){
  const pts=[...new Map(points.map(p=>[p[0]+'_'+p[1],p])).values()]
    .sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  if (pts.length<=2) return pts;
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lower=[];
  for (const p of pts){ while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop(); lower.push(p);}
  const upper=[];
  for (let i=pts.length-1;i>=0;i--){const p=pts[i];while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p);}
  lower.pop();upper.pop();
  return lower.concat(upper);
}
function pointInPoly(x,y,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
    if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

// ============================================================================
// 坐标迁移：原图裁切或方向变化后，旧标注坐标必须经“明确声明”的变换迁移。
// 所有操作在像素坐标系上描述；迁移失败的点 -> needs_review（待复核）。
// op: {type:'rotate90cw'|'rotate180'|'rotate270cw'|'flip_h'|'flip_v'|'crop',
//      width,height(原图尺寸), crop:{x,y,width,height}, chain:[op...]}
// 每个 op 返回 {transform:[...], width,height} —— 新图尺寸与 旧坐标->新坐标 映射。
// ============================================================================
function opTransform(op){
  const w=op.width, h=op.height;
  switch(op.type){
    case 'rotate90cw':   return { transform:[0,1,-1,0,h,0], width:h, height:w }; // (x,y)->(h-y,x)
    case 'rotate180':    return { transform:[-1,0,0,-1,w,h], width:w, height:h };
    case 'rotate270cw':  return { transform:[0,-1,1,0,0,w], width:h, height:w }; // (x,y)->(y,w-x)
    case 'flip_h':       return { transform:[-1,0,0,1,w,0], width:w, height:h };
    case 'flip_v':       return { transform:[1,0,0,-1,0,h], width:w, height:h };
    case 'crop': {
      const c=op.crop;
      if(!c||c.x<0||c.y<0||c.x+c.width>w||c.y+c.height>h)
        return { error:'CROP_OUT_OF_RANGE' };
      return { transform:[1,0,0,1,-c.x,-c.y], width:c.width, height:c.height };
    }
    default: return { error:'UNKNOWN_OP:'+op.type };
  }
}
// 把若干操作按顺序复合（每步携带中间宽高）。
function chainTransform(ops){
  let t=[1,0,0,1,0,0], w=ops[0]?.width, h=ops[0]?.height;
  for(const op of ops){
    const step=opTransform({...op,width:op.width??w,height:op.height??h});
    if(step.error) return { error:step.error };
    t=compose(step.transform,t);
    w=step.width; h=step.height;
  }
  return { transform:t,width:w,height:h };
}
// 迁移单点；超出新图边界或无明确变换 -> null（进入待复核）
function migratePoint(x,y,t,newW,newH){
  const [nx,ny]=applyAffine(t,x,y);
  if(nx<-0.5||ny<-0.5||nx>newW+0.5||ny>newH+0.5) return null;
  return [+nx.toFixed(2),+ny.toFixed(2)];
}

module.exports={ fitAffine, applyAffine, residuals, evaluateAffine,
  evaluateManual, decideView, compose, invert, convexHull, pointInPoly,
  opTransform, chainTransform, migratePoint };

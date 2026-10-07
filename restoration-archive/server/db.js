'use strict';
// ============================================================================
// db.js — SQLite 仓储（sql.js 真 SQLite，定期落盘 data/archive.db）
// 保存：摄影条件、对齐变换、批准说明、版本快照、瓦片作业、锚点乐观锁。
// ============================================================================
const path=require('path'), fs=require('fs'), crypto=require('crypto');
const initSql=require('sql.js');

const SCHEMA=`
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS groups(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, building TEXT, created_at INTEGER,
  updated_at INTEGER);
CREATE TABLE IF NOT EXISTS stages(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL, year INTEGER, ord INTEGER);
CREATE TABLE IF NOT EXISTS photos(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  stage_id TEXT REFERENCES stages(id), side TEXT CHECK(side IN('before','after')),
  role TEXT DEFAULT 'main', created_at INTEGER);
CREATE TABLE IF NOT EXISTS photo_revisions(
  id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id),
  rev_no INTEGER NOT NULL, parent_rev_id TEXT,
  sha256 TEXT NOT NULL, width INTEGER, height INTEGER, format TEXT,
  -- 摄影条件
  capture_conditions TEXT, -- JSON {date,camera,lens,focalMm,lighting,weather,note}
  -- 授权
  license_holder TEXT, license_expires TEXT, -- ISO 日期；过期后不得再编辑/批准
  -- 本修订相对父修订“明确声明”的几何操作（JSON 链）；空=未声明几何变化
  declared_geometry TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|replaced
  created_at INTEGER,
  UNIQUE(photo_id,rev_no));
CREATE TABLE IF NOT EXISTS pairs(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  before_photo_id TEXT REFERENCES photos(id), after_photo_id TEXT REFERENCES photos(id),
  title TEXT, new_structure_polys TEXT DEFAULT '[]', -- 修复新增部分区域（右图坐标，当前修订系）
  ver INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS anchors(
  id TEXT PRIMARY KEY, pair_id TEXT NOT NULL REFERENCES pairs(id),
  label TEXT,
  lx REAL, ly REAL, rx REAL, ry REAL,
  left_rev_id TEXT, right_rev_id TEXT,         -- 坐标所基于的修订
  status TEXT NOT NULL DEFAULT 'pending_review', -- active|pending_review
  migration_note TEXT,
  ver INTEGER NOT NULL DEFAULT 1,              -- 乐观锁：两编辑修同一锚点
  created_at INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS pair_transforms(
  id TEXT PRIMARY KEY, pair_id TEXT NOT NULL REFERENCES pairs(id),
  model TEXT NOT NULL CHECK(model IN('affine','manual')),
  transform TEXT,           -- affine: JSON 6 元组
  rmse_px REAL, max_error_px REAL, tolerance_px REAL,
  status TEXT NOT NULL,     -- within_tolerance|out_of_tolerance|linked_only|unavailable
  fallback TEXT,            -- side_by_side
  basis_revs TEXT,          -- JSON {left:revId,right:revId} 变换成立的修订版本
  stale INTEGER NOT NULL DEFAULT 0, -- 任一照片几何变化后置 1
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS annotations(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  pair_id TEXT REFERENCES pairs(id),
  kind TEXT NOT NULL CHECK(kind IN('note','restricted')),
  -- restricted=未开放区域说明：与图层可见性解耦，任何图层切换都保持可见
  scope TEXT NOT NULL DEFAULT 'layer', -- layer|persistent
  layer TEXT,              -- 所属图层（baseline|restoration|anchors...）
  x REAL, y REAL, photo_rev_id TEXT, text TEXT NOT NULL,
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS versions(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
  ver_no INTEGER NOT NULL, manifest TEXT NOT NULL, -- 不可变 JSON 快照
  created_at INTEGER,
  UNIQUE(group_id,ver_no));
CREATE TABLE IF NOT EXISTS approvals(
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id),
  approver TEXT NOT NULL, note TEXT, -- 批准说明
  created_at INTEGER);
CREATE TABLE IF NOT EXISTS tile_jobs(
  id TEXT PRIMARY KEY, rev_id TEXT NOT NULL, status TEXT NOT NULL,
  -- queued|running|ready|failed|aborted_replaced|rejected_oversize
  error TEXT, sha256 TEXT, tiles_path TEXT, created_at INTEGER, updated_at INTEGER);
`;

function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex');}
const id=(p)=>p+'_'+crypto.randomBytes(6).toString('hex');

async function open(dbFile){
  const SQL=await initSql(), now16=Date.now();
  let db;
  if(fs.existsSync(dbFile)){ db=new SQL.Database(fs.readFileSync(dbFile)); }
  else { fs.mkdirSync(path.dirname(dbFile),{recursive:true}); db=new SQL.Database(); }
  db.run(SCHEMA);
  let saveTimer=null;
  function persist(){ if(saveTimer)return; saveTimer=setTimeout(()=>{
    saveTimer=null; fs.writeFileSync(dbFile,Buffer.from(db.export()));
  },150); }
  function all(sql,params=[]){ const stmt=db.prepare(sql); stmt.bind(params);
    const rows=[]; while(stmt.step())rows.push(stmt.getAsObject()); stmt.free(); return rows; }
  function get(sql,params=[]){ const r=all(sql,params); return r[0]||null; }
  function run(sql,params=[]){ db.run(sql,params); persist(); }

  return {
    raw:()=>db, persist:()=>{fs.writeFileSync(dbFile,Buffer.from(db.export()));},
    sha256, id, all, get, run,
    now: now16,
    transaction(fn){ db.run('BEGIN'); try{ const r=fn(); db.run('COMMIT'); persist(); return r;}
      catch(e){ db.run('ROLLBACK'); throw e; } }
  };
}

module.exports={ open, sha256, id, SCHEMA };

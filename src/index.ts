import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

type Joint={min:number;max:number;maxVelocity:number}; type Robot={id:string;name:string;dof:number;joints:Joint[];reach:number}; type Pose={x:number;y:number;z:number;rx:number;ry:number;rz:number}; type Waypoint=Pose&{speed:number;blend:number;process?:Record<string,number>};
const app=Fastify({logger:true});const now=()=>new Date().toISOString();
const robots:Robot[]=[{id:'robot-01',name:'六轴焊接机器人 A',dof:6,reach:1450,joints:[-170,170,-100,135,-180,180].map((_,i)=>({min:[-170,-100,-150,-180,-120,-360][i],max:[170,100,150,180,120,360][i],maxVelocity:[180,160,170,360,360,500][i]}))}];
const cells:any[]=[{id:'cell-01',name:'车身侧围焊装单元',robotId:'robot-01',tools:[{id:'gun-01',mass:12,tcp:{x:0,y:0,z:220}}],obstacles:[{id:'fence',type:'box',center:{x:0,y:0,z:700},size:{x:1800,y:1800,z:1600}},{id:'fixture',type:'box',center:{x:500,y:0,z:300},size:{x:420,y:360,z:300}}]}];
const paths:any[]=[];const validations:any[]=[];const plans:any[]=[];const executions:any[]=[];const audit:any[]=[];const log=(action:string,payload:any)=>audit.push({id:randomUUID(),time:now(),action,payload});
function distance(a:Pose,b:Pose){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}
function insideBox(p:Pose,b:any){return Math.abs(p.x-b.center.x)<=b.size.x/2&&Math.abs(p.y-b.center.y)<=b.size.y/2&&Math.abs(p.z-b.center.z)<=b.size.z/2}
function validatePath(path:any){const robot=robots.find(x=>x.id===path.robotId);const cell=cells.find(x=>x.id===path.cellId);const errors:any[]=[];let length=0,maxSpeed=0;for(let i=1;i<path.waypoints.length;i++){const prev=path.waypoints[i-1],cur=path.waypoints[i];length+=distance(prev,cur);maxSpeed=Math.max(maxSpeed,Number(cur.speed||0));for(const ob of cell?.obstacles||[]){if(insideBox(cur,ob)||insideBox({x:(prev.x+cur.x)/2,y:(prev.y+cur.y)/2,z:(prev.z+cur.z)/2,rx:0,ry:0,rz:0},ob))errors.push({type:'collision',obstacleId:ob.id,segment:i-1,clearance:0});}}
for(const p of path.waypoints){const reach=Math.hypot(p.x,p.y,p.z);if(reach>Number(robot?.reach||0))errors.push({type:'unreachable',waypoint:p});if(Math.abs(p.rx)>180||Math.abs(p.ry)>180||Math.abs(p.rz)>360)errors.push({type:'orientation-limit',waypoint:p});}
if(maxSpeed>220)errors.push({type:'speed-limit',maxSpeed});return{valid:errors.length===0,errors,length:Number(length.toFixed(2)),maxSpeed,estimatedSeconds:Number((length/Math.max(1,maxSpeed||100)).toFixed(2)),singularityRisk:path.waypoints.filter((p:any)=>Math.abs(p.z)<80).length};}
app.get('/health',async()=>({ok:true,service:'industrial-robot-trajectory-validation',time:now()}));
app.get('/api/cells',async()=>cells);app.get('/api/robots',async()=>robots);
app.post('/api/paths',async(req:any,res)=>{const b=req.body as any;if(!b.cellId||!b.robotId||!Array.isArray(b.waypoints)||b.waypoints.length<2)return res.code(400).send({error:'cellId、robotId 和至少两个 waypoints 必填'});const p={id:randomUUID(),version:1,name:b.name||'未命名轨迹',cellId:b.cellId,robotId:b.robotId,toolId:b.toolId||null,waypoints:b.waypoints,process:b.process||{},status:'draft',createdAt:now()};paths.push(p);return p;});
app.post('/api/paths/:id/validate',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const result=validatePath(p);const v={id:randomUUID(),pathId:p.id,createdAt:now(),...result};validations.push(v);p.lastValidationId=v.id;p.status=result.valid?'validated':'blocked';log('path.validate',v);return v;});
app.post('/api/paths/:id/plan',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const v=validations.filter(x=>x.pathId===p.id).at(-1);if(!v?.valid)return res.code(409).send({error:'path must pass collision validation'});const b=req.body as any;const plan={id:randomUUID(),pathId:p.id,controller:b.controller||'RAPID',posture:b.posture||'elbow-up',blendPolicy:b.blendPolicy||'smooth',samplingMs:Number(b.samplingMs||20),segments:p.waypoints.slice(1).map((w:any,i:number)=>({index:i+1,from:p.waypoints[i],to:w,acceleration:Number((Math.min(2.5,(w.speed||100)/80)).toFixed(2))})),status:'planned',createdAt:now()};plans.push(plan);log('trajectory.plan',plan);return plan;});
app.post('/api/paths/:id/optimize',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const candidates=[.75,1,1.2].map(scale=>{const copy={...p,waypoints:p.waypoints.map((w:any)=>({...w,speed:Math.min(220,(w.speed||100)*scale),blend:Math.min(100,(w.blend||10)+scale*5)}))};return{scale,validation:validatePath(copy),waypoints:copy.waypoints}}).filter(x=>x.validation.valid).sort((a,b)=>a.validation.estimatedSeconds-b.validation.estimatedSeconds);return{pathId:p.id,candidates,best:candidates[0]||null};});
app.post('/api/executions',async(req:any,res)=>{const b=req.body as any;const p=paths.find(x=>x.id===b.pathId);if(!p)return res.code(404).send({error:'path not found'});const v=validations.filter(x=>x.pathId===p.id).at(-1);if(!v?.valid)return res.code(409).send({error:'execution blocked by validation'});const e:any={id:randomUUID(),pathId:p.id,mode:b.mode||'dry-run',startedAt:now(),status:'running',progress:0,telemetry:[],safety:{eStop:false,protectiveStop:false}};executions.push(e);for(let i=0;i<p.waypoints.length;i++){e.progress=Math.round((i+1)/p.waypoints.length*100);e.telemetry.push({time:now(),waypoint:i,joints:p.waypoints[i],tcpSpeed:p.waypoints[i].speed});}e.status='completed';e.finishedAt=now();log('execution.complete',e);return e;});
app.post('/api/executions/:id/stop',async(req:any,res)=>{const e=executions.find(x=>x.id===(req.params as any).id);if(!e)return res.code(404).send({error:'execution not found'});e.status='protective-stopped';e.safety.protectiveStop=true;e.stoppedAt=now();return e;});
app.get('/api/paths/:id/compare',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const versions=paths.filter(x=>x.name===p.name).map(x=>({id:x.id,version:x.version,validation:validations.filter(v=>v.pathId===x.id).at(-1)}));return{pathId:p.id,versions};});
app.get('/api/audit',async()=>audit.slice(-100));

// Advanced operations: calibration, workpiece frames, dynamic obstacles and safety release gates.
// TCP 标定误差阈值与有效期语义（保持原有：30 天默认、1mm / 0.5°）
const CAL_TCP_LIMIT_MM=1, CAL_ANGLE_LIMIT_DEG=.5, CAL_DEFAULT_VALID_DAYS=30, DAY_MS=86400000;
const calibrations:any[]=[{id:'cal-01',robotId:'robot-01',toolId:'gun-01',tcpErrorMm:0.42,angleErrorDeg:.18,status:'valid',validUntil:new Date(Date.now()+30*DAY_MS).toISOString(),createdAt:now()}];
const dynamicObstacles:any[]=[]; const frames:any[]=[{id:'frame-body',name:'车身基准坐标系',origin:{x:0,y:0,z:0},rotation:{rx:0,ry:0,rz:0},status:'verified'}]; const safetyReleases:any[]=[];

// 是否满足误差阈值（提交时的准入标准，保持原语义）
function withinCalTolerance(c:any){return Number(c.tcpErrorMm)<=CAL_TCP_LIMIT_MM&&Number(c.angleErrorDeg)<=CAL_ANGLE_LIMIT_DEG;}
// 记录在某时刻的实时生效状态：active=误差合格且未到期（到期时刻 validUntil 本身已失效，用 <）；
// out-of-tolerance 优先于 expired，便于解释“为什么最新记录不能用”
function calibrationState(c:any,at:number=Date.now()){
  if(!withinCalTolerance(c))return'out-of-tolerance';
  return Date.parse(c.validUntil)<at?'expired':'active';
}
// 同一 robotId/toolId 的记录按新到旧排序（createdAt 相同则后提交者更新）
function calibrationsFor(robotId:string,toolId:string){
  return calibrations
    .filter(x=>x.robotId===robotId&&x.toolId===toolId)
    .map((x,i)=>({x,i}))
    .sort((a,b)=>Date.parse(b.x.createdAt)-Date.parse(a.x.createdAt)||b.i-a.i);
}
// 真正生效的标定：最新一条 active 记录。过期/无效记录不得遮蔽更旧但仍有效的记录。
// 不修改任何历史记录（不回写 status），每次实时计算。
function pickActiveCalibration(robotId:string,toolId:string,at:number=Date.now()){
  for(const {x} of calibrationsFor(robotId,toolId))if(calibrationState(x,at)==='active')return x;
  return null;
}
// 标定门禁判定：返回实际使用的记录、最新记录及不可用原因，结果稳定可解释
function evaluateCalibration(robotId:string,toolId:string,at:number=Date.now()){
  const ordered=calibrationsFor(robotId,toolId).map(e=>e.x);
  const active=pickActiveCalibration(robotId,toolId,at);
  if(active)return{state:'active' as const,active,activeCalibrationId:active.id,latest:ordered[0]||null,latestCalibrationId:ordered[0]?.id||null,reason:null,note:ordered[0]&&ordered[0].id!==active.id?'newer-calibration-unavailable-fell-back':null};
  if(ordered.length===0)return{state:'missing' as const,active:null,activeCalibrationId:null,latest:null,latestCalibrationId:null,reason:'no-calibration-record',note:null};
  const latest=ordered[0];
  return{state:calibrationState(latest,at),active:null,activeCalibrationId:null,latest,latestCalibrationId:latest.id,reason:`latest-calibration-${calibrationState(latest,at)}`,note:null};
}
// 对历史只读：GET/POST 返回时附带实时状态，不回写存储记录
function calibrationView(c:any){return{...c,effectiveStatus:calibrationState(c)}}

function safetyGate(path:any){const v=validations.filter(x=>x.pathId===path.id).at(-1);const cell=cells.find(x=>x.id===path.cellId);const cal=evaluateCalibration(path.robotId,path.toolId);const activeDynamic=dynamicObstacles.filter(x=>x.status==='active'&&x.cellId===path.cellId);const failures:string[]=[];if(!v?.valid)failures.push('collision-validation');if(!cal.active)failures.push('tcp-calibration');if(activeDynamic.length)failures.push('dynamic-obstacle-present');if(!cell)failures.push('cell-missing');return{released:failures.length===0,failures,checkedAt:now(),calibration:{state:cal.state,calibrationId:cal.activeCalibrationId,latestCalibrationId:cal.latestCalibrationId,reason:cal.reason,note:cal.note},calibrationId:cal.activeCalibrationId};}
app.get('/api/calibrations',async()=>calibrations.map(calibrationView));
app.post('/api/calibrations',async(req:any,res)=>{const b=req.body as any;if(!b.robotId||!b.toolId||b.tcpErrorMm==null)return res.code(400).send({error:'robotId、toolId、tcpErrorMm 必填'});const tcpErrorMm=Number(b.tcpErrorMm),angleErrorDeg=Number(b.angleErrorDeg??0);if(![tcpErrorMm,angleErrorDeg].every(Number.isFinite))return res.code(400).send({error:'tcpErrorMm、angleErrorDeg 必须是数字'});let validUntil:string;if(b.validUntil!=null){const ts=Date.parse(String(b.validUntil));if(Number.isNaN(ts))return res.code(400).send({error:'validUntil 必须是 ISO 时间'});validUntil=new Date(ts).toISOString();}else{const validDays=b.validDays==null?CAL_DEFAULT_VALID_DAYS:Number(b.validDays);if(!Number.isFinite(validDays))return res.code(400).send({error:'validDays 必须是数字'});validUntil=new Date(Date.now()+validDays*DAY_MS).toISOString();}const c={id:randomUUID(),robotId:b.robotId,toolId:b.toolId,tcpErrorMm,angleErrorDeg,status:withinCalTolerance({tcpErrorMm,angleErrorDeg})?'valid':'invalid',validUntil,createdAt:now()};calibrations.push(c);log('calibration.submit',calibrationView(c));return calibrationView(c);});
app.post('/api/frames',async(req:any,res)=>{const b=req.body as any;if(!b.name||!b.origin)return res.code(400).send({error:'name 和 origin 必填'});const f={id:randomUUID(),name:b.name,origin:b.origin,rotation:b.rotation||{rx:0,ry:0,rz:0},status:'pending-verification',createdAt:now()};frames.push(f);return f;});
app.post('/api/dynamic-obstacles',async(req:any,res)=>{const b=req.body as any;if(!b.cellId||!b.center||!b.size)return res.code(400).send({error:'cellId、center、size 必填'});const o={id:randomUUID(),cellId:b.cellId,center:b.center,size:b.size,source:b.source||'safety-scanner',status:'active',reportedAt:now()};dynamicObstacles.push(o);return o;});
app.post('/api/dynamic-obstacles/:id/clear',async(req:any,res)=>{const o=dynamicObstacles.find(x=>x.id===(req.params as any).id);if(!o)return res.code(404).send({error:'dynamic obstacle not found'});o.status='cleared';o.clearedAt=now();return o;});
app.post('/api/paths/:id/release',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const gate=safetyGate(p);const release={id:randomUUID(),pathId:p.id,gate,status:gate.released?'released':'blocked',operator:(req.body as any)?.operator||'cell-supervisor',createdAt:now()};safetyReleases.push(release);if(gate.released)p.status='released';log('path.release',release);return release;});
app.post('/api/executions/:id/telemetry',async(req:any,res)=>{const e=executions.find(x=>x.id===(req.params as any).id);if(!e)return res.code(404).send({error:'execution not found'});const b=req.body as any;if(b.jointErrorDeg!=null&&Number(b.jointErrorDeg)>2){e.status='protective-stopped';e.safety.protectiveStop=true;e.stopReason='joint tracking error';}if(b.tcpForceN!=null&&Number(b.tcpForceN)>180){e.status='protective-stopped';e.safety.protectiveStop=true;e.stopReason='TCP force threshold exceeded';}e.telemetry.push({time:now(),...b});return e;});
app.get('/api/safety/releases',async()=>safetyReleases);app.get('/api/dynamic-obstacles',async()=>dynamicObstacles);

export const appInstance=app;
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
  app.listen({port:Number(process.env.PORT||6303),host:'127.0.0.1'}).catch(err=>{app.log.error(err);process.exit(1)});
}

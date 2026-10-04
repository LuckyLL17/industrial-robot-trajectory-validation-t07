import assert from 'node:assert/strict';
import { appInstance as app } from '../src/index.ts';

// 无碰撞、可达、速度合规的测试轨迹（位于围栏与夹具之外）
const safeWaypoints = [
  { x: 0, y: 1000, z: 200, rx: 0, ry: 0, rz: 0, speed: 50, blend: 10 },
  { x: 100, y: 1000, z: 200, rx: 0, ry: 0, rz: 0, speed: 50, blend: 10 },
];

let n = 0;
const toolId = () => `gun-e2e-${++n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (t: number) => new Date(t).toISOString();

async function post(url: string, body?: any) {
  const r = await app.inject({ method: 'POST', url, payload: body ?? {} });
  return { statusCode: r.statusCode, body: r.json() };
}
async function get(url: string) {
  const r = await app.inject({ method: 'GET', url });
  return { statusCode: r.statusCode, body: r.json() };
}
// 提交标定并准备一条已通过轨迹校验的路径
async function setupPath(tool: string) {
  const { body: p } = await post('/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', toolId: tool, name: `e2e-${tool}`, waypoints: safeWaypoints,
  });
  const v = await post(`/api/paths/${p.id}/validate`);
  assert.equal(v.body.valid, true, '测试路径应通过轨迹校验');
  return p.id;
}

// 1. 现场 bug：先提交旧的已过期记录，再提交合格新记录，release 必须取新记录并放行
{
  const tool = toolId();
  const old = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.3, validUntil: iso(Date.now() - 1000) })).body;
  const fresh = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4 })).body;
  const pathId = await setupPath(tool);
  const r = await post(`/api/paths/${pathId}/release`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.status, 'released');
  assert.equal(r.body.gate.released, true);
  assert.deepEqual(r.body.gate.failures, []);
  assert.equal(r.body.gate.calibration.calibrationId, fresh.id);
  assert.equal(r.body.gate.calibrationId, fresh.id);
  assert.equal(r.body.gate.calibration.latestCalibrationId, fresh.id);
  assert.equal(r.body.gate.calibration.state, 'active');
  assert.notEqual(r.body.gate.calibration.calibrationId, old.id);
  console.log('PASS 1: 过期旧记录不遮蔽新的有效记录，release 使用新记录');
}

// 2. 最新记录超差无效，但更早的记录仍在有效期内 → 回退到旧有效记录并在结果中说明
{
  const tool = toolId();
  const older = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.5 })).body;
  const bad = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 1.8 })).body;
  const pathId = await setupPath(tool);
  const r = await post(`/api/paths/${pathId}/release`);
  assert.equal(r.body.gate.released, true);
  assert.equal(r.body.gate.calibration.state, 'active');
  assert.equal(r.body.gate.calibration.calibrationId, older.id);
  assert.equal(r.body.gate.calibration.latestCalibrationId, bad.id);
  assert.equal(r.body.gate.calibration.note, 'newer-calibration-unavailable-fell-back');
  console.log('PASS 2: 最新无效时回退到仍在有效期内的更早记录');
}

// 3a. 所有记录均无效（最新一条超差）→ blocked 且原因明确
{
  const tool = toolId();
  await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4, validUntil: iso(Date.now() - 1000) });
  await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 2.5 });
  const pathId = await setupPath(tool);
  const r = await post(`/api/paths/${pathId}/release`);
  assert.equal(r.body.gate.released, false);
  assert.deepEqual(r.body.gate.failures, ['tcp-calibration']);
  assert.equal(r.body.gate.calibration.state, 'out-of-tolerance');
  assert.equal(r.body.gate.calibration.calibrationId, null);
  assert.equal(r.body.gate.calibration.reason, 'latest-calibration-out-of-tolerance');
  console.log('PASS 3a: 全部无效（最新超差）时稳定阻断并给出原因');
}

// 3b. 所有记录均过期 → blocked，原因为 expired
{
  const tool = toolId();
  await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.2, validUntil: iso(Date.now() - 5000) });
  await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.3, validUntil: iso(Date.now() - 1000) });
  const pathId = await setupPath(tool);
  const r = await post(`/api/paths/${pathId}/release`);
  assert.equal(r.body.gate.released, false);
  assert.equal(r.body.gate.calibration.state, 'expired');
  assert.equal(r.body.gate.calibration.reason, 'latest-calibration-expired');
  console.log('PASS 3b: 全部过期时稳定阻断并给出原因');
}

// 3c. 从未提交标定 → blocked，原因 no-calibration-record
{
  const tool = toolId();
  const pathId = await setupPath(tool);
  const r = await post(`/api/paths/${pathId}/release`);
  assert.equal(r.body.gate.released, false);
  assert.equal(r.body.gate.calibration.state, 'missing');
  assert.equal(r.body.gate.calibration.reason, 'no-calibration-record');
  console.log('PASS 3c: 缺少标定记录时稳定阻断并给出原因');
}

// 4. 标定刚好到期（validUntil 时刻）即失效；到期后重新提交合格记录即可恢复
{
  const tool = toolId();
  const validUntil = iso(Date.now() + 800);
  await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4, validUntil });
  const pathId = await setupPath(tool);
  await sleep(850);
  const blocked = await post(`/api/paths/${pathId}/release`);
  assert.equal(blocked.body.gate.released, false);
  assert.equal(blocked.body.gate.calibration.state, 'expired');
  const fresh = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4 })).body;
  const released = await post(`/api/paths/${pathId}/release`);
  assert.equal(released.body.gate.released, true);
  assert.equal(released.body.gate.calibration.calibrationId, fresh.id);
  console.log('PASS 4: 刚好到期判失效，重新提交有效记录后恢复发布');
}

// 5. 重复提交相同标定：多条均有效时选择最新提交的一条
{
  const tool = toolId();
  const first = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4 })).body;
  await sleep(5);
  const second = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4 })).body;
  assert.notEqual(first.id, second.id);
  const pathId = await setupPath(tool);
  const r = await post(`/api/paths/${pathId}/release`);
  assert.equal(r.body.gate.released, true);
  assert.equal(r.body.gate.calibration.calibrationId, second.id);
  assert.equal(r.body.gate.calibration.latestCalibrationId, second.id);
  console.log('PASS 5: 重复提交相同标定时稳定选择最新一条');
}

// 6. 完整链路：提交→校验→release 失败（超差）→重新提交有效→release 成功；历史记录不删除、不被篡改
{
  const tool = toolId();
  const expired = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.9, validDays: 0 })).body;
  const bad = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 1.5 })).body;
  const pathId = await setupPath(tool);
  const fail = await post(`/api/paths/${pathId}/release`);
  assert.equal(fail.body.status, 'blocked');
  assert.equal(fail.body.gate.calibration.calibrationId, null);

  const fresh = (await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.6, angleErrorDeg: 0.2 })).body;
  const ok = await post(`/api/paths/${pathId}/release`);
  assert.equal(ok.body.status, 'released');
  assert.equal(ok.body.gate.calibration.calibrationId, fresh.id);

  const list = (await get('/api/calibrations')).body.filter((c: any) => c.toolId === tool);
  assert.equal(list.length, 3, '历史标定记录必须全部保留');
  const byId = Object.fromEntries(list.map((c: any) => [c.id, c]));
  assert.equal(byId[expired.id].effectiveStatus, 'expired');
  assert.equal(byId[bad.id].effectiveStatus, 'out-of-tolerance');
  assert.equal(byId[fresh.id].effectiveStatus, 'active');
  // 存储记录不被门禁回写
  assert.equal(byId[expired.id].status, 'valid');
  assert.equal(byId[bad.id].status, 'invalid');
  console.log('PASS 6: 失败后重新提交有效记录可发布，历史记录完整保留且不被篡改');
}

// 7. 轨迹校验未通过时，即使标定有效 release 仍被 collision-validation 阻断（门禁其余规则不回归）
{
  const tool = toolId();
  await post('/api/calibrations', { robotId: 'robot-01', toolId: tool, tcpErrorMm: 0.4 });
  const { body: p } = await post('/api/paths', {
    cellId: 'cell-01', robotId: 'robot-01', toolId: tool, name: `e2e-${tool}`,
    waypoints: [safeWaypoints[0], { x: 500, y: 0, z: 300, rx: 0, ry: 0, rz: 0, speed: 50, blend: 10 }], // 撞夹具
  });
  const r = await post(`/api/paths/${p.id}/release`);
  assert.equal(r.body.gate.released, false);
  assert.ok(r.body.gate.failures.includes('collision-validation'));
  console.log('PASS 7: 轨迹校验未通过时 release 仍被阻断（无回归）');
}

// 8. 非法入参返回 400
{
  const a = await post('/api/calibrations', { robotId: 'robot-01', toolId: toolId(), tcpErrorMm: 'abc' });
  assert.equal(a.statusCode, 400);
  const b = await post('/api/calibrations', { robotId: 'robot-01', toolId: toolId(), tcpErrorMm: 0.4, validUntil: 'not-a-date' });
  assert.equal(b.statusCode, 400);
  console.log('PASS 8: 非法数值 / 非法 validUntil 返回 400');
}

console.log('\n全部标定门禁端到端用例通过');
await app.close();

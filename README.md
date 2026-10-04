# 工业机器人离线轨迹规划与碰撞验证服务

纯后端 Node.js + TypeScript + Fastify 服务，默认无需 Docker、数据库或消息中间件即可运行。

## 启动

```bash
npm install
npm run dev
```

默认端口：`6303`。健康检查：`GET /health`。

## 业务闭环

- 领域状态模型与事件输入
- 可回放的时间序列/仿真流程
- 约束校验与风险门禁
- 方案版本、审计轨迹与异常处置
- 所有状态暂存于进程内，便于本机演示；可扩展为数据库、事件总线和实时流处理架构

## 增强业务闭环

- TCP 工具标定误差和标定有效期管理
- 工件基准坐标系登记
- 动态障碍物上报与清除
- 轨迹发布前的碰撞、标定、动态障碍物多重安全门禁
- 执行中关节跟踪误差和 TCP 力阈值保护停机
- 轨迹 release、执行遥测和安全审计

扩展接口：`/api/calibrations`、`/api/frames`、`/api/dynamic-obstacles`、`/api/paths/:id/release`、`/api/executions/:id/telemetry`。

### TCP 标定选择与生效规则

- 误差阈值保持不变：`tcpErrorMm <= 1` 且 `angleErrorDeg <= 0.5` 才算合格；有效期默认 30 天，可用 `validDays`（含 0/负数，用于导入已过期的历史记录）或显式 `validUntil`（ISO 时间）指定。
- release 门禁按 `robotId + toolId` 选取标定：记录按提交时间从新到旧排列，**取最新一条“合格且未到期”的记录**。过期或超差记录不会遮蔽更旧但仍在有效期内的记录；历史记录永不删除、也不会被门禁回写。
- 到期边界：`validUntil` 时刻即已失效（严格小于当前时间才有效）。
- `POST /api/paths/:id/release` 的 `gate.calibration` 中明确给出：
  - `calibrationId`：本次实际使用的标定（顶层 `gate.calibrationId` 同步保留）；
  - `latestCalibrationId`：最新提交的记录（可能与实际使用的不同，此时 `note=newer-calibration-unavailable-fell-back`）；
  - `state` / `reason`：`active`、`missing(no-calibration-record)`、`expired(latest-calibration-expired)`、`out-of-tolerance(latest-calibration-out-of-tolerance)`。
- `GET /api/calibrations` 每条记录附带实时计算的 `effectiveStatus`（`active`/`expired`/`out-of-tolerance`），存储的 `status` 保持提交时快照不变。
- 标定失效后重新提交一条合格记录即可立即发布，无需删除或修改旧记录。

## 测试

```bash
npm test   # tsx test/e2e.ts，走 fastify.inject 覆盖提交→校验→release→重新提交流程
```

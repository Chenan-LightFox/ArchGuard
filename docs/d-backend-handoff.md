# 角色 D 交接文档：审批、存储与报告后端

版本 v0.1 · 2026-11-16 · 角色 D 独立交付

## 1. 结论先行

角色 D（变更申请持久化、提交冻结、审批与版本发布、延期待办、实施证据与复扫、报告汇总、身份与权限）已完成独立实现与测试：

- `npm run check`、`npm test`、`npm run build` 在本机全部通过。
- 独立使用临时数据库测试，未污染真实库，未删除真实数据库。
- 未改动 A 的页面、B 的算法、C 的计算器或扫描核心；只对 `build-plan.ts` 做了“抽出可复用排程/成本函数”的最小重构，原有行为与测试保持不变。
- B/C 未接通时接口返回明确的 `NOT_READY`（HTTP 503），不使用假数据冒充成功。

“D 独立测试完成”不等于“与全团队正式集成完成”。A/B/C/E 的页面、真实需求映射与影响分析、真实三方案计算器、实施与报告页面仍需各自接入，本文只提供适配接口与联调示例。

## 2. 修改文件与实现说明

| 文件 | 改动 |
| --- | --- |
| `packages/contracts/index.d.ts` | 新增 `ChangeRequest`、`AnalysisRevision`、`ScenarioRevision/Scheme`、`ChangeSubmission`、`ApprovalDecision/Result`、`DeferredItem`、`ImplementationCheck/Evidence`、`ChangeReport` 等共享类型 |
| `apps/api/src/plans/build-plan.ts` | 抽出并导出 `scheduleTasks`、`planCost`、`recomputePlan`，供 C 适配器与服务端校验复用；`buildPlan` 行为不变 |
| `apps/api/src/storage/sqlite-store.ts` | 新增 8 张表与 `plan_versions` 血统列迁移；新增领域读写方法与原子审批事务；`deleteProject` 对存在审计历史的项目返回 409 冲突而非外键 500 |
| `apps/api/src/projects/projects.module.ts` | 删除项目时把领域错误翻译为稳定 HTTP 错误 |
| `apps/api/src/changes/errors.ts` | 统一 `DomainError` 与稳定 `code` 错误响应 |
| `apps/api/src/changes/actor.ts` | 最小后端 `ActorResolver`，演示令牌 → 身份/角色/项目成员 |
| `apps/api/src/changes/adapters.ts` | B/C 适配器接口与默认“未接通”实现 |
| `apps/api/src/changes/fixture-adapters.ts` | 仅测试/演示用的夹具适配器（明确标注，不冒充真实 AI） |
| `apps/api/src/changes/changes.module.ts` | 变更申请、分析、方案、提交、决策接口 |
| `apps/api/src/implementation/implementation.module.ts` | 实施检查与证据追加接口 |
| `apps/api/src/reports/reports.module.ts` | 报告汇总接口 |
| `apps/api/src/app.module.ts` | 注册 changes/implementation/reports 三个模块 |
| `apps/api/package.json` | `test` 增加新测试文件；新增 `demo:d` 脚本 |
| `apps/api/test/changes-db.test.ts` | 数据库/服务层测试（含真实多进程并发） |
| `apps/api/test/changes-controller.test.ts` | 控制器层测试（鉴权、校验、报告） |
| `apps/api/test/approve-worker.ts` | 多进程并发测试的子进程脚本 |
| `apps/api/scripts/demo-d.ts` | 不依赖前端与真实模型的 D 演示脚本 |

## 3. 数据结构、迁移与兼容性

沿用 `node:sqlite` 的 `DatabaseSync`，与现有 `SqliteStore` 同一连接。构造时在迁移期间临时关闭 `foreign_keys` 以重建旧版 `implementation_checks`，完成后重新开启；`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 逐列 `ADD COLUMN`，旧库升级与重复启动均幂等。全部 SQL 参数化。

新增表：

- `change_requests`：项目、标题、描述、申请人、草稿修订号、状态、冻结的基线计划版本与扫描、时间。
- `analysis_revisions`：B 的分析版本，除基线与扫描外还绑定 `change_request_revision`（生成时的申请修订），以及确认映射、影响任务、影响路径、证据、待确认项、确认人。
- `scenario_revisions`：C 的方案版本，一份同时保存 accept/reduce/defer 三个方案，并绑定 `analysis_revision_id` 与 `change_request_revision`，保证三方案基于同一分析版本与申请修订。
- `change_submissions`：不可变提交快照，含完整 `snapshot_json`（冻结的申请标题/描述/基线/扫描/仓库来源、分析、三方案）与其 SHA-256 摘要。
- `approval_decisions`：`submission_id` 与 `idempotency_key` 唯一约束，保证同一提交最多一个最终决策、同一幂等键唯一。
- `deferred_items`：延期待办范围、未来暂估、优先级与待排期状态。
- `implementation_checks` + `implementation_evidences`：实施检查为追加式版本（`submission_id + revision` 唯一），每次记录新增一行，不覆盖历史状态、提交、复扫与验收；证据挂在具体检查版本下，只增不改。
- `plan_versions` 新增血统列：`parent_version`、`source_change_request_id`、`source_submission_id`、`source_decision_id`，旧行保持 `NULL`，旧接口返回不变。

跨项目校验由服务端显式完成：所有 `changeId` 相关读写都按 `project_id + id` 定位，基线计划与扫描按项目归属校验。删除存在变更申请历史的项目返回 409（`STATE_CONFLICT`），不会先删一半再撞外键。

## 4. 状态机与冻结规则

申请状态：`draft -> pending -> approved / rejected`。

- 草稿修改必须携带 `expectedRevision`，不匹配返回 409（`REVISION_CONFLICT`）。
- 普通草稿修改也会递增修订号；SQL 以 `expectedRevision` 与允许状态（`draft`/`rejected`）作为更新条件，受影响行数不为 1 时返回 409，避免并发覆盖。
- 分析与方案绑定其生成时的申请修订、基线与扫描；申请内容、基线或扫描改变后，旧分析与方案失效，提交前必须重新分析与计算。
- 提交后（`pending`）不允许原地修改；拒绝后可以开新修订并重新提交，旧决策保留。
- 提交前校验：基线计划与扫描存在且属于当前项目、当前基线未过期、映射已人工确认、分析与方案都绑定当前申请修订且互相一致、估算与依据齐全、选中方案属于当前申请、候选计划通过服务端 `recomputePlan` 重算校验。
- 提交在 `BEGIN IMMEDIATE` 写锁内重新读取申请、基线、扫描、分析与方案，与快照插入、`pending` 状态更新处于同一原子操作；最终状态更新使用 `draft_revision` 与 `status='draft'` 作为条件，版本变化或已提交返回 409，不会用旧修订覆盖新修订。
- 拒绝过期申请允许；批准过期基线失败（409 `BASELINE_EXPIRED`）。

实施状态独立：`not_started / in_progress / waiting_scheduling / completed`。批准 accept/reduce 为 `not_started`，批准 defer 为 `waiting_scheduling`；批准本身不会变成 `completed`。`completed` 要求结构化需求验收为 `accepted`、实施提交非空且与复扫提交一致、复扫与基线可比（规则/解析器一致）、至少一条 `passed` 测试证据且无失败证据；复扫覆盖受限时还需人工复核通过。

## 5. 原子审批与幂等

`SqliteStore.decideChangeRequest` 在同一个连接上执行 `BEGIN IMMEDIATE ... COMMIT`。审批必须携带 `submissionId` 与 `expectedSnapshotHash`，不再自动取 `getLatestSubmission`。顺序为：身份与项目权限校验 → 按 `submissionId` 读取提交并核对预期快照摘要 → 幂等键与已有决策检查 → 快照内部一致性（申请修订、基线、扫描、分析、方案绑定）校验 → 当前最新计划版本与冻结基线比较 → accept/reduce 插入新计划及来源血统（保留旧计划）→ defer 只写延期待办 → 保存决策与状态。任何错误整体回滚，事务内不调用 LLM、Git 或网络。

批准时还会校验该 `submission` 是当前有效的待审批提交（`submission.revision` 等于申请当前 `draftRevision`）；合法的历史幂等重放在该检查之前命中已有决策，仍返回原结果。

幂等规则由唯一约束与请求指纹（提交 ID + 快照摘要 + 决策 + 意见 + 审批人 + 申请的 SHA-256）共同支撑：

- 同幂等键、同请求：返回原决策与结果（重启后仍有效）。
- 同幂等键、不同请求：409 `IDEMPOTENCY_CONFLICT`。
- 同提交换键重试：409 `ALREADY_DECIDED`。
- 不同审批人或相反决策：因指纹不同而 409，不会伪装成原成功。
- 旧页面使用旧的 `submissionId`/快照重试，只能命中该旧提交的历史决策，不能批准重新提交的新版本。
- 同申请并发批准：最多发布一次；同基线两项变更并发批准：一个发布后另一个报 `BASELINE_EXPIRED`。
- 原手动发布计划导致的基线过期也会被识别（比较 `MAX(version)` 与冻结基线）。

并发测试使用两个独立进程（`test/approve-worker.ts`）竞争同一 SQLite 文件，不是对同步函数 `Promise.all` 伪造并发。

## 6. 身份与权限

没有现成身份系统时启用最小后端 `ActorResolver`。通过环境变量 `ARCHGUARD_ACTORS_JSON` 配置演示令牌到身份、角色与项目成员关系：

```json
[
  {"token":"demo-member-token","actorId":"u-member","name":"成员甲","roles":["member"],"projects":["<projectId>"]},
  {"token":"demo-approver-token","actorId":"u-approver","name":"审批乙","roles":["member","approver"],"projects":["<projectId>"]}
]
```

请求带 `Authorization: Bearer <token>`。申请人和审批人都由后端身份产生，前端不能传 `approverId` 或 `role` 提权。所有新接口（含历史查询、报告、幂等重放）都校验项目成员与角色；决策需要 `approver` 角色；默认拒绝申请人自批。令牌不写入 Git、日志或报告。

## 7. 最终接口

沿用全局 `/api` 前缀，Controller 路由不重复写 `/api`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/projects/:projectId/change-requests` | 创建变更申请 |
| `GET` | `/api/projects/:projectId/change-requests` | 列表 |
| `GET` | `/api/projects/:projectId/change-requests/:changeId` | 详情 |
| `PATCH` | `/api/projects/:projectId/change-requests/:changeId` | 修改草稿（`expectedRevision`） |
| `POST` | `/api/projects/:projectId/change-requests/:changeId/analyses` | 经 B 适配器创建分析版本 |
| `GET` | `.../:changeId/analyses` | 分析版本列表 |
| `POST` | `/api/projects/:projectId/change-requests/:changeId/scenarios` | 经 C 适配器创建三方案版本 |
| `GET` | `.../:changeId/scenarios` | 方案版本列表 |
| `POST` | `/api/projects/:projectId/change-requests/:changeId/submit` | 提交（体：`{selectedKind}`） |
| `GET` | `.../:changeId/submissions` | 提交历史 |
| `POST` | `/api/projects/:projectId/change-requests/:changeId/decisions` | 审批（体：`{decision, comment?, idempotencyKey, submissionId, expectedSnapshotHash}`） |
| `GET` | `.../:changeId/decisions` | 决策历史 |
| `POST` | `/api/projects/:projectId/change-requests/:changeId/implementation-checks` | 追加一条实施检查版本（体含 `submissionId`、`status`、结构化 `requirementAcceptance`、可选 `coverageReview` 与 `evidence`） |
| `GET` | `.../:changeId/implementation-checks` | 实施检查列表 |
| `GET` | `/api/projects/:projectId/change-requests/:changeId/report?submissionId=&implementationCheckId=` | 报告 |

`POST .../scenarios` 请求体为 `{accept, reduce, defer}`，每个方案只接受 `kind/includedScope/excludedScope/acceptanceCriteria/taskDiffs/estimationInput`。任何 `metrics` 或 `candidatePlan` 字段都会被 400 拒绝，由服务端 C 适配器计算并校验。

`POST .../decisions` 必须带 `submissionId` 与 64 位十六进制 `expectedSnapshotHash`（等于提交时返回的 `snapshot` 的 SHA-256），否则 400/409；后端不再按“最新提交”自动审批。`implementation-checks` 的 `requirementAcceptance` 为 `{verdict: 'accepted'|'rejected'|'pending', summary}`，`coverageReview` 为 `{accepted: boolean, note?}`，`evidence` 为 `{command, passed, executedAt?, outputSummary, source?}`。

错误响应统一为 `{"code":"...","message":"..."}`。稳定码：`VALIDATION_ERROR`(400)、`NOT_AUTHENTICATED`(401)、`FORBIDDEN`(403)、`NOT_FOUND`(404)、`REVISION_CONFLICT`/`STATE_CONFLICT`/`IDEMPOTENCY_CONFLICT`/`ALREADY_DECIDED`/`BASELINE_EXPIRED`(409)、`NOT_READY`(503)、`INTERNAL_ERROR`(500)。

## 8. B/C 适配状态与 A/E 联调示例

B 适配器接口：`AnalysisAdapter.analyze(context, body) -> AnalysisDraft`。C 适配器接口：`ScenarioAdapter.compute(context, ScenarioInputSet) -> ScenarioDraft`。默认实现为“未接通”，返回 503 `NOT_READY`。设置 `ARCHGUARD_ENABLE_DEMO_FIXTURES=1` 才会启用夹具适配器（仅测试/演示）。

A/E 联调最小流程（`Authorization` 省略未写）：

```text
POST /api/projects/:id/change-requests            {title, description, basePlanVersion, baseScanId}
POST /api/projects/:id/change-requests/:cid/analyses        -> analysis
POST /api/projects/:id/change-requests/:cid/scenarios       -> {accept, reduce, defer}
POST /api/projects/:id/change-requests/:cid/submit          {selectedKind: "accept"}
POST /api/projects/:id/change-requests/:cid/decisions       {decision: "approved", idempotencyKey, submissionId, expectedSnapshotHash}
GET  /api/projects/:id/change-requests/:cid/report
```

报告返回结构化 JSON：项目与申请概况、固定基线与扫描提交/规则版本/仓库来源、确认映射/任务分类/影响路径/证据、三方案范围/验收/指标/差额、估算来源/规则版本/假设/风险、冻结与审批记录、新计划父子关系或延期待办、实施提交/测试/复扫/需求验收/限制。报告可固定到 `submissionId` 或 `implementationCheckId`（实施版本），并校验实施版本属于指定提交；历史报告的标题/描述/基线/扫描/仓库来源取自提交快照，不随当前草稿或计划改变。未实施也会返回报告并明确展示待实施与缺失证据。GET 报告不调用模型、不发布计划、不伪造成功。

复扫可比性同时校验基线扫描、复扫与冻结来源三者仓库一致，不再只比较复扫来源与项目当前 `repositoryUrl`；不同仓库明确不可比，不能据此标记实施完成。旧提交缺少冻结来源时按“无法确认”处理并写入报告限制，不会默认可信。

## 9. 演示配置与运行

脚本使用测试夹具，不依赖前端和真实模型：

```sh
npm run demo:d -w @archguard/api
```

演示顺序：v1 → 创建并提交申请 → 提交第二项旧基线申请 → 批准第一项得到 v2 → 重复请求不新增版本 → 旧基线申请批准失败（`BASELINE_EXPIRED`）→ 拒绝申请不改计划 → 延期待办 → 查询报告。脚本默认使用临时数据库；如要复用指定目录，启动前设置 `ARCHGUARD_DATA_DIR`。演示令牌是脚本内置的占位串（`demo-member-token` / `demo-approver-token`），不是真实密钥。

## 10. 实际测试结果

2026-11-17 本机（Node v22.22.1）：

```text
npm run check  通过（api + web 类型检查）
npm test       通过（6 个测试文件，0 失败）
npm run build  通过
```

测试覆盖：真实旧库迁移（旧 `implementation_checks` 重建、绑定列补齐）、跨项目引用与越权、草稿修订冲突与原子 409、未确认映射/缺估算/伪造 metrics 拒绝、v2 基线更新后旧 v1 分析与方案不能提交、提交与草稿修改的多进程并发竞争（读取后、获取提交锁前被另一进程修改，旧修订返回 409）、审批强制 `submissionId`+`snapshotHash` 且旧页面不能批准新提交、完成态门禁（零证据/失败验收/不可比复扫/覆盖复核）、跨仓库复扫不可比、实施检查追加版本不覆盖历史、同键重试/异内容冲突/换键重试、同申请与同基线两项变更的真实多进程并发、手动发布后的基线过期、事务中途故障注入后完整回滚、重启后记录与幂等仍有效、历史报告修改前后对照稳定、真实 HTTP 集成（鉴权/提交/审批/报告）且不泄露令牌。

## 11. 已知限制与剩余集成事项

- B/C 未接通时，分析与方案接口按约定返回 503 `NOT_READY`；需 B、C 分别实现真实 `AnalysisAdapter` / `ScenarioAdapter` 并替换默认 provider。
- 演示令牌 `ARCHGUARD_ACTORS_JSON` 是课程演示的最小身份机制，不是完整 SSO/注册体系；生产需要替换为真实身份系统。
- 延期待办只生成待办，不创建内容相同的计划版本；当前没有“正式排期”接口，`scheduled_at` 尚无可写入口，延期事项在排期前保持 `waiting_scheduling`。A/E 若需要，可按文档中的 `deferred_items` 结构补充排期接口。
- 复扫比较复用现有 `compareArchitecture`；规则版本、分层配置或解析器版本不一致时明确返回不可比原因，不会输出误导性的“问题已清零”。
- 报告接口只输出 JSON，暂不引入 PDF/Word；页面与导出由 A/E 负责。

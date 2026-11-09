# ArchGuard

AI 辅助的软件架构分析与项目变更审批平台，融合软件体系结构与项目管理课程实践。

导入 Git 仓库、需求和任务计划，检测架构问题，并通过需求、任务与代码模块的关联分析变更影响。比较接受、缩小范围和延期三种方案，审批后生成新计划，实施后复扫并导出报告。

## 系统设计

详见 [融合后的 Web 架构设计](docs/web-architecture.md)，包含双图模型、影响路径、三方案估算、审批和复扫验证。[原架构分析方案](docs/architecture.md) 保留为早期设计记录。

## 运行项目骨架

准备 Node.js 22.16 或更高版本（推荐 Node.js 24）和 Git。在项目根目录运行：

```sh
npm ci
npm run dev
```

访问 http://127.0.0.1:5173 。该命令同时启动 React 页面、NestJS API 和独立扫描进程。终端按 Ctrl+C 停止服务。PowerShell 若限制运行 npm 脚本，可将命令中的 `npm` 改为 `npm.cmd`。

1. 在「项目」登记一个 HTTPS Git 仓库地址。
2. 进入「架构扫描」，点击「运行检查」。
3. 页面显示后台任务状态和实际检测到的 Git、TypeScript 版本。重新启动后可查看历史记录。

数据默认保存到 `data/archguard.sqlite`。可通过 `ARCHGUARD_DATA_DIR` 指定其他数据目录，通过 `ARCHGUARD_API_PORT` 调整 API 端口（默认 3001）。开发服务仅监听本机。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `apps/web` | React 工作台、项目登记、检查记录及后续模块入口 |
| `apps/api` | NestJS 项目和检查接口、SQLite 持久化 |
| `apps/api/src/worker.ts` | 独立运行的扫描进程入口 |
| `packages/contracts` | 前后端共享的请求与响应类型 |

`npm run check` 检查 TypeScript 类型，`npm run build` 构建前端和后端。
前端使用 Rollup 的 WebAssembly 发行版构建，兼容限制加载第三方原生模块的开发环境。

当前的扫描任务是环境预检。源码拉取、依赖解析、规则检测、需求计划、三方案估算、审批和报告将在后续阶段实现。

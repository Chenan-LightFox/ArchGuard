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
2. 进入「架构扫描」，填写分支、`refs/tags/标签名` 或完整提交 SHA。留空时扫描仓库默认分支。
3. 点击「提交扫描」。任务完成后，点击「查看结果」读取实际提交、源码文件、内部依赖及行号。历史记录保存在 SQLite 中。

数据默认保存到 `data/archguard.sqlite`。可通过 `ARCHGUARD_DATA_DIR` 指定其他数据目录，通过 `ARCHGUARD_API_PORT` 调整 API 端口（默认 3001）。开发服务仅监听本机。

在 Windows 上，PATH 应包含 `git.exe` 所在目录，例如 `D:\Git\cmd`。修改 PATH 后，从新终端重启 ArchGuard。也可以在启动前用 `ARCHGUARD_GIT_PATH` 指定可执行文件的绝对路径。

如果服务器需要通过代理访问 GitHub，请在 Worker 的启动环境设置 `HTTPS_PROXY`，然后重启 Worker。Windows 的 `run.bat` 会沿用已有的 `HTTPS_PROXY` 或 `ALL_PROXY`，两者都为空时尝试使用 Git 全局配置中对 GitHub 生效的代理。其他启动方式需要在启动环境中设置代理。使用本机代理地址时，代理需在 Worker 所在服务器运行。

## 代码结构

| 目录 | 职责 |
| --- | --- |
| `apps/web` | React 工作台、项目登记、扫描历史和依赖表 |
| `apps/api` | NestJS 项目与扫描接口、SQLite 持久化 |
| `apps/api/src/worker.ts` | 独立运行的仓库扫描和环境检查进程 |
| `apps/api/src/scans` | Git 快照读取、TypeScript 依赖解析 |
| `packages/contracts` | 前后端共享的请求与响应类型 |

`npm run check` 检查 TypeScript 类型，`npm run build` 构建前端和后端。
前端使用 Rollup 的 WebAssembly 发行版构建，兼容限制加载第三方原生模块的开发环境。

仓库扫描支持 GitHub、GitLab 和 Bitbucket 的公开 HTTPS 原始仓库地址。请使用无需跳转的地址和 ASCII 分支或标签引用。扫描识别 JS/TS 静态导入、重新导出、类型导入以及字符串形式的 `require` 和动态导入。计算式导入、项目配置或语法问题会影响覆盖率。单文件读取上限为 512 KiB，单次扫描上限为 4,000 个源码及配置文件、16 MiB 内容和 30,000 条引用。

上述大小限制适用于读取和分析的内容。Git 浅取仍可能下载所选提交中的其他对象，获取超时为 45 秒。依赖解析使用仓库内的配置和已读取文件，无法解析的工作区包名可能计入外部引用。

## 架构检测、计划基线和 LLM 设置

- 在「架构扫描」提交任务时可填写分层规则 JSON，页面提供示例。按最长相对路径前缀归层，跨层依赖通过 `allowed` 声明。结果展示循环路径、违规引用行号、未归层文件，并支持按相同规则和解析器版本与历史扫描对比。
- 在「需求与计划」上传或粘贴需求 Markdown 和任务 CSV。可以填入示例、预览工时和工期、确认发布基线，并查看历史版本。工时按人时填写，费率按元/人时填写。
- 在「LLM 设置」填写 API Key，按需填写 HTTPS 基础地址与模型名称。密钥仅保存在当前后端进程内存，服务重启后需要重新填写。后端 `LlmGateway.complete` 接受实现 `LlmProvider` 的适配器。

运行 `npm test` 验证依赖解析、架构规则和计划排程。设计与后续集成见 [落地方案](docs/implementation-plan.md)。

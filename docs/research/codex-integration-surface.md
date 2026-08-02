# Teamline 个人内核 v0：Codex 接入面调研

> 调研日期：2026-08-02
> 范围：Teamline 个人内核 v0 的本地 Codex 受控执行接入。只采用本机已安装 Codex 的公开帮助/生成协议，以及 OpenAI 官方文档和 `openai/codex` 官方仓库。

## 结论

Codex 对 Teamline 存在一个协议上可行、但尚未具备可证明进程围栏的接入面：**由 Teamline 以子进程方式启动 `codex app-server`，使用默认 stdio 上的 JSON-RPC/JSONL 协议控制 thread 与 turn**。这个界面已经能够覆盖工作目录、结构化事件、授权请求、turn 中断、上下文续接、模型与用量信号；OpenAI 也明确把 app-server 定位为认证、历史、授权和流式事件等“深度集成”界面。[App Server 文档](https://developers.openai.com/codex/app-server/) 但当前本机 CLI 仍把整个 `app-server` 命令标为 experimental；下文所称“稳定 schema”只指生成器中未加 `--experimental` 的协议子集，不等于 OpenAI 已承诺整个服务长期稳定。

这还不能直接判定“Codex 已满足受控执行”。`turn/interrupt` 只确认当前 turn 最终进入 `interrupted`，官方稳定协议没有语义化“暂停”，后台终端清理也仍是实验接口。本机真实探针进一步证明：被中断 turn 启动的 `sleep 30` 会继续自然结束；杀死 app-server 后，它仍会被重新挂到 PID 1 下继续运行。因此，**当前朴素的 turn interrupt、杀父进程或杀 app-server 进程组都不能围栏整棵执行树**。结论是“候选协议通过，受控执行不通过；递归后代终止与写入停止验证是阻断项”。

`codex exec --json` 适合作为简单自动化或降级路径，不适合作为首选控制面；它提供单向 JSONL 事件流和 session resume，但没有 app-server 的双向授权请求与细粒度 turn 控制。[非交互模式](https://developers.openai.com/codex/noninteractive/)

## 证据口径

- **已确认**：官方文档/官方仓库明确承诺，且本机 `0.146.0-alpha.9.2` 的帮助或稳定协议 schema 中存在。
- **推断**：可由宿主操作系统或协议组合实现，但不是 Codex 自身给出的端到端保证。
- **不支持/未确认**：公开稳定接口没有该语义，或只有实验接口，不能作为 v0 的可靠合同。

官方资料与本机协议生成记录见文末 L1-L3；真实 app-server 探针见 L4-L9。真实探针用于验证当前本机版本的行为，不能替代官方长期合同；官方文档明确支持但尚未在本机探针覆盖的能力，也不能反过来宣称已做端到端验证。

## 本机真实协议探针

下表是当前机器、`codex-cli 0.146.0-alpha.9.2` 的一次真实 app-server 探针结果，和上文官方合同分层记录：

| 探针 | 结果 | 能力含义 |
| --- | --- | --- |
| 授权回调 | 收到 command approval callback；返回 cancel 后目标 `touch` 文件没有产生 | 授权拦截在当前版本真实可阻止副作用（L4） |
| 用量 | `account/rateLimits/read` 返回数据；运行 turn 时收到 `thread/tokenUsage/updated` | 账户窗口和 thread token 信号在当前认证环境可用（L5） |
| ephemeral resume | ephemeral thread 无法在重启后 resume | 符合“只在内存”的语义；受控委托不能使用 ephemeral（L6） |
| persistent resume | app-server 重启后 persistent thread 可 resume | 对话上下文跨 app-server 进程存活（L6） |
| turn interrupt | `turn/interrupt` 返回成功，turn 最终标为 `interrupted`；`sleep 30` 子进程继续到自然结束 | 协议中断不是进程树围栏（L7） |
| kill app-server | app-server PID/PGID 为 `60125/60125`；`sleep` 子进程 PID/PGID 为 `60371/60371`。杀死 app-server 后，`sleep` 被重新挂到 PID 1 | 杀 app-server 的进程组也不覆盖另建进程组的后代（L8） |
| process id | 协议返回的 `processId` 与宿主 OS PID 不同 | 不能把协议 id 当作系统进程 id 发送信号（L8） |
| resume 安全设置 | 第一次 persistent resume 未显式给安全覆盖时，返回有效设置 `on-request + dangerFullAccess`；thread 已加载后再用 `read-only + never` resume，警告覆盖被忽略 | 首次 materialize/resume 必须显式安全配置并核验回读；不一致即失败关闭（L9） |
| Bun 宿主基线 | 源码运行和 58 MB 单文件产物都完成 SQLite WAL 重开、loopback + runtime secret、跨 PGID 后代递归终止 | Bun/TypeScript 成为领先候选；这只证明宿主机制可做，尚未证明真实 Codex 围栏闭环（L10） |

## 能力逐项判断

### 1. Teamline 持有进程启动与生命周期

**已确认。** 官方示例直接使用 Node `spawn("codex", ["app-server"])` 启动 app-server，并通过 stdin/stdout 交换 JSON-RPC；默认 stdio transport 是逐行 JSON。[App Server：启动示例与协议](https://developers.openai.com/codex/app-server/) 本机也能直接解析 `/Applications/ChatGPT.app/Contents/Resources/codex`，并提供 `app-server`、`exec`、`resume` 等命令（L1-L2）。

Teamline 因而可以持有 app-server 父进程的 PID、stdio、退出码和启动环境。**但“持有 app-server 父进程”不等于“已经围栏其全部后代进程”**。本机探针中 app-server 与 `sleep` 后代进入了不同 PGID；杀父进程后后代被重新挂到 PID 1（L8）。因此 runner 不能只保存 app-server PID/PGID，必须持有可递归发现、终止并复核后代写入者的宿主级身份。

建议 v0 先采用“一项受控委托一个 runner/app-server 进程边界”，不要先共享一个长期 app-server 给多个委托。这样更容易把委托租约映射到明确的宿主进程边界。这个建议属于架构推断，不是 Codex 协议要求。

### 2. 机器可读事件流

**已确认。** app-server 的稳定 stdio 协议是 JSONL 上的双向 JSON-RPC；`turn/started`、`item/started`、`item/completed`、`turn/diff/updated`、`turn/plan/updated`、`thread/tokenUsage/updated` 和 `turn/completed` 等通知能构成结构化执行状态。[App Server：Events](https://developers.openai.com/codex/app-server/) 本机稳定 schema 也包含这些通知（L3）。

`item/completed` 是单个工作项的权威终态；完整 item 列表应由 Teamline 消费 `item/*`，不能只靠 `turn/completed` 的摘要回填。[官方 app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

**降级面已确认。** `codex exec --json` 会把 stdout 变成 JSONL，含 thread、turn、item 与 error 事件，但它更偏向脚本/CI 自动化。[非交互模式：机器可读输出](https://developers.openai.com/codex/noninteractive/)

### 3. 指定工作目录

**已确认。** `thread/start` 可指定 `cwd`；`turn/start` 可覆盖 `cwd`，并使其成为后续 turn 的默认设置。CLI 同时提供 `-C/--cd`，TypeScript SDK 提供 `workingDirectory`，Python SDK 提供 thread/turn 级 `cwd`。[App Server：Start thread/turn](https://developers.openai.com/codex/app-server/) [TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) [Python SDK API](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

对 Teamline 的含义是：每项委托的隔离 Git worktree 可以作为 `cwd`，但 Codex 的 `cwd` 只是执行根目录，不是 Teamline 检查点、内容恢复或安全围栏的替代品。

### 4. sandbox、授权配置与拦截

**已确认。** Codex 支持 `read-only`、`workspace-write`、`danger-full-access` sandbox，以及 `untrusted`、`on-request`、`never` 等授权策略；app-server 可在 thread/turn 级覆盖工作目录、sandbox 与 approval policy。[配置参考](https://developers.openai.com/codex/config-reference/) [App Server：Start turn](https://developers.openai.com/codex/app-server/)

**已确认存在可拦截点，但覆盖范围待验证。** 当 Codex 在当前配置下判定命令、文件变更或新增权限需要授权时，app-server 会向客户端发起带 `threadId`、`turnId`、`itemId` 的 JSON-RPC request；客户端可以返回 accept/decline/cancel 等决定。[App Server：Approvals](https://developers.openai.com/codex/app-server/) 这不等于每一种副作用都会触发回调；`additionalPermissions` 等实验字段也不能作为 v0 的稳定保证。

**本机只实测了一条命令授权路径。** 探针实际收到了命令授权回调；返回 cancel 后，原本要创建的 `touch` 文件不存在（L4）。它证明该命令在这组配置下可被阻止，不能外推到所有文件修改、网络、MCP、hooks、plugins 或其他副作用。

有三个安全注意点：

1. 官方仓库说明，当 `thread/start` 同时给出 `cwd`，且最终 sandbox 为 workspace-write 或 full access 时，app-server 会把项目标记为 trusted 并写入用户 `config.toml`。v0 必须实测并决定是否使用隔离 `CODEX_HOME`、外部 sandbox 或明确的用户同意，不能把这项持久副作用藏起来。[官方 app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
2. `thread/shellCommand` 是稳定接口，但官方说明它绕过 thread sandbox、以完整权限执行；`process/*` 也是显式的非 sandbox 进程接口且仍属实验能力。Teamline v0 不应把这两类接口暴露给本地网页，也不应把它们作为受控 Codex 执行路径。[App Server：Process execution](https://developers.openai.com/codex/app-server/)
3. 直接使用用户现有 `CODEX_HOME` 还可能加载 MCP、hooks、plugins、skills 和额外 instructions。它们不一定都经过已实测的 command approval 路径。规格冻结前必须在“隔离配置”与“显式 allowlist + 回读核验”之间做出选择，并验证如何复用认证而不复制私有 token；在此之前不能宣称授权覆盖完整。

真实 resume 探针还暴露了安全配置的粘性：第一次恢复没有显式传安全设置时，回读为 `on-request + dangerFullAccess`；thread 已经加载后，再用 `read-only + never` 恢复会警告覆盖被忽略（L9）。所以 Teamline 必须在**首次 thread start 或首次 materialize/resume**时提交完整安全配置，并核验返回的有效 `cwd`、approval 与 sandbox。任何不匹配都必须失败关闭，不能先开始 turn 再修正。

因此，本地网页不应直接连接 app-server。建议由 Teamline 后端持有 stdio 与授权状态，网页只连接 Teamline 自己的 loopback API，并由 Teamline 做会话鉴权、Origin/CSRF 校验和授权呈现。

### 5. 暂停、中断、kill 与围栏

#### 中断

**已确认。** `turn/interrupt(threadId, turnId)` 请求取消进行中的 turn；成功响应 `{}`，随后以 `turn/completed.status = interrupted` 收尾。[App Server：Interrupt a turn](https://developers.openai.com/codex/app-server/) 本机探针得到相同协议终态（L7）。

**但它只中断 turn。** 同一探针里，turn 启动的 `sleep 30` 没有随 turn 中断，而是继续到自然结束（L7）。所以 `turn/completed=interrupted` 只能作为“模型 turn 已结束”的证据，不能作为“工作区已经停稳”的证据。

#### 暂停

**不支持。** 公开稳定协议没有“冻结当前执行并在同一指令位置继续”的 pause/resume 语义。`thread/resume` 是恢复一条已持久化对话并开始后续 turn，不是恢复被暂停的进程现场。对 Teamline 来说，主动暂停应定义为：请求 turn 中断，等待停稳，保存内容完整的暂停保存点，之后从新 turn 接续；不能承诺指令级现场继续。

#### kill

**父进程 kill 可做，但不构成围栏。** Teamline 作为宿主可以向自己启动的 app-server 发送 SIGTERM/SIGKILL，并观察父进程退出；这属于 macOS 进程管理能力。Codex 稳定协议没有“kill 整棵 Codex 执行进程树”的请求。本机杀死 app-server 后，`sleep` 后代被重新挂到 PID 1 并继续运行（L8）。

#### 围栏

**朴素方案已确认失败，当前是阻断项。** 官方 app-server README 明确说明，`turn/interrupt` 不负责后台终端；后台终端的 list/clean/terminate 仅为实验 API，本机稳定 schema 也没有这些方法（L3）。真实探针又证明子进程可以拥有独立 PGID，杀 app-server 后继续运行；协议 `processId` 也不同于 OS PID（L8）。即使实验接口返回成功，也没有公开合同证明已覆盖 daemonized/untracked 后代进程。[官方 app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

所以 v0 不能只依赖进程组。runner 必须在破坏父子关系前冻结/枚举并绑定后代进程身份，或使用能覆盖跨 PGID 后代的更强宿主隔离边界，再递归终止和复核；如果进程已经 reparent 且 Teamline 没有保存可靠身份，就不能假装仍能从 PPID 关系找全。只有在后代终止证据与 worktree 写入停止证据都成立后才能确认围栏。任何一步无法证明时，委托保持已中断，不得签发新租约。

### 6. thread 续接与上下文恢复

**已确认。** 非 ephemeral thread 会持久化；`thread/resume` 按 thread id 恢复，后续 `turn/start` 会继续该对话。`thread/list`、`thread/read` 可读取存储的历史，默认列表路径还能扫描 JSONL rollout 修复元数据；恢复时可重放已持久化的 token usage。[App Server：Thread APIs](https://developers.openai.com/codex/app-server/) [官方 app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

**本机已实测。** persistent thread 在 app-server 重启后可以 resume；ephemeral thread 不能 resume（L6）。个人内核 v0 的委托必须使用 persistent thread，并把 thread id 写入 Teamline 自己的持久状态。

TypeScript SDK 的 `resumeThread()` 也明确依赖 `~/.codex/sessions`；Python SDK 对应提供 `thread_resume()`。[TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) [Python SDK API](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)

**边界：** 这只证明“对话上下文可以续接”，不证明“工作区内容是可靠检查点”，也不证明“崩溃中的最后一个 turn 能无损续跑”。Teamline 必须继续以 Git tree、阶段检查点、暂停保存点和待处理现场作为恢复真相；Codex thread id 只是接续上下文的引用。

### 7. 非 CLI 候选面

| 接入面 | 已确认能力 | v0 判断 |
| --- | --- | --- |
| app-server stdio | 稳定 JSON-RPC/JSONL；双向授权；thread/turn；中断；历史；模型；用量 | **首选候选面**。仍需围栏与崩溃实测 |
| TypeScript SDK | Node 18+；包装 `codex` CLI；stdin/stdout JSONL；事件流；thread resume | 可做快速自动化，但公开 API 未确认用户授权请求接管或细粒度 interrupt；不能仅因前端使用 TS 就直接选它。[官方 TS SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) |
| Python SDK | 本地控制 app-server；stream/steer/interrupt；同一客户端可并行多个 turn；发布包带固定 CLI runtime | 适合快速能力 spike；目前是 beta，且打包、签名、升级与 macOS 进程围栏仍需独立评估。[Codex SDK 文档](https://developers.openai.com/codex/sdk/) [Python SDK API](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md) |
| Codex MCP server | 可把本地 Codex 作为更大 Agents SDK 工作流中的 specialist | 适合上层编排，不比 app-server 更直接地解决 Teamline 的宿主进程围栏。[官方 MCP interface](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md) |
| 直接 Responses API | 可自行构建 agent，但不是官方公开的本地 Codex sandbox、授权、进程与 rollout 的等价替代 | 不作为个人内核 v0 的 Codex 适配器；若采用，实质上是 Teamline 自建另一套 agent runtime |

app-server 虽然通过 `codex app-server` 命令启动，但对 Teamline 来说是本地协议服务，不是 TUI 自动化；它满足“接入不必拘泥于 CLI 交互形态”的产品要求。

### 8. 模型、用量、配额与费用

#### 模型

**已确认。** `model/list` 返回可用模型及能力；thread/turn 可指定模型；`model/rerouted` 能报告后端把请求从哪个模型路由到哪个模型。[App Server：Models](https://developers.openai.com/codex/app-server/)

Teamline 可以记录“请求模型 + 实际 reroute 事件 + 本机接收时间”。没有 reroute 事件时，只能记录“未观察到改路由”，不要反推后端绝未改变。

#### 单 thread token 用量

**已确认可检测，不能当作账单。** `thread/tokenUsage/updated` 按 thread/turn 报告并持久化累计用量；本机 schema 的 breakdown 包含 input、cached input、output、reasoning output 与 total token（L3）。官方仓库同时区分了内部 raw upstream usage 与会累计、估算、持久化、重放的 thread token usage，因此该事件适合委托内提示和预算状态，不应宣称为精确计费数。[官方 app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

本机真实 turn 已收到该事件（L5），因此当前环境可以实现委托级 token 提示；仍需保留缺失/延迟的降级路径。

#### ChatGPT 配额

**已确认可读取，但属于账户级信号。** `account/rateLimits/read`/`updated` 可给出 bucket 的 `usedPercent`、窗口长度、重置时间及部分计划/credit 信息；它没有把账户窗口消耗归因到单个 Teamline 委托。[App Server：Rate limits](https://developers.openai.com/codex/app-server/)

本机真实调用已返回 rate-limit 数据（L5）；这证明当前认证环境可用，不保证其他账户、认证模式或未来版本始终返回同样 bucket。

Teamline 应保存：`source=codex-app-server/account/rateLimits/read`、本机接收时间、原始 bucket id/窗口、是否缺失字段。数据为空或认证模式不支持时，只显示“无法执行配额约束”，不能补猜。

#### 账户 token 活动

**已确认可读取但不可归因。** `account/usage/read` 提供 lifetime/daily token activity；它要求 Codex 服务支持的认证，API key-only 与 Bedrock 不支持。[App Server：Token usage](https://developers.openai.com/codex/app-server/)

#### 费用与硬预算

**不支持/未确认。** 公开稳定面没有可靠的“本 turn 实际货币成本”字段，也没有证明 `thread/goal` 的 token budget 会立即终止正在执行的 turn。官方文档只确认 goal 会进入 `budgetLimited` 状态。v0 的最大运行时仍应由 Teamline 本地计时器强制触发中断/围栏；token、费用和账户配额只有在来源可靠时用于提示或条件动作，不能冒充硬执行保证。[官方 app-server README：thread goal](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

### 9. 崩溃恢复与持久化

**已确认的部分：** 非 ephemeral rollout、thread id、历史和累计 token usage可以持久化，进程重启后可 list/read/resume。Codex 的错误事件也能区分连接失败、流断开、用量限制与 sandbox 错误等类型。[App Server：Threads and Errors](https://developers.openai.com/codex/app-server/) 本机 persistent thread 已在 app-server 重启后成功 resume；ephemeral thread 未能恢复（L6）。

**未确认的部分：** 官方公开合同没有承诺在 app-server/宿主进程突然崩溃时，进行中的 turn 一定获得完整终态、所有事件一定落盘、命令后代一定退出，或恢复后可以从中断指令位置继续。现有重启探针只证明 persistent thread 可以再打开，不能把它外推成“崩溃中的 turn 可安全恢复”；进程后代残留已经被真实观察到（L8）。

Teamline 的恢复顺序仍应是：

1. 从自己的执行租约和宿主进程信息判断为疑似中断；
2. 完成旧执行进程树围栏；
3. 独立保存最新完整恢复点之后的 worktree 待处理现场；
4. 从 Teamline 的最新完整恢复点建立干净工作区；
5. 视 Codex rollout 完整性选择 resume 旧 thread 或启动新 thread 并注入恢复摘要。

Codex rollout 不能成为 Teamline 的检查点真相来源。

## 能力分级

| 能力 | 等级 | 说明 |
| --- | --- | --- |
| Teamline 启动并持有 Codex | 可阻止 | app-server 子进程可由 Teamline 创建；外部进程不纳入受控执行 |
| 指定 worktree/cwd | 可阻止 | thread/turn 均可明确设置 |
| 结构化状态与最终结果 | 可检测 | JSON-RPC 事件、item 终态、turn 终态、diff/plan |
| 命令/文件/新增权限授权 | 部分可阻止，覆盖待验证 | 已实测一条 command approval；其他副作用必须逐类验证，缺失回调时 fail closed |
| 主动中断 turn | 可阻止 | `turn/interrupt`，需等待 `turn/completed=interrupted` |
| 语义化暂停并从相同现场继续 | 不支持 | 只能中断后保存并以新 turn 接续 |
| 终止并围栏完整进程树 | **朴素方案失败，阻断** | interrupt、杀父进程、杀 app-server PGID 均不足；需递归后代终止与写入停止复核 |
| Codex 对话上下文续接 | 可检测 | persisted thread + `thread/resume` |
| 崩溃后的指令级现场续接 | 不支持 | 只能安全回退到 Teamline 恢复点 |
| 单委托 token 用量 | 可检测 | thread usage 可归因，但可能估算，不是账单 |
| 账户配额 | 仅提示/条件动作 | 有窗口信号，无单委托归因，字段可能缺失 |
| 单委托实际货币成本 | 不支持 | 稳定公开面没有可靠字段 |

## 对正式宿主技术栈的影响

本轮不冻结正式栈。app-server 的非实验协议子集是语言无关的 stdio JSON-RPC，因此“未来有本地网页”或“SDK 恰好是 TypeScript/Python”都不足以决定内核语言。

补充的 Bun/TypeScript 临时宿主探针已经通过四项基线：`bun:sqlite` 的 WAL 事务在关闭重开后仍存在；`Bun.serve` 可以只监听随机 loopback 端口并用运行时 secret 拒绝未授权请求；宿主可以枚举并逐级终止另建 PGID 的后代；`bun build --compile` 的 58 MB 单文件产物仍能通过相同路径（L10）。这使 **Bun/TypeScript 成为当前领先候选**，因为它以较少依赖覆盖本地服务、SQLite 与打包，也能直接消费当前版本生成的 TypeScript bindings。生成 bindings 是版本相关便利，不是稳定性保证。Bun 仍不是最终决定：SQLite 的结果不是突然断电测试，合成进程树也没有覆盖真实 Codex 的 reparent 竞态、写入停止复核和 crash 恢复。

正式宿主至少要通过以下比较：

1. **进程控制**：能在 Apple Silicon macOS 记录 PID/PGID 与后代关系，在父子关系仍可追踪时冻结/枚举并绑定进程身份，随后逐级 TERM/KILL 和复核；或采用能覆盖跨 PGID 后代的更强隔离边界。只杀进程组已经被探针证伪（L8）。
2. **协议可靠性**：能持续消费 JSONL、关联 request id、响应 app-server 发起的授权请求、处理乱序通知/背压/子进程异常退出。
3. **持久化**：Teamline 自己的租约、检查点、现场引用与事件日志必须 crash-safe；不得依赖 Codex rollout 代替。
4. **本地网页安全**：浏览器只接 Teamline loopback 服务；app-server stdio 不直接暴露。若未来用 WebSocket，官方当前仍将其标为 experimental/unsupported，不应成为 v0 基线。[App Server：Transports](https://developers.openai.com/codex/app-server/)
5. **打包与升级**：能检测 Codex 版本与协议能力、处理用户已有 ChatGPT App/CLI 安装、决定是否捆绑固定 runtime，并在不复制私有 token 的前提下完成认证。
6. **未来工具适配**：Codex adapter 与 runner/process fence 分层，后续 Claude Code、OpenCode 或非 CLI 接口能复用 runner、租约和恢复模型。
7. **安全配置落地**：首次 start/resume 就传入显式安全策略，读取返回的有效设置并逐项核验；thread 已加载后再补覆盖不可靠（L9）。

现阶段可做的合理选择不是“定栈”，而是用 2-3 个很小的宿主 spike 对比：

- 直接驱动 app-server stdio 的最小实现；
- macOS 跨 PGID 后代围栏与写入停止探针；
- crash 后 Teamline 状态 + Codex thread + Git worktree 的联合恢复。

TypeScript 可以直接驱动 app-server，也可以生成 TS bindings；Python 官方 SDK能更快验证 turn interrupt 与并发流；Rust/Go 虽无同等级官方 SDK，也可以实现标准 JSON-RPC client。只有当真实 Codex 围栏、联合恢复、协议背压、crash-safe 持久化、本地网页安全、打包升级与安全配置隔离这些 must-pass 条件全部通过后，Bun/TypeScript 才能冻结为个人内核 v0 宿主；任一核心条件失败时再比较 Rust/Go，不为了形式上的多方案比较提前增加实现成本。

## 规格冻结前的必做 spike

1. ~~在临时 Git worktree 中启动一个独立 app-server 进程组，记录 PID、PGID、threadId、turnId 与 Codex 版本。~~ 已完成基础探针（L4-L9）。
2. ~~运行一个触发命令授权、文件修改和后台子进程的可控测试 turn，核对 server request 与 item/turn 事件。~~ 已确认授权、用量和 interrupt 主路径；仍需完整事件落盘审计（L4-L7）。
3. **重新设计真实 Codex 围栏 spike**：合成 Bun 宿主已能递归捕获并终止独立 PGID 后代，但仍要覆盖真实 Codex 的 reparent 竞态，逐级 TERM/KILL，并以进程复核和 worktree 写入观察共同证明围栏。现有“interrupt/杀父进程/杀 PGID”方案已失败（L7-L8、L10）。
4. 分别在模型流式输出、命令执行、文件修改三个时点 kill app-server；重启后比较 `thread/list/read/resume`、Codex rollout、Teamline 事件与 worktree 待处理现场。
5. 验证 runtime 上限触发的“中断 → 围栏 → 保存现场 → 回退恢复点”闭环；同时测 token 事件的延迟、缺失与恢复重放。
6. 在隔离测试 `CODEX_HOME` 中确认 `thread/start` 对 trust/config 的持久副作用；决定 v0 的授权与配置隔离策略。
7. 用本机版本与一个正式固定版本分别生成 stable schema，做 capability handshake/兼容性检查；不要把 `0.146.0-alpha.9.2` 的实验方法当作长期合同。
8. 为首次 start/resume 增加 fail-closed 安全设置探针：显式传入 `cwd`、approval、sandbox，核对返回的有效设置；模拟 thread 已加载、设置不匹配时必须拒绝启动 turn 和签发租约（L9）。
9. 建立副作用矩阵，分别验证 shell command、file change、网络、新增权限、MCP、hooks、plugins 与后台进程；只有预期回调出现且拒绝后没有副作用的路径才能标为“可阻止”，其余路径必须禁用或失败关闭。

## 当前阻断项

- macOS 后代进程围栏的朴素实现已被实测证伪：turn interrupt 不终止 `sleep`，杀 app-server 后后代 reparent 到 PID 1，杀 app-server PGID 也覆盖不到独立 PGID。合成 Bun 进程树的递归终止已经通过，但真实 Codex 的身份绑定、竞态处理与写入停止复核尚未实现。
- app-server crash 中途的 rollout 完整性和 turn 终态没有实测。
- workspace-write thread start 可能持久写入用户 trust config，v0 的隔离/同意策略未定。
- 正常 `CODEX_HOME` 可能加载 MCP、hooks、plugins、skills 和 instructions；v0 尚未决定隔离配置或显式 allowlist，也未验证在不复制私有 token 的情况下如何复用认证。
- 首次 resume 若不显式给出安全覆盖，可能继承到 `dangerFullAccess`；已加载 thread 又可能忽略后补覆盖。有效设置核验和 fail-closed 路径尚未实现。
- 当前本机 Codex 是 `0.146.0-alpha.9.2`；正式 runtime 的版本固定、升级与兼容策略未定。
- 账户 rate-limit 与 token activity 都不是单委托精确成本，不能据此实现跨工具硬预算。

## 来源与本机验证

### 官方来源

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- [Codex SDK](https://developers.openai.com/codex/sdk/)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [`openai/codex` app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [`openai/codex` TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [`openai/codex` Python SDK API reference](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)
- [`openai/codex` MCP interface](https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md)

### 本机验证

- **L1 — 安装与版本**：`command -v codex` → `/Applications/ChatGPT.app/Contents/Resources/codex`；`codex --version` → `codex-cli 0.146.0-alpha.9.2`。
- **L2 — CLI 帮助**：检查 `codex --help`、`codex exec --help`、`codex exec resume --help`、`codex app-server --help`、`codex mcp-server --help`。确认 `-C/--cd`、sandbox、approval、`exec --json`、resume 与 app-server stdio/WebSocket/Unix transport 参数。
- **L3 — 本机协议 schema**：分别运行 `codex app-server generate-json-schema --out <tmp>` 和加 `--experimental` 的版本。稳定 schema 明确包含 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、命令/文件/权限授权 callbacks、`thread/tokenUsage/updated` 和 `account/rateLimits/read`；后台终端 clean/list/terminate 和 `process/*` 只出现在 experimental schema。
- **L4 — 授权阻止探针**：真实 turn 收到 command approval callback；客户端返回 cancel 后，目标 `touch` 文件没有生成。
- **L5 — 用量探针**：`account/rateLimits/read` 返回账户窗口数据；真实 turn 收到 `thread/tokenUsage/updated`。
- **L6 — 持久化探针**：ephemeral thread 在 app-server 重启后不能 resume；persistent thread 在 app-server 重启后可以 resume。
- **L7 — interrupt 探针**：`turn/interrupt` 请求返回成功，turn 最终状态为 `interrupted`；同一 turn 启动的 `sleep 30` 仍继续至自然结束。
- **L8 — 进程树探针**：app-server PID/PGID=`60125/60125`，`sleep` PID/PGID=`60371/60371`；杀 app-server 后 `sleep` reparent 到 PID 1。协议 `processId` 与宿主 PID 不同。
- **L9 — resume 安全设置探针**：首次 persistent resume 未显式传安全覆盖时，有效设置为 `on-request + dangerFullAccess`；thread 已加载后再以 `read-only + never` resume，收到覆盖被忽略的警告。
- **L10 — Bun 宿主基线探针**：临时 TypeScript 宿主及其 58 MB `bun build --compile` 单文件产物均通过三项检查：SQLite WAL 事务关闭重开、本机随机端口 + runtime secret、枚举并终止另建 PGID 的合成后代进程。这个探针位于 `/private/tmp`，不进入产品仓库；它不等于真实 Codex 围栏或突然崩溃测试。

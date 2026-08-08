# AI Work Control

[简体中文](./CONTEXT.zh-CN.md)

Teamline is for individuals and small teams that rely on one or more AI tools to carry coding, product design, documentation, or research work over time. It focuses on how work is arranged, executed, and recovered, not only on the usage of an individual tool.

English terms in this file are canonical for engineering and product documentation. The Chinese term shown beside each heading is the corresponding `zh-CN` interface term.

## Product Boundary

**Work control layer** (`工作控制层`):
The layer between users and existing AI tools that owns work-goal planning, resource decisions, authorization, state, recovery, and acceptance evidence. Existing AI tools still generate content and invoke tools.
_Avoid_: AI coding agent, model gateway, tool switcher

**AI-native team operating system** (`AI-native 团队运行系统`):
The product's long-term form. It organizes AI-work goals, resource supply, team rules, and capability improvement so teams can turn AI into dependable production capacity. It may expand into resource operations, team capability development, and management governance, but it does not replace code repositories, requirement systems, finance systems, knowledge bases, or general learning platforms.
_Avoid_: AI tool catalog, enterprise collaboration suite, general project management

**Execution host** (`执行端`):
A component on a developer's computer or in a team-owned environment that connects to existing AI coding tools and executes authorized work goals. The goal and checkpoint model is operating-system independent; each platform host adapts process, filesystem, and credential operations. An online console controls local work through the execution host rather than operating the user's computer directly from the browser. Source code, repository credentials, model sessions, and complete execution records remain on the host or in their original systems by default.
_Avoid_: cloud agent, hosted development environment, remote IDE

**Execution-tool integration** (`执行工具接入`):
The integration surface through which Teamline connects to an existing AI coding tool with verifiable control. Its capabilities cover at least selecting the execution workspace, owning the execution lifecycle, obtaining structured state, restoring context, and applying authorization boundaries. Each capability must be classified as able to block, able to detect, advisory only, or unsupported. An integration is not managed execution unless pausing and terminating a process tree, execution fencing, and intercepting new permission requests are reliably validated. The surface may be a CLI, local protocol, official SDK or API, or tool extension; the product model is not bound to one interface and does not treat UI automation as deep integration.
_Avoid_: CLI-defined integration, UI automation, tool switcher

**Personal local console** (`个人本地控制台`):
A complete work-control product for one developer. Its boundary includes goals, plan confirmation, personal rules, resource plans, an execution overview, checkpoints, recovery, execution graphs, and acceptance evidence. Creating a goal only requires the expected result, the necessary materials or workspace, and optional acceptance requirements. Selecting Generate plan grants planning authorization; Codex drafts the plan; Teamline applies default execution authorization and validation methods; and the user confirms stages, impact scope, network permission, and validation on one page with advanced options collapsed by default. Personal kernel v0 validates the loop with one repository, one tool, and one active goal. Personal Alpha must allow at least two goals to run in isolated workspaces, with concurrency limited by local resources and user settings. The personal console is free, accountless, and local by default. It shares the goal and execution engine with the team edition but excludes multi-person governance.
_Avoid_: quota monitor, team-edition trial, deliberately incomplete free edition

**Recovery-logic prototype** (`恢复逻辑原型`):
A disposable terminal prototype used before formal implementation to validate checkpoints, pause savepoints, execution fencing, and recovery state transitions. It does not connect to real Codex and is not a product release. It may temporarily use an existing runtime such as Bun without deciding the production stack.
_Avoid_: Personal kernel v0, production implementation, product demo

**Personal kernel v0** (`个人内核 v0`):
The first production engineering slice that completes a managed goal loop on Apple Silicon macOS with one repository, Codex, one active goal, and a local web interface. It records Codex, an identifiable model, maximum run time, and optional usage or cost alert thresholds for the goal. Run time can cause a hard pause; other resource signals may cause actions only when their source is reliable and they can be attributed to the goal.
_Avoid_: recovery-logic prototype, Personal Alpha, team MVP

**Personal Alpha** (`个人 Alpha`):
The first version intended for sustained use by real individual users. On top of Personal kernel v0, it supports at least two isolated goals in parallel and may connect to existing local tools such as CC Switch through optional resource adapters.
_Avoid_: single-goal prototype, team trial

**Personal edition V2** (`个人版 V2`):
A local release that improves goal creation and import, project organization, execution graphs, results, and resource arrangements after the personal goal loop works. It does not add accounts, cloud synchronization, or team governance.
_Avoid_: team edition, personal cloud edition, complete multi-tool edition

**Paid team MVP** (`团队付费 MVP`):
The first paid release. It reuses the validated personal execution kernel and adds team rules, multi-person permissions, handoff, shared resource constraints, and a centralized control plane.
_Avoid_: Personal Alpha, private enterprise edition, general collaboration suite

**Local web interface** (`本地网页版`):
The browser interface served on the user's computer by the personal local console. It shares a frontend and local service with any desktop wrapper and does not imply that data is uploaded to the cloud. The first phase does not provide a separate hosted personal web service.
_Avoid_: cloud personal edition, remote status page, sign-in-required web app

## User Roles

**Heavy individual developer** (`重度个人开发者`):
An individual who subscribes to and frequently uses several AI coding tools and often delegates development work that takes multiple rounds. This person is an early design partner, personal-edition user, and path for product adoption.
_Avoid_: ordinary individual user, generic developer, power user

**Small AI coding team** (`小型 AI 编码团队`):
A small group of solo founders, early-stage startup members, or an internal company unit that ships products through several AI coding workflows. This is the product's primary commercial customer.
_Avoid_: generic enterprise customer, every engineering team, team user

**First paid team** (`首个付费团队`):
A two-to-eight-person software team led directly by a founder or technical lead. Several members already use one or more AI coding tools in parallel, and the team often advances at least three pieces of work lasting hours or days at the same time. Internal enterprise teams remain in the target market but do not constrain the first product and sales phase.
_Avoid_: every small team, heavy individual developer, enterprise pilot

**Private enterprise edition** (`企业私有版`):
A candidate commercial edition for Chinese enterprises, deployed in customer-owned networks and infrastructure. It aims to reuse the same goal, rule, resource, and acceptance model while adding enterprise identity, permissions, audit retention, network-egress control, offline operations, and support for Chinese tools. Whether it can avoid customer-specific forks must be validated separately after the team SaaS is proven.
_Avoid_: private code branch, custom project, first paid MVP

**Work controller** (`工作控制者`):
The person in a small AI coding team who initiates work goals, confirms plans, handles exceptions, and accepts results. Usually a founder, technical lead, or developer accountable for delivery.
_Avoid_: administrator, project manager, ordinary member

**Goal owner** (`目标负责人`):
The one person currently accountable for closing a work goal. The owner confirms its boundary and plan, handles authorization and exceptions, and advances the result to acceptance. Executors and acceptors may differ, but ownership changes require an explicit handoff.
_Avoid_: multiple owners, default project owner, current executing agent

**Goal handoff** (`目标交接`):
An explicit transfer of responsibility for advancing a goal from its owner or current executor to another member or execution host, based on a stage checkpoint or complete pause savepoint. The handoff carries current state, the effective rule set, unresolved risks, and the recovery entry point.
_Avoid_: forwarding a message, sharing chat history, restarting

**Move goal to team** (`目标转入团队`):
The deliberate action by which an individual user brings a local goal under the team control plane. Personal goals are never uploaded automatically. The move creates an immutable baseline and synchronizes only the plan, source references, resource plan, current checkpoint, state, rule version, and evidence summary needed for team governance. Earlier work is explicitly marked as unmanaged history, and team rules apply only after the baseline.
_Avoid_: automatic personal-work sync, background upload, retroactive compliance record

**Team console** (`团队控制台`):
The collaborative product through which a small AI coding team defines and applies shared operating rules. Shared work state, execution resources, authorization, exceptions, and acceptance evidence provide the context needed for those rules; they are not the product's primary value by themselves.
_Avoid_: team board, project-management tool, collaboration platform

**Team control plane** (`团队控制面`):
The structured control data shared in the cloud by the team console, including goal state, rule versions, authorization and exceptions, check results, and acceptance summaries. It coordinates work through execution hosts but does not store source code, repository credentials, complete model sessions, or complete execution records by default.
_Avoid_: code hosting, cloud workspace, full-log repository

**Execution overview** (`运行总览`):
The main team-console view. It groups current work goals by Needs response, Running, and Review-ready, including blocker reasons under Needs response, and highlights the owner, execution host, pending decision, and resource risks. Its purpose is to find the next work that needs human involvement, not to maintain a project plan.
_Avoid_: project board, task list, team activity feed

**Execution graph** (`执行图`):
A progress view generated for one goal from its confirmed plan and actual execution record. Sequential work appears as a timeline; parallel or dependent work appears as a node graph. Users inspect node details but do not draw the flow or adjust its layout manually.
_Avoid_: execution map, infinite canvas, workflow editor, process-modeling tool

**Team operating rule** (`团队运行规则`):
A shared agreement about how the team plans, executes, and accepts AI coding work. It may apply by member or role, project or repository, tool or model, execution environment, and goal type.
_Avoid_: prompt, team document, personal preference

**Published team rule** (`已发布团队规则`):
A confirmed and versioned team operating rule in the team console that work goals can reference. The console is the sole authoritative source for this rule and its version history. Rules already maintained in repositories, tools, or other systems do not become a second editable copy in the console.
_Avoid_: synchronized rule copy, every external rule

**Verifiable rule** (`可验证规则`):
A rule with an explicit scope and machine-evaluable conditions, such as allowed tools and environments, budget limits, restricted paths and commands, approval conditions, required checks, acceptance evidence, and acceptance roles. Only these rules may be described as automatically enforced or verified.
_Avoid_: arbitrary natural-language rule, model self-assessment

**Rule verification method** (`规则验证方式`):
The execution host's actual capability for a rule: block before execution, detect after execution, collect evidence, obtain human confirmation, or unsupported. Being structured does not imply that a rule can be blocked. The console reports verified, partially verified, or indeterminate according to the real capability.
_Avoid_: universal compliance, model self-assessment, compliance inferred from managed start

**Advisory rule** (`指导性规则`):
A natural-language convention from a repository, tool, or document that may be referenced, passed to AI, and shown to people. Until it is converted into evaluable conditions or confirmed by a person, the product cannot claim it was automatically enforced.
_Avoid_: verified rule, hidden prompt, assumed compliance

**Rule scope** (`规则适用范围`):
The members, projects, tools, execution environments, or work goals constrained by a team operating rule. One piece of work may match several scopes.
_Avoid_: cross-tool rule, global setting

**Effective rule set** (`生效规则集`):
The immutable set of constraints resolved when a work goal's plan is confirmed. The console selects applicable rules from team, repository, tool, and other sources and preserves each source and version. Later changes to an external source only mark the current goal as potentially stale; they do not silently rewrite it.
_Avoid_: rule copy, real-time rule synchronization, latest rules

**Rule conflict** (`规则冲突`):
A case where rules applying to the same work goal cannot all be satisfied and no clearly stricter constraint exists. The console must not silently choose by source, recency, or inference. The work controller resolves the conflict before plan confirmation.
_Avoid_: automatic override, repository wins, newest wins

**Rule exception** (`规则例外`):
A limited relaxation of a published team rule by a work controller. It is scoped to a member, project, goal, or time period and records its reason, approver, and expiry condition. AI and execution tools cannot create or approve exceptions.
_Avoid_: temporary ignore, permanent waiver, agent-approved bypass

## Information Ownership

**Authoritative source** (`权威来源`):
The one system allowed to formally create and modify a class of information. Authority is assigned by information object; it does not require all information to be centralized in one product.
_Avoid_: global source of truth, synchronized primary store

**Source snapshot** (`来源快照`):
An immutable record of the version of an external requirement or document referenced when a work goal's plan is confirmed. A later source change marks the existing plan as potentially stale instead of silently overwriting it.
_Avoid_: document copy, bidirectionally synchronized data

## Work and Results

**Manual coordination burden** (`人工协调负担`):
The attention a developer spends personally tracking the state, context, resources, execution tool, and recovery entry point of several pieces of AI coding work. It is the primary trigger that leads users to seek a work control layer.
_Avoid_: unattended execution alone, quota pain, multi-tool management

**Work goal** (`工作目标`; interface: `目标`):
The basic unit of work managed by the product: a bounded piece of work delegated to an AI tool with an expected result and an acceptance method. Coding, product design, documentation, and research may all form goals. Goals do not nest. Use execution stages for parts of one accepted result; create another goal when work requires independent execution and acceptance.
_Avoid_: mission, vision, large task, subgoal, coding-only work, long-running work only

**Execution session** (`执行会话`):
A continuous interaction and execution record produced by an AI tool around one goal. A goal may retain several source sessions and historical execution sessions, but each source session belongs to only one goal.
_Avoid_: goal, session task, continuing several original sessions together

**Source session** (`来源会话`):
A local Codex session imported by the user to reconstruct a goal's history. It remains in its original system; Teamline stores only a reference and organized results. After several source sessions are grouped into one goal, later work continues in a new execution session.
_Avoid_: current execution session, complete session copy, bidirectional session sync

**Session monitoring catalog** (`会话监控目录`):
A local catalog of discovered sessions from supported AI tools. It stores a reference and user-selected project, monitoring, discovery, read-position, and organization state without creating a goal, grouping object, or control channel for the external session.
_Avoid_: execution session, complete session copy, monitoring group, bidirectional session sync

**Goal conversation** (`目标对话`):
One continuous user-visible conversation with Teamline about the entire goal. It may contain whole-goal discussion and additions for the current node. Execution nodes reference relevant messages but do not create separate chatrooms.
_Avoid_: node chatroom, Codex session list, general chat

**Project** (`项目`):
A top-level collection that organizes related goals around a continuing theme or delivery direction and summarizes their progress, materials, and results. A project has no execution plan, work state, or completion percentage of its own. A goal belongs to at most one project.
_Avoid_: goal bundle, composite goal, parent goal, large goal, project folder, nested project

**Material** (`素材`):
Source content that helps explain or advance a goal. It may be new text, an uploaded file or image, or a reference to a repository, folder, link, or another goal. Materials belong to an independent goal or project. When an independent goal joins a project, its materials enter the project scope automatically; a referenced goal exposes only its name, progress, and results.
_Avoid_: global material library, shared material, attachment, knowledge base, context copy

**Execution plan** (`执行计划`):
A structured, versioned plan owned by the work control layer. It includes stage outcomes, dependencies, impact scope, checkpoints, validation methods, resource plans, and failure-recovery entry points. After planning authorization is granted, Personal kernel v0 asks Codex to propose a structured draft from current context; the user can edit it or switch to manual entry. Only a human-confirmed plan version can receive execution authorization. Teamline does not add a separate cloud planning model in Personal kernel v0.
_Avoid_: agent's temporary plan, external-task copy, automatically effective decomposition

**Planning authorization** (`规划授权`):
The permission granted by the Generate plan action. Codex may read the goal description, selected materials, and necessary context from the selected workspace and send that information only after the interface discloses the receiving service and data scope. Planning authorization does not permit local writes, managed execution, or network access beyond the plan request.
_Avoid_: execution authorization, background prereading, implied consent

**Execution stage** (`执行阶段`):
An independently verifiable intermediate result in an execution plan. It states at least the stage result, expected impact scope, and validation method. Stages are AI nodes or external nodes; they are not divided by elapsed time, conversation round, or file count.
_Avoid_: fixed time block, one conversation, model-assessed progress

**AI node** (`AI 节点`):
An execution stage run by an integrated AI tool that reports progress. V2 treats only Codex as a complete execution integration. Other tools do not appear as live managed nodes until they provide equivalent reporting capabilities.
_Avoid_: every automated step, one model response

**External node** (`外部节点`):
An execution stage completed by a user or by a tool Teamline has not integrated. The user completes it by adding a result, file, or link. V2 does not subdivide external tools into more node types.
_Avoid_: AI node, tool-specific workflow, approval-node type

**Execution workspace** (`执行工作区`):
The local location Teamline uses to advance one goal. A Git repository uses an isolated worktree bound to the goal's execution branch and checkpoints. An ordinary folder is used directly and provides no Git isolation, version history, or rollback. Either may contain code, documents, or other local content, but neither is a filesystem, credential, network, or subprocess security sandbox.
_Avoid_: working directory shared by goals, default project directory, security sandbox

**Checkpoint** (`检查点`):
Teamline records a starting baseline before execution and creates a stage checkpoint only after the planned validation passes for an execution stage. A stage checkpoint is both an addressable recovery position and evidence that the stage completed. It is bound to the goal, plan version, stage, execution lease, Git tree hash, and sequence number. Time intervals, file changes, and AI inference do not create checkpoints.
_Avoid_: pause savepoint, autosave, arbitrary snapshot, WIP commit, crash residue

**Pause savepoint** (`暂停保存点`):
A complete recoverable state saved by Teamline during an intentional pause or handoff after the execution process has stopped. It is a safe continuation position but does not prove that the current stage completed. An incomplete save must not overwrite an earlier stage checkpoint or starting baseline.
_Avoid_: stage checkpoint, stage-completion evidence, crash residue

**Unresolved working residue** (`待处理现场`):
File changes in the execution workspace after the last complete recovery position when execution stops unexpectedly. Teamline preserves them but does not automatically treat them as a stage checkpoint, pause savepoint, or reliable recovery basis.
_Avoid_: checkpoint, saved progress, automatically recoverable state

**Execution interruption** (`执行中断`):
A condition in which the goal awaits a user's choice of recovery path after the execution tool exits unexpectedly or its execution lease expires. It is a reason for the Needs response state, not a top-level state of its own.
_Avoid_: top-level goal state, paused, canceled

**Safe recovery** (`安全恢复`):
The default recovery path. Teamline confirms that the old process tree is fenced, preserves unresolved working residue, builds clean execution state from the latest complete recovery position, and acquires a new execution lease. A complete recovery position may be a pause savepoint, stage checkpoint, or starting baseline. An incomplete pause save falls back to the prior stage checkpoint or starting baseline without automatically mixing in later file changes. If Teamline cannot confirm that the old process stopped, the goal remains Needs response with an execution-interruption reason and Teamline must not claim safe recovery.
_Avoid_: continue from residue, start over, discard residue

**Continue from residue** (`现场接续`):
A non-guaranteed recovery path explicitly chosen by the user to continue using unresolved working residue. Teamline first shows the difference between the residue and the last complete recovery position and never presents the result as reliable automatic recovery.
_Avoid_: safe recovery, automatic recovery, checkpoint recovery

**Goal state** (`目标状态`):
The six top-level states shown to users: Planning (`规划中`), Queued (`待运行`), Running (`运行中`), Needs response (`需响应`), Review-ready (`待验收`), and Completed (`已完成`). Insufficient quota, execution interruption, waiting for an external result, and plan changes appear as state reasons.
_Avoid_: Imported, Interrupted, Blocked, or other extra top-level states

**Goal loop** (`目标闭环`):
The path from creating a work goal and confirming its plan and execution authorization, through execution, response, and recovery, to a user's completion confirmation. It is the minimum value loop that the product MVP must validate.
_Avoid_: quota MVP, monitoring loop, single execution

**Long-running development work** (`长程开发工作`):
Development work that spans multiple AI coding sessions or execution stages and must preserve its goal, progress, and acceptance state.
_Avoid_: long task, prompt, single session

**Reliable completion** (`可靠完成`):
The core outcome promised to individuals and teams: long-running development work remains inspectable, pausable, and recoverable as tools, sessions, or resource conditions change and eventually produces an acceptable result.
_Avoid_: process exited, uninterrupted execution, automatic completion

**Reliable review-ready goals per owner per week** (`每周可靠待验收目标数`):
The number of managed goals each owner advances reliably to Review-ready each week. A goal counts only after plan confirmation, application of an effective rule set, preservation of recovery checkpoints, and provision of acceptance evidence. Work that relies heavily on ad hoc coordination or returns for rework is reported separately rather than hidden by volume.
_Avoid_: completed-task count, agent-run count, quota utilization

**Review-ready** (`待验收`):
The execution tool has exited, required checks confirmed in the plan have passed, and results and check output are stored on the local execution host, but a person has not yet confirmed the result. Personal kernel v0 does not add an AI risk report or repeat summaries of every stage. A goal with failed checks stays in its current stage and is marked as needing attention.
_Avoid_: done, success, completed

**Completed** (`已完成`):
A work goal whose result a user has confirmed meets expectations. Only a person can move a goal from Review-ready to Completed. Process exit or a model's completion claim is not goal completion.
_Avoid_: agent completed, execution ended

**Resource constraint** (`资源约束`):
Quota, budget, time windows, model capability, and team rules that affect how long-running work advances. Quota is one resource constraint, not the product outcome.
_Avoid_: quota alone, balance

**Resource plan** (`资源方案`):
The tools, models, provider references, execution environments, budget, quota, run time, and fallback order approved when a work goal's plan is confirmed. Goal priority, execution pace, and Run when quota allows are user-editable runtime preferences, not part of the AI-generated plan version. Changes to the tool, workspace, hard budget limit, or per-run limit remain governed by the plan and authorization boundary. Teamline owns goal-budget and switching decisions; provider configuration and credentials remain with the corresponding tool or resource adapter. The system may switch tools or providers only at a stage checkpoint. Any out-of-bound or unsafe-to-recover change pauses and requires confirmation.
_Avoid_: usage dashboard, automatic quota purchase, unbounded automatic switching

Personal kernel v0 manages constraints for only one goal. Its resource plan includes at least Codex, an identifiable model, and maximum run time, with optional usage or cost alert thresholds. The local execution host measures run time reliably and can pause at the limit. Token, cost, and quota records include source, time, confidence, and goal attribution; when they cannot be attributed or enforced reliably, the interface says Cannot enforce (`无法强制执行`) and treats them as advisory. Personal kernel v0 does not integrate CC Switch or provide subscription switching, cross-tool allocation, or a resource overview.

Personal Alpha lets users select High, Normal, or Background priority (`优先推进`, `正常推进`, `后台推进`) and Fast, Even, or Quota-saving pace (`尽快完成`, `均匀推进`, `节省额度`) per goal. Run when quota allows (`额度充足时运行`) is off by default. Enabling it is advance authorization for that goal. Teamline may start one bounded run when current, fresh, non-conflicting Codex account quota windows and the plan, node dependencies, workspace, concurrency, and per-run limit all permit it. Teamline re-evaluates after every run, does not predict whole-goal consumption, and does not create unbounded background execution.

Codex account quota windows may inform an authorized single-run start, but this does not attribute aggregate account cost or usage to the goal. Only token or cost data whose source identifies the specific goal enters goal usage; account, organization, or project aggregates remain account-level usage displays.

**Run when quota allows** (`额度充足时运行`):
A runtime preference that gives advance authorization for a goal. Teamline may start one bounded run when both short-term and long-term Codex quota windows meet the reserve required by the current pace, no higher-priority goal is waiting, and formal start checks pass. If quota data is missing, stale, or conflicting, the goal remains Queued and explains why.
_Avoid_: enabled by default, unbounded background execution, trying when account quota is unknown

**Resource signal** (`资源信号`):
Usage, quota, cost, and availability information from a provider, local execution host, resource adapter, or estimation model. Every signal preserves its source, time, confidence, and attribution scope. A current, non-conflicting account quota window may trigger a single run after advance authorization, but cannot attribute goal cost. Other global aggregates, estimates, stale data, and conflicting signals can only inform or request confirmation.
_Avoid_: exact balance, unified bill, unsourced estimate

**Resource adapter** (`资源适配器`):
An integration layer through which Teamline reads provider references, availability, quota, and usage signals from an external tool and requests resource actions after explicit authorization. CC Switch is an optional candidate adapter for Personal Alpha, not a Teamline dependency or budget authority. Provider configuration and credentials remain in CC Switch; Teamline neither reads its private database directly nor copies API keys.
_Avoid_: model gateway, credential hosting, budget authority, required dependency

**Authorization boundary** (`授权边界`):
The execution scope approved when a user or team confirms an execution plan, separate from earlier read-only planning authorization. Personal kernel v0 records at least the execution workspace, execution tool, network permission, maximum run time, and high-risk operations requiring human approval. The system may continue within that boundary; every request for added permission makes Teamline pause the goal and return the decision to a person. Budget and quota without reliable sources may only trigger warnings and cannot be claimed as hard enforcement.
_Avoid_: fully automatic, unlimited permission, confirmation at every step

**Managed execution** (`受控执行`):
A work goal created through the work control layer, with a confirmed plan and authorization, and started or resumed by that layer. The control layer must start the execution tool and own its lifecycle. Work discovered after an external start remains unmanaged. Managed execution lets the layer resolve rules before execution, record checkpoints during execution, and inspect evidence before acceptance, but it reports verified, partially verified, or indeterminate according to each rule's actual verification method. A managed start alone never proves full compliance.
_Avoid_: all AI work, observed-only work

**Execution lease** (`执行租约`):
The right held by only one execution host at a time to advance a repository workspace or execution branch. It is bound to checkpoints and a commit or working-tree fingerprint so two members or hosts cannot modify the same goal concurrently and undermine recovery or auditability.
_Avoid_: simultaneous multi-host advancement, presence-only ownership, unbounded concurrency

**Execution fence** (`执行围栏`):
The safety condition Teamline confirms before recovery or renewed authorization: the old execution process tree has stopped and can no longer write to the execution workspace. Lease expiry is not a completed fence. The system first requests a stop, may ask the user to confirm force termination, and must not issue a new lease when fencing cannot be completed.
_Avoid_: expired lease, state-only update, assumed process exit

**Unmanaged execution** (`非受控执行`):
AI work started externally, bypassing the work control layer. The console may discover, import, or display it, but cannot claim it follows team rules or retroactively record observed results as managed execution.
_Avoid_: violation, governed work

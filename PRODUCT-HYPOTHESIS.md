# Teamline: Complete Product Hypothesis for an AI Work Control Layer

[简体中文](./PRODUCT-HYPOTHESIS.zh-CN.md)

Status: Awaiting pilot validation
Date: 2026-08-02

## One-sentence Hypothesis

When a two-to-eight-person software team has several members advancing AI coding work that lasts hours or days in parallel, its founder or technical lead needs a work control layer above existing tools to confirm plans, configure resources, apply team rules, handle exceptions, and organize acceptance. If that layer lets the same owner reliably advance more goals to Review-ready each week without increasing rework or ad hoc coordination, the team will pay monthly for a shared control plane.

## The Real User Problem

AI coding tools improve the capability of a single run and let teams start more work at once. The new bottleneck is no longer only whether code is written quickly enough. Owners must continually determine what each piece of work is doing, which constraints apply, which resources it uses, where it is stuck, who should take over, and how completion will be judged.

This information is usually scattered across code repositories, requirement systems, chat history, local sessions, and different tools. Each existing system owns part of the facts, but none owns how one piece of AI work moves from a goal to an acceptable result. Founders and technical leads therefore become manual schedulers, recovery entry points, and rule inspectors.

Quota and budget amplify the problem but are not the problem itself. Even if providers removed quota limits, work state, authorization, recovery, and acceptance would still need control across members and projects.

## First Paying Customer

The first customers are two-to-eight-person software teams led directly by a founder or technical lead. Several members already use one or more AI coding tools, and the team often advances at least three pieces of long-running development work at once. The buyer is also the person who confirms plans, handles exceptions, and accepts results each day.

Heavy individual developers use the free personal edition and participate as early design partners. They are not the whole market, but they can upgrade naturally when they form a team. Internal enterprise teams are a later market; compliance, procurement, and private-deployment requirements must not define the first MVP backward.

## The Outcome Customers Buy

The product is not another status board or a larger collection of agents. It lets one owner safely control more parallel AI work while keeping every important piece of work inspectable, pausable, recoverable, transferable, and acceptable.

The core metric is **reliable review-ready goals per owner per week**. A goal counts only when its plan is confirmed, effective rules are applied, recovery checkpoints are preserved, and acceptance evidence is available. Rework, rejection, unplanned manual follow-up, and rule exceptions are guardrail metrics that throughput must not hide.

## What the Product Is

Teamline is a **work control layer** above existing AI tools, not a new agent, model gateway, or cloud IDE. It owns goals and plans, resource plans, authorization boundaries, execution state, checkpoints, handoff, rules, and acceptance evidence. Claude Code, Codex, GLM, and other existing tools still perform the work.

The basic managed unit is a **work goal**, shortened to “goal” in the interface. A goal has a clear expected result, impact scope, completion conditions, resource plan, and one owner. Coding, product design, documentation, and research may all form goals. Teamline imposes no estimated-duration or stage-count entry gate. Short work can have one stage and longer work can have several; long-running, parallel work remains the strongest differentiated use case, not a creation requirement.

The work control layer owns the data structure, versions, and boundaries of the **execution plan**. In Personal kernel v0, Codex proposes a structured draft from repository context; users may edit it or fill it in manually. Teamline does not add a separate cloud planning model. Each execution stage represents an independently verifiable intermediate result and specifies at least the intended result, expected impact scope, validation method, and evidence to retain. Stages are not divided by time, conversation turns, or file count. A stage completes and receives a stage checkpoint only after its agreed validation passes. A human confirms the plan before execution. Changes to the goal, completion conditions, authorization boundary, effective rule set, or resource limits create a new plan version that requires confirmation.

The complete path for one goal is:

`Create goal → Generate plan → Resolve rules and resources → Human confirms and authorizes → Managed execution → Checkpoint / recovery / handoff → Review-ready → Human confirms Completed`

The system may advance autonomously within approved boundaries, but it cannot expand impact scope, budget, tools, or risk permissions. It may declare a result Review-ready; only a designated person may confirm it Completed.

Personal kernel v0 does not build an independent AI acceptance layer. After Codex reports execution finished, Teamline runs only the required validation commands confirmed in the plan and stores the final code diff and command results on the local execution host. Passing work enters Review-ready; failed work remains in its current stage and is marked as needing attention. The acceptance view answers what changed, whether checks passed, and whether the user chooses to accept delivery or continue work. It does not add an AI risk report or repeat every stage summary. A future team control plane receives diff summaries, hashes, and validation results by default, not complete code diffs.

## Personal Local Edition

The personal edition is a complete single-person work console, not a quota monitor, team client, or deliberately incomplete free trial. Its complete product boundary includes local goals, plan confirmation, personal authorization and rules, resource plans, an execution overview across projects and tools, checkpoints, pause and recovery, recoverable tool switching, generated execution graphs, and acceptance evidence. This does not require the first release to support multiple tools and every view at once. Data remains on the device by default, and no account is required.

The Personal kernel v0 entry flow asks users only to select a repository, describe the goal, and optionally specify acceptance requirements. When a user selects Generate plan, the interface first discloses the receiving service and data scope and obtains planning authorization for Codex to read the selected repository. Codex then generates a plan draft and Teamline applies default execution authorization and validation methods. Only after the user reviews stages, code scope, network permissions, and validation commands on one confirmation page does Teamline receive authorization to write files, run commands, and use additional network access. Short work usually receives a single-stage plan. Budget, fallback tools, and detailed rules are collapsed as advanced options rather than required in a complete project form.

The personal and team editions share the same goal and execution engine. Their difference is not basic execution capability. The team edition adds shared rules, multi-person permissions, cross-person handoff, team approval, shared budgets, and centralized audit. This gives the personal edition lasting value and makes it a real adoption path to the team edition.

Personal kernel v0 preserves the resource-adapter boundary without depending on an external resource-management tool. Personal Alpha may use CC Switch as an optional adapter to read provider references, availability, quota, and usage signals and request a switch after user confirmation. CC Switch continues to own provider configuration and credentials. Teamline stores references and owns goal-budget and switching decisions. Global usage that cannot be attributed to a goal may only inform and cannot trigger an automatic budget action. Teamline does not read CC Switch's private SQLite database directly; integration first requires a stable public interface, with upstream contribution if necessary.

Personal kernel v0 resource management validates constraints for one goal only. A resource plan records Codex, an identifiable model, maximum run time, and optional usage or cost alert thresholds. Local run time is measured reliably and can pause execution at the limit. Token, cost, and quota signals may trigger an authorized action only when they retain source, time, confidence, and goal attribution. Otherwise the interface explicitly says Cannot enforce and treats them as advisory. Personal kernel v0 does not integrate CC Switch or provide subscription switching, cross-tool budget allocation, or a resource overview.

The eventual personal product may offer both browser and desktop entry points, but the first phase provides only a web interface served by a local service. Opening the browser shows a local console and does not mean data entered the cloud. A later desktop app wraps the same frontend and local service. A separate hosted personal web app, remote viewing, encrypted backup, and multi-device synchronization remain future hypotheses to validate separately.

When a personal user joins a team, the local console becomes a team execution host. Personal goals are not uploaded automatically. When the user explicitly moves one goal into the team, Teamline creates a transfer baseline and synchronizes the plan, source references, resource plan, current checkpoint, state, rule version, and evidence summary. Earlier work is marked as unmanaged history. Team rules and compliance claims apply only after the baseline.

### Personal Edition V2

V2 remains an accountless local personal product and does not add team collaboration or cloud synchronization. It retains the working goal-creation, plan-confirmation, Codex execution, conversation, result-acceptance, and resource-arrangement capabilities. It improves two main flows: creating and completing a goal from scratch, and organizing one or more local Codex sessions into a goal before continuing it.

The home page shows all goals by default. Projects provide lightweight organization and summaries but have no state, plan, or completion percentage of their own. The goal detail centers on the execution graph, while node detail contains tool calls and raw logs. On entering Review-ready, it opens the results view by default. Codex is V2's only complete execution integration; other tools provide only import or basic state until they support structured reporting.

## Main Team-edition Interface

The team home page is an **execution overview** that prioritizes goals needing human action, running, blocked, and Review-ready. Every item makes its owner, current execution host, next decision, resource risk, and latest checkpoint immediately visible.

Inside a goal, Teamline generates an **execution graph** from the plan and actual checkpoints. Simple work appears as a timeline; complex work expands into stages and dependency nodes. The view may have a canvas-like spatial quality, but users do not draw a process manually. It depicts work that is happening rather than introducing another process model.

Team collaboration revolves around responsibility and handoff. Every goal always has one owner, while executor and acceptor may differ. A change of owner or execution host requires an explicit handoff from a stage checkpoint or complete pause savepoint, carrying current state, rule version, unresolved risks, and the recovery entry point. The first release does not add group chat, general documents, or real-time multi-person editing.

In the minimum permission model, only members explicitly given governance permission may publish team rules and budget boundaries. Goal owners may confirm plans and resources only within those boundaries. Rule exceptions and final acceptance require approval by explicitly designated people. One person may hold several responsibilities in a small team, but each decision still records the permission and identity used at the time.

## How Team Rules Work

The team console is the authoritative source for team rules published in it and their version history. Repositories, tools, and external documents continue to maintain rules in their own scopes; they are not copied into a second editable version in the console.

When an execution plan is confirmed, the console reads all applicable rules, preserves their source and version, and creates an immutable **effective rule set** for the goal. If an external rule changes later, the current goal is marked as potentially stale, but its authorized execution constraints are not silently rewritten.

Only structured, machine-evaluable conditions enter automatic verification: scope; allowed tools and environments; budget limits; restricted paths and commands; approval conditions; required checks; acceptance evidence; and acceptance roles. Each rule also shows whether the current adapter can block before execution, detect after execution, collect evidence, request human confirmation, or does not support it. Natural-language conventions may guide AI and people, but the product cannot claim enforcement without an evaluable condition or human confirmation.

Rules that can all be satisfied apply together, and clearly comparable constraints use the stricter one. A true conflict goes to the owner before plan confirmation. Every relaxation of a published team rule becomes a scoped, time-limited exception with a reason and approver. AI cannot approve it.

Only work created, authorized, and started or resumed through the control layer is **managed execution**. A managed start gives the product an opportunity to verify rules but does not prove full compliance. The console reports verified, partially verified, or indeterminate according to actual evidence. Work started outside the control layer may be discovered and shown, but remains unmanaged and cannot be retroactively converted into a compliant record.

## How Budgets and Tools Enter Execution

Budgets and tools are part of the execution plan, not a separate usage table. When a goal plan is confirmed, it receives a **resource plan** containing allowed tools, models, provider references, and execution environments; preferred and fallback order; budget, quota, and run time; and changes that require renewed approval. Teamline is the authority for goal-budget and resource decisions. Resource adapters such as CC Switch continue to own provider configuration and credentials.

Personal kernel v0 does not implement a complete budget console. Goal detail shows run time, known usage, thresholds, and enforcement capability. Maximum run time is a local hard-pause constraint; usage, cost, and quota thresholds are marked advisory when they cannot be attributed or enforced reliably. Personal Alpha later validates resource overview and allocation across parallel goals and several providers. The paid team MVP then adds shared-budget allocation, reservation, and centralized audit.

The control layer may trigger authorized automatic tool switching only when the resource signal is current, attributable, and meets rule requirements and a verified recoverable stage checkpoint exists. Estimated, stale, or conflicting signals may only inform or request confirmation. The first pilot offers a switching recommendation confirmed by a person; automatic cross-tool switching remains a later hypothesis. A goal must pause when it is expected to cross a boundary or cannot recover safely. The team console shows budget reservations, actual consumption, and remaining resources, but the first release does not buy or resell model quota or centrally host provider accounts.

Usage and cost from providers, local execution hosts, resource adapters, and estimation models are resource signals. Every signal states its source, time, confidence, and attribution scope. Only signals attributable to a specific goal may participate in goal-budget actions; global aggregate usage can only inform. The product must not present unstable estimates as exact bills.

## Information and Deployment Boundaries

The product does not create a global source of truth for all information. It assigns an authoritative source to each object class:

| Information | Authoritative source | Stored by this product's control plane by default |
| --- | --- | --- |
| Requirements and documents | Original systems such as Linear, Jira, or Notion | Links, version IDs, hashes, and necessary summaries; body snapshots only when explicitly enabled by the team |
| Code, branches, commits, and tests | Git and CI | Commit references, check results, and evidence summaries; no complete code |
| Published team rules and versions | Team control plane | Complete structured rules, scope, versions, and verification methods |
| Personal rules and personal goals | Personal local console | Not uploaded by default; necessary control records synchronize only after an explicit move to team |
| Team goals, plans, authorization, state, exceptions, and acceptance | Team control plane | Complete structured control records |
| Team budget allocation and resource reservations | Team control plane | Budget, reservations, source, time, and confidence |
| Provider actual usage and bills | Corresponding provider | Readings or estimates with source and time, never presented as the provider's bill |
| Credentials, raw code, complete model sessions, and raw execution logs | Local environment or original provider | Not uploaded to this product's control plane by default |

When an external source changes, the control layer warns that a plan may be stale and does not perform field-level bidirectional synchronization. The console may write progress and evidence summaries back to the original system without taking ownership of the source content. “Not uploaded by default” refers only to this product's cloud control plane. How an existing AI coding tool sends data to its provider remains governed by that tool and the team's provider settings.

The team edition uses a cloud control plane and local execution hosts. Personal kernel v0 asks Codex to draft plans from the local host. If a future independent cloud model generates plans, Teamline must separately disclose the fields sent, provider, retention, and redaction policy before it is enabled.

## Minimum Security Boundary

The local execution host has extensive permission, so its security boundary is part of the product promise rather than a later implementation detail. The personal local web interface listens only on loopback by default and uses an installation-specific access credential. The host runs with least privilege and does not write repository credentials or secrets into control records.

Before the formal specification is frozen, Teamline must test candidate Codex integration surfaces and classify workspace selection, structured state, context restoration, permission control, pause, termination, and process fencing as able to block, able to detect, advisory only, or unsupported. If process-tree pause and termination, execution fencing, or new-permission interception cannot be implemented reliably, that surface cannot be called managed execution and the personal kernel cannot continue promising those capabilities. A Git worktree isolates Git working state only; it does not restrict parent-path access, credentials, network, or subprocesses.

Authorization has two phases. Selecting Generate plan permits Codex only to read the selected repository and send necessary context to the receiving service disclosed in the interface; it does not permit code writes or execution. Confirming the execution plan then grants execution authorization for the workspace, Codex integration, network permission, maximum run time, and high-risk operation rules. Execution may continue within that scope. Any request for new permission makes Teamline pause the goal and return the decision to a person; the execution tool cannot approve itself. Budget and quota without reliable sources produce warnings rather than claims of hard enforcement.

Only one execution host may hold the execution lease for a repository workspace or execution branch at a time, but an expired lease does not prove that the old process stopped. Recovery first asks the old process tree to stop, confirms it can no longer write, preserves unresolved working residue, creates a clean recovery workspace, and issues a new lease. The user may explicitly choose force termination when necessary. If Teamline cannot confirm that the old process stopped, the goal remains Needs response with an execution-interruption reason and Teamline cannot claim safe recovery. Stage checkpoints and pause savepoints bind to a commit or working-tree fingerprint. Pause, recovery, and handoff all verify that another execution has not modified the workspace.

Users and teams always retain controls to pause and revoke authorization. If the control plane disconnects, the execution host cannot obtain new authorization. It may advance only within its current authorization to the next stable stopping point, then pauses and creates a pause savepoint. Emergency security rules may invalidate an old rule set and pause affected goals, but cannot silently replace it and resume execution. Recovery requires renewed plan confirmation and authorization.

## Build Order

The first phase begins with a recovery-logic prototype independent of the production stack. Teamline then tests candidate Codex integration surfaces and compares production stacks for macOS process fencing, Git recovery, crash persistence, local-web security, installation and upgrades, and future host adapters. The technical specification is frozen only after both gates pass. Personal kernel v0 then validates plan confirmation, checkpoints, interruption recovery, and acceptance evidence with one repository, Codex, a local web interface, and one active goal. Personal Alpha must support at least two goals in isolated workspaces; local resources and user settings determine the actual concurrency limit, and the domain model must not make one active goal a global constraint. Personal kernel v0 implements and validates only an Apple Silicon macOS execution host and does not promise multiple tools, operating systems, or every view.

The second phase reuses the same execution kernel for the first paid team control plane: shared goals, published structured rules, minimum permissions, handoff, team budgets, and centralized acceptance records, still with only one deep tool integration.

The third phase expands to multi-project and multi-tool overviews, validated tool switching, desktop packaging, optional personal cloud services, and private enterprise deployment. Every phase depends on usage evidence from the previous one; the long-term vision does not justify building all modules in parallel.

## First Paid MVP

The first paid MVP proves one vertical team loop. An owner creates a goal from repository and external requirement references; the system generates a plan and resolves rules and resources; after owner confirmation, the local execution host starts an existing tool; the console records state and checkpoints and supports pause, recovery, and handoff; after required checks and evidence collection, the goal enters Review-ready.

The first release integrates only:

- one code-hosting platform;
- one generic local command entry point;
- one validated controllable Codex integration surface, which is not assumed in advance to be the CLI.

The paid pilot explicitly excludes automatic cross-tool switching, general documents, chat, requirement management, bidirectional synchronization, a freeform canvas, hosted agents, cloud development environments, provider-account hosting, and verification of arbitrary natural-language rules.

## Business Model

The personal local edition is free and provides a complete single-person work-control loop. Teams pay for a shared control plane, published team rules, multi-person permissions, resource coordination, authorization and exceptions, cross-person handoff, and centralized audit.

The first pricing hypothesis is USD 99 per team workspace per month, including five active members, then provisionally USD 20 per additional member per month. Teamline does not charge by goal count or take a share of model consumption. This price tests willingness to pay; it is not an established final price.

A later commercial hypothesis is a **private enterprise edition** for Chinese enterprises. It runs in customer-owned networks and infrastructure and aims to reuse the same goal, rule, resource, and acceptance model while adding enterprise identity, permissions, audit retention, network-egress control, offline operations, and Chinese-tool integration. Annual licensing and implementation support without a customer-specific product branch is a direction to validate through enterprise interviews and delivery-cost evidence, not a committed roadmap. The first release preserves only a boundary that permits independent control-plane deployment.

## Validation Method

Personal Alpha first recruits 12 design partners for four weeks. The phase passes if at least eight people complete three qualifying managed goals and at least six are still actively using the product in week four. Usage and completion data are stratified in advance by short and long-running work. Recovery success is measured only for multi-stage goals that encounter or simulate interruption, and at least 80% must recover from a complete recovery position without rebuilding the goal and plan. If most people only inspect quota and rarely create goals, the personal-entry hypothesis fails.

Before the team pilot, complexity tiers are frozen without making complexity an entry requirement for managed execution. Any work with a clear boundary, code changes, and an acceptance method may become a goal. “At least two hours or two execution stages” only distinguishes long-running and short work in advance so their outcomes can be observed separately. A simplified baseline log captures the same fields, and the tiers cannot change after the pilot or be inflated through arbitrary goal splitting.

Five qualifying teams then record a two-week baseline, pay USD 99, and use the product for four weeks. The team hypothesis passes only if all of the following hold:

- at least three teams place more than half of eligible long-running AI development work into managed execution;
- after applying the predetermined complexity tiers, reliable review-ready goals per owner per week increase at least 30% from baseline; teams with a zero baseline use a preregistered absolute target;
- first-pass acceptance within three business days does not fall below baseline, while major rework, unplanned coordination time, and rule-exception rates do not materially worsen after normalization by goal;
- at least three teams actually pay another USD 99 after the pilot rather than only expressing purchase intent.

The plan and rule system separately records mechanism metrics: first-pass plan acceptance, replanning, checkpoint recovery success, verifiable-rule coverage, distribution of verification methods, blocked out-of-bound actions, approval wait time, budget overruns, and resource interruptions. These distinguish improvement caused by plans, rules, and checkpoints from mere state visibility and prevent premature investment in a complex rule engine.

If teams inspect quota and state but will not start goals through the product, or if plan creation and rule handling add more work than they remove, the core hypothesis fails despite active pages. Teamline should then revisit the work control layer rather than mask the problem with training, budget management, or more integrations.

## Primary Risks

The largest product risk is not whether Teamline can draw a console, but whether teams will route important work through a managed entry point. If creating goals, confirming plans, and handling rules costs owners more effort than asking people directly, the product has not succeeded.

The second risk is low-quality AI decomposition. If a plan cannot produce sensible checkpoints, validation evidence, and recovery entry points, the execution graph, resource plan, and handoff lose their foundation. Personal pilots must already record plan acceptance, replanning, and checkpoint recovery success.

The third risk is that external tool interfaces limit rule enforcement. The product must distinguish blocking before execution, detecting afterward, collecting evidence, obtaining human confirmation, and advisory guidance. It cannot manufacture a false sense of governance through model self-assessment.

The fourth risk is that GitHub, Cursor, OpenAI, or another platform bundles team scheduling and governance into an existing product. The control layer must create independent value in rules and responsibility across members, projects, tools, and execution environments. There is little room for a separate product when users only need management inside one tool.

The fifth risk is the security responsibility created by highly privileged local execution and cloud control. Teamline cannot be used for important repositories without least privilege, execution leases, emergency pause, checkpoint integrity, and explicit data destinations.

The sixth risk is allowing enterprise demands to introduce private deployment, compliance, and custom delivery too early. The enterprise edition should expand only after the small-team loop is proven and should first validate whether one product model can really be reused.

## Long-term Vision

The long-term product is not “more AI tools.” It is an **AI-native team operating system** that helps teams advance goals reliably, configure resources, apply rules, and continually improve human-AI collaboration.

It expands in four directions: work control remains the core; resource operations cover tool subscriptions, model budgets, quota, and execution environments; team capability development captures rule templates, best practices, onboarding paths, and training from real work; and management governance provides views of return on investment, delivery quality, risk, exceptions, and audit.

These capabilities can grow only from the managed goal loop. Teamline does not replace code repositories, requirement systems, finance systems, knowledge bases, or general learning platforms.

## Decisions Reserved for Pilots

The following do not block the product definition, but design partners and real data must decide them:

- the first code-hosting platform, the Personal kernel v0 Codex integration surface, and the feasibility and later order of Claude Code, OpenCode, and Chinese AI coding tools;
- whether the default two-hour or two-stage criterion usefully separates long-running and short work;
- the checkpoint, recovery, and evidence capabilities available from different tools;
- how visual or manual acceptance without automated validation commands enters Review-ready and how rejection changes state;
- the resource-signal quality required for automated actions from each provider;
- whether CC Switch offers a stable public integration surface and whether its usage can be attributed reliably to a goal;
- field-level retention, deletion, encryption, and tenant-isolation policies for team-cloud data;
- acceptance of the USD 99 team price in different regions;
- the first Chinese model, identity system, and deployment environment for the private enterprise edition;
- whether the personal local kernel is open source, and the boundaries among free, open-source, and commercial licenses;
- the working product name Teamline and working domain teamline.dev, which still require trademark, domain-connection, and design-partner validation.

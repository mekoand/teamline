# Teamline Personal Edition V2

[简体中文](./personal-v2.zh-CN.md)

Status: Product scope confirmed
Date: 2026-08-04

## Release Goal

V2 gives users one local workbench where they can understand what AI work is doing, who needs to act next, and whether quota conditions permit continued execution. It adds session import, project organization, a real execution graph, and a clearer information hierarchy to the existing goal loop, while turning plan nodes into real execution and validation boundaries.

V2 must complete two main flows:

1. New goal: enter a goal, generate and confirm a plan, inspect the execution graph, run and respond, inspect results, and confirm completion.
2. Imported goal: select one or more Codex sessions, organize them as one goal, inspect historical progress, detect source updates, continue in a new session, and confirm completion.

## Release Boundary

- Personal and local: no account, with data stored on the device by default.
- Codex is the only complete execution integration.
- Projects organize goals, materials, and results; they do not perform project management.
- Existing goal creation, plan confirmation, execution, conversation, results, and resource capabilities remain and are reorganized under the V2 information architecture.
- Goals may cover coding, product design, documentation, research, and other work with a clear result.

V2 excludes team members and permissions, cloud synchronization, project constraints, complete execution integration for several tools, a freeform canvas, automatic acceptance of plan changes, and exact allocation of Codex subscription quota.

## Information Architecture

### Home

The home page shows all goals by default; users do not need to enter a project first. It organizes goals by state and recent updates and emphasizes Needs response and Review-ready.

The home page provides two primary entry points:

- Create goal;
- Import Codex session.

Projects and Resources appear in the global navigation. Create project sits beside the project area and does not compete with the two goal entry points.

### Goal Detail

Desktop preserves a three-level relationship:

- left: global navigation, goal list, and project entry points;
- center: goal overview, execution graph, or results;
- right: details and next actions for the current goal or selected node.

The right side is not an independent information page. It follows the user's selection in the center. Conversation is an expandable area; it opens automatically for clarification or response but is not the default main interface.

On narrow screens, users enter List → Goal → Node details one level at a time instead of compressing all three columns. Chinese headings reflow for mobile and do not inherit fixed desktop line breaks.

### Project Summary

A project page shows only:

- total and completed goal counts;
- goals that are Running, Need response, or Review-ready;
- recently updated goals;
- project materials;
- primary results already produced.

A project has no plan, execution state, acceptance, or completion percentage of its own. Selecting a goal opens ordinary goal detail.

### Resources

The top bar shows only a short Codex quota status. The Resources page shows quota windows, concurrency settings, and resource arrangements for each goal. Goal detail shows only the current goal's resource settings. When quota does not affect a goal, the home page does not repeat resource explanations.

## Core Objects

### Goal

A goal has an independent expected result and acceptance method. Creation requires only:

- goal name;
- desired result;
- optional project.

Materials, acceptance requirements, and execution settings are added after creation. Goals do not nest. Work requiring independent execution and acceptance becomes another goal.

### Project

A goal belongs to at most one project and may belong to none. When a goal joins a project, its own materials enter project scope automatically without another confirmation.

Project materials may be new text, uploaded files or images, or references to local folders, repositories, links, and other goals. Project goals can see project materials, but not all material is sent to Codex by default. Teamline recommends relevant items, and users may add or remove them.

### Execution Stage

An execution plan contains two stage types:

- AI node: Teamline starts one Codex execution and validates the node after it exits;
- External node: a user or external tool completes it, and the user marks it complete by adding a result, file, or link.

V2 does not add dedicated node types for approval, design tools, browsers, or similar work.

### Session

A goal has one continuous user-visible conversation for whole-goal discussion and additions to the current node. Several Codex execution sessions may occur underneath. Nodes reference relevant messages but do not create separate chatrooms.

Source sessions reconstruct history from before import; the current execution session advances later work. Goal detail provides separate open actions for them.

## Goal States

V2 shows only six top-level states:

- Planning;
- Queued;
- Running;
- Needs response;
- Review-ready;
- Completed.

Insufficient quota, waiting for concurrency, execution interruption, waiting for an external result, validation failure, and required plan adjustment appear as state reasons rather than new top-level states.

Import is not a state. If Teamline cannot organize the sessions, the goal remains Planning with a Not yet organized explanation.

## New Goal and Plan

After goal creation, Teamline generates a plan from the goal description and selected materials. The interface does not expose Ask Matt or another skill name.

- Generate a plan draft directly when information is sufficient.
- Ask only critical questions whose answers would materially change the result.
- Ask one question at a time.
- When ordinary details are incomplete, generate an editable plan instead of repeatedly asking questions.

The main execution graph follows the user-confirmed plan. If Codex discovers an important unplanned step, it may report Suggest new node. Teamline places the goal in Needs response and updates the plan only after user confirmation. V2 does not provide automatic acceptance of node changes.

## Execution and Validation Boundary

V2 defines one AI node as one Codex execution, one node validation, and optionally one stage checkpoint in a Git workspace. A node is no longer a logical segment inside one long process.

Nodes within one goal execute serially for now. Even when several nodes could start together, Teamline follows the confirmed plan order one at a time. Different goals may still run in parallel.

Each run follows this flow:

1. Teamline selects only one currently runnable AI node.
2. The prompt contains only the current node and the context needed to complete it and asks Codex to exit after completing that node.
3. After Codex exits, Teamline organizes and validates only the current node.
4. After automatic validation passes, Teamline saves the node result; a Git workspace receives a stage checkpoint, and execution continues to the next AI node by default.
5. After all nodes complete, the goal enters Review-ready for one whole-goal confirmation by the user.

Automatic advancement stops and the goal enters Needs response when:

- the current node has no automatic validation and needs user confirmation;
- automatic validation fails;
- the next node is external;
- Codex explicitly asks for more information;
- sign-in, permission, or another execution condition changes.

Teamline determines node state from its start, Codex exit, and node validation. Model output such as `TEAMLINE_STAGE_START` and `TEAMLINE_STAGE_COMPLETE` is at most a logging hint and cannot determine state.

Consecutive nodes prefer the current workspace and start the next run in the same Codex session, creating a new session only when the prior one is unavailable. Later nodes must not repeat the complete goal-start flow because doing so would duplicate workspace preparation and the starting baseline.

A Git workspace records one starting baseline and a stage checkpoint after automatic validation or user confirmation of a node result. An ordinary folder retains only run state, node results, and existing files and does not offer checkpoint recovery.

## Import Codex Sessions

### Creation Rules

Each import creates one goal. Users may select one or more Codex sessions serving the same result and enter a goal name. They perform separate imports to create separate goals.

Import does not create a project. Users may select one existing project or leave the goal outside projects.

### Reading and Organization

When users confirm Import goal, they also authorize Teamline to:

- read the complete selected sessions locally;
- ask Codex to organize a goal summary, key nodes, current state, and result references;
- store the organized result and references to the original sessions.

This confirmation does not authorize continued execution. Teamline does not store copies of complete sessions; original content remains in Codex's local data.

If Codex is temporarily unavailable, Teamline still creates the goal in Planning so the user can retry organization later.

### Source Updates

Teamline records source-session IDs, last-read time, and session update time. It checks the Codex session index when the local service starts, when a goal opens, and through low-frequency polling. When an update time advances, Teamline shows Source session has new content. Only selecting Reorganize reads the additions and updates the summary and execution graph.

V2 does not use real-time filesystem watching or continuously synchronize the original session in both directions.

### Continue Goal

After import, Teamline shows history read-only and does not start automatically. When the user selects Continue this goal, Teamline generates a follow-up plan and asks for confirmation of the workspace and execution settings.

When several source sessions were selected, all remain historical sources. Teamline creates one new consolidated session for continued work and does not attempt to run the original sessions together.

### Open in Codex

Goal detail provides actions to:

- open a source session in Codex;
- open the current execution session in Codex;
- copy a session ID;
- copy a CLI resume command.

Before V2 implementation, a real test must determine whether Codex App deep links are fully compatible with non-interactive sessions created through the CLI. If not, `codex resume <SESSION_ID>` remains the recovery entry point.

## Execution Graph

The execution graph is the default center of goal detail, not a chat window or editable canvas.

### Main Graph

- Sequential work appears as a node timeline.
- Parallel or dependent work is automatically arranged as a node graph.
- Desktop expands horizontally; narrow screens switch to a vertical layout.
- The system generates node positions; users cannot freely drag the layout.

For a running goal, the confirmed plan is the primary graph. When an imported goal has no original plan, Teamline may organize nodes from session history and labels them Organized from session.

### Node Detail

Selecting a node shows on the right:

- node goal and actual state;
- Codex stage summary;
- tools used;
- files read or modified;
- validation results;
- raw-log entry point.

Tool calls and complete logs do not appear directly as primary graph nodes.

### State Reporting

Codex may report Needs response and Suggest new node and may emit node-start or node-complete logging hints. Actual node state still comes from Teamline's single-node start, exit, and validation process. A tool without structured reporting may still import sessions and show basic run state, but cannot appear as a complete integration with live node progress.

## Results and Acceptance

When a goal enters Review-ready, goal detail switches from the execution graph to the results view by default. The results view prioritizes:

- actual artifacts, including files, folders, images, links, or text;
- completion summary;
- validation results;
- unfinished items;
- Confirm completed and Continue adjusting actions.

When work still serves the original goal, Continue adjusting adds requirements and generates a follow-up plan within the current goal. Create a new goal only for a new result that can be accepted independently.

A Completed goal may be referenced as material by another goal. By default it exposes only its name, progress, and results, not its complete conversation and logs.

## Resource Arrangements

V2 provides for every goal:

- priority: High, Normal, or Background;
- pace: Fast, Even, or Quota-saving;
- Run when quota allows, off by default;
- maximum run time per round;
- current Codex quota windows and recent-consumption reference.

V2 does not provide exact allocations such as “20% of the Codex subscription for this goal.” Money budgets may be added after an API can bill accurately and enforce hard limits.

When Run when quota allows is enabled, Teamline may schedule a confirmed AI node. It must stop for a plan change, missing user input, an external node, validation failure, Review-ready, or the run limit. After each round it re-evaluates quota and concurrency conditions.

## Completion Criteria

### New-goal Flow

1. A user can create a goal that is not limited to coding.
2. Teamline can generate a plan, ask only critical result-changing questions, and ask one at a time.
3. The user can run Codex after confirming the plan.
4. Every AI node produces one independent Codex execution and advances only after validation passes.
5. The execution graph shows planned nodes, actual state, and node detail.
6. A goal needing human action enters Needs response and explains the reason and next step.
7. A Review-ready goal prioritizes actual results.
8. The user can confirm completion or continue adjusting.

### Imported-goal Flow

1. A user can select one or more local Codex sessions and create one clearly named goal.
2. Teamline uses Codex to produce a history summary, key nodes, current state, and result references.
3. Original sessions are not copied and remain openable from goal detail.
4. Teamline detects source-session updates and reorganizes only on user action.
5. The user can continue in one new consolidated session without modifying original source sessions.
6. Later execution, response, and acceptance use the same flow as a new goal.

## Suggested Ticket Breakdown

The following breakdown is for creating later development tickets. This specification does not create external issues itself.

### V2-01: Domain Data and Compatible Migration

Add projects, goal name and description, project membership, source sessions, and the current execution session. Preserve compatibility through the existing `work_orders`, `WorkOrder`, and `/api/work-orders` layer. Separate Review-ready from the existing Needs response display into its own top-level state and update state mapping, home-page grouping, CLI, resource display, and tests. Existing goals must still open with all data after a local database upgrade.

### V2-02: Home and Goal-detail Information Hierarchy

Reorganize global navigation, the all-goals home page, and goal detail. Center the main area on the execution graph or results, and use the right side only for current context. Complete desktop and narrow-screen layouts.

Depends on: V2-01.

### V2-03: Project Summary and Project Materials

Implement project creation, goal membership, the project summary, project materials, and result aggregation. Recommend relevant project materials while creating or continuing a goal and let users change what is actually sent to Codex. Do not add project state, plans, percentages, or constraints.

Depends on: V2-01, V2-02.

### V2-04: Single-goal Session Import

Replace bulk session import with one goal per import. Support several source sessions, an existing project or no project, Codex organization, retry after failure, source update detection, and reorganization. Add a real Codex App navigation test and a CLI recovery entry point.

Depends on: V2-01, V2-02, V2-03.

### V2-05: Basic Import for a Non-Codex Session

Reuse the single-goal import flow to add source discovery, history organization, and basic state for at least one non-Codex local tool. That tool does not receive execution, continuation, live-node reporting, or resource-scheduling capability. Choose the first tool before implementation according to a format that can be read locally.

Depends on: V2-01, V2-02, V2-04.

### V2-06A: Single-node Execution and Validation Boundary (critical path)

Make every AI node one independent Codex execution and one node validation; pass only the current node to Codex. After validation passes, reuse the current workspace for the next node. Stop for absent automatic validation, validation failure, an external node, a Codex information request, or changed execution conditions. Git workspaces save stage checkpoints by node; ordinary folders do not offer checkpoint recovery. Node state does not depend on stage markers in model output.

Depends on: V2-01.

### V2-06: Execution Graph and Structured Progress

Reuse the existing execution plan and run events to implement timeline or graph presentation, imported-node labels, node detail, tool and log entry points, and Codex reports for node start, completion, Needs response, and suggested nodes.

Depends on: V2-01, V2-02, V2-04, V2-06A.

### V2-07: Goal Conversation and Clarification

Unify conversation at the goal level while preserving node references. Generate a plan directly when information is sufficient, ask only critical questions, and require confirmation for plan changes.

Depends on: V2-01, V2-02.

### V2-08: Results View and Continued Adjustment

Reorganize existing result capabilities so Review-ready goals show artifacts, summaries, and validation results by default. Implement Confirm completed, Continue adjusting, and references to completed goals.

Depends on: V2-02, V2-06, V2-07.

### V2-09: Resource Hierarchy and Automatic-run Boundaries

Organize the top-bar quota summary, Resources page, and goal resource settings. Unify the Queued state and ensure automatic execution stops for plan changes, external nodes, validation failure, Review-ready, and the per-run limit.

Depends on: V2-01, V2-02, V2-06, V2-06A.

### V2-10: Migration and Main-flow Regression

Cover upgrades of existing databases, existing `/work-orders/:id` URL compatibility, both V2 main flows, a 390 px narrow viewport, and an ordinary desktop width. Check the wrapping and hierarchy of Chinese headings, buttons, and state reasons.

Depends on: V2-03 through V2-09, including V2-06A.

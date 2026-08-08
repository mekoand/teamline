# Teamline Personal Edition v0

[简体中文](./personal-v0.zh-CN.md)

Status: In implementation
Date: 2026-08-02

## Product Goal

Teamline Personal helps developers manage several pieces of AI coding work at once. Instead of watching separate terminals continuously, users create goals, confirm plans, inspect progress, continue after interruptions, and confirm results from one local page.

The personal edition first tests one question: will developers entrust real work to Teamline, and does doing so require less attention than opening several AI coding sessions directly?

## Target User

The first users are individual developers who use Codex frequently and often advance several projects or pieces of development work at once. The product also suits solo founders, but v0 excludes multi-person collaboration.

## Core Flow

1. The user selects a local Git repository and enters a goal and optional completion requirements.
2. Teamline generates a short plan that the user can edit and confirm.
3. The user starts the goal, and Teamline invokes Codex in the selected repository.
4. Goal detail continuously shows the current stage, recent progress, run time, and next action.
5. When execution stops or exits unexpectedly, the goal enters Needs response with an execution-interruption reason and preserves current code changes and the latest record.
6. The user can continue from existing progress or adjust the plan and restart.
7. After Codex exits, Teamline shows code changes and check results. The user confirms completion or continues working.

## Goal States

- `Planning`: the goal or plan has not been confirmed.
- `Queued`: the plan has been confirmed and the goal is ready to run.
- `Running`: Codex is advancing the work.
- `Needs response`: execution has stopped or a decision or adjustment is required; execution interruption appears as the reason.
- `Review-ready`: execution has ended and the user needs to inspect the result.
- `Completed`: the user has confirmed that the result meets the goal.

States describe the work progress a user needs to understand. They do not promise absolute operating-system control.

## Main Pages

### Home

The home page shows all goals grouped by Needs response, Running, Review-ready, and Recently completed. Each card shows:

- title and repository;
- current state;
- current stage or latest progress;
- elapsed run time;
- the user's next action.

The home page provides a Create goal entry point. Several goals may exist at once; actual concurrency is determined by the user's device and settings.

### Create Goal

Creation requires only:

- selecting a local Git repository;
- describing the desired work;
- optionally entering completion requirements.

Advanced settings do not appear on the first screen.

### Plan Confirmation

The plan stays short. Every stage includes an outcome and completion check. Users may edit stages, regenerate the plan, or confirm it directly. Execution cannot start before confirmation.

### Goal Detail

Goal detail is the core page of the personal edition. It includes:

- the goal and plan;
- current stage and recent progress;
- Codex run state and elapsed time;
- pause, continue, and stop actions;
- a code-change summary;
- check results;
- recent run records.

### Completion Confirmation

After execution ends, the page answers:

- what changed;
- which checks passed or failed;
- whether unresolved items remain.

The user may confirm completion or add requirements and continue.

## Data Model

Each goal stores at least:

- title, goal, and completion requirements;
- repository path;
- plan and current stage;
- current state and recent progress;
- Codex run records;
- start time, accumulated run time, and end time;
- Git change summary and check results.

All data is stored locally by default. No account is required.

## Codex Integration

v0 integrates only Codex. Teamline starts it, reads output, records run state, and receives user pause or stop requests. Different Codex versions may expose different information, so the interface shows only state that Teamline can obtain reliably.

Continuing after an interruption does not depend on the original process still existing. Teamline can give the goal, plan, recent progress, and current code state to a new Codex execution so work can continue.

## Resource Information

v0 shows accumulated run time. It shows tokens or cost only when Codex provides reliable data and otherwise does not estimate an exact amount. Users may set run-time alerts, but v0 does not manage subscriptions or allocate budgets across tools.

## Local Product Form

The personal edition consists of a local service and a browser page:

- the local service stores goals and starts Codex;
- the browser page displays and operates goals;
- repository and run data are not uploaded to the Teamline cloud;
- the first release does not provide desktop packaging or a hosted personal web app.

## Out of Scope for v0

- Claude Code, OpenCode, or other tools;
- team members, permissions, handoff, and shared rules;
- general project management, chat, and a knowledge base;
- subscription switching, quota purchasing, and a complete budget system;
- remote viewing, multi-device synchronization, and cloud execution;
- virtual machines, system extensions, or complex security systems;
- automatically determining that the business result is certainly correct.

## Implementation Order

1. Local service, data storage, and goal home page.
2. Goal creation and plan confirmation.
3. Starting Codex, reading output, and showing progress.
4. Interruption, continuation, and run records.
5. Code changes, check results, and completion confirmation.

Every step should produce a complete small capability usable directly in the browser. Do not first build abstractions for a future team edition.

## v0 Completion Criteria

Personal edition v0 is complete when users can perform this flow locally:

1. Create a goal for a real repository and confirm its plan.
2. Start Codex from Teamline.
3. Leave and reopen the page while retaining the goal and run state.
4. Continue from existing progress after an interruption.
5. Inspect code changes and check results.
6. Confirm the goal Completed.

Product validation then observes whether users choose to complete several pieces of real work through it over time.

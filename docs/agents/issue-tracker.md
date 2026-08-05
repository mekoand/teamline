# Issue tracker: GitHub

Issues and product requests for this repository live in `mekoand/teamline` on GitHub. The complete submission and lifecycle policy is maintained in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Before writing

Resolve the repository from the local `origin` remote and confirm it is `mekoand/teamline`. Do not guess the repository from a stale worktree name.

## Agent rules

- Start implementation only from an unclaimed issue labeled `ready-for-agent`.
- Leave a short starting comment, associate the issue with the executor, and replace `ready-for-agent` with `in-progress`.
- Read the goal, scope, exclusions, acceptance criteria, dependencies, and linked context before changing code.
- If a product-level ambiguity appears, replace the state with `needs-info` and ask the smallest question that resolves it.
- Do not expand a local issue into a refactor or additional feature without updating the issue and receiving the required decision.
- Link the pull request or commit. Close the issue only after the change reaches the default branch and satisfies its acceptance criteria.
- Remove workflow-state labels when the issue closes.

Use direct references such as `Depends on #123`. A blocked dependency uses the `blocked` state. Larger work may use GitHub parent and sub-issues; do not encode version, type, or dependency order in titles.

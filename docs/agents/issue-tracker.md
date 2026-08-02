# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Repository binding

This repository is bound to `Mastalie/teamline` through the `origin` remote.

Before an issue-tracker write:

1. Run `gh repo view` inside this repository.
2. Verify that it resolves to `Mastalie/teamline`.

Do not guess the repository or create issues in an unrelated repository.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Apply labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`. The `gh` CLI does this automatically inside a correctly configured clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues, rather than external pull requests, are the default request and planning surface.

## Skill terminology

When a skill says “publish to the issue tracker”, create a GitHub issue.

When a skill says “fetch the relevant ticket”, run:

`gh issue view <number> --comments`

## Wayfinding operations

A wayfinder map is represented by one parent issue with linked child decision issues.

- Map label: `wayfinder:map`
- Child labels: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`
- Prefer GitHub sub-issues and native issue dependencies.
- If native dependencies are unavailable, add `Blocked by: #<number>` to the issue body.
- A ticket is ready only when all blockers are closed and it has no assignee.
- Claim a ticket with `gh issue edit <number> --add-assignee @me`.
- Resolve it by recording the decision, closing the issue, and updating the parent map.

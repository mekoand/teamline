# Contributing to Teamline

Teamline is in early access. Clear bug reports, focused feature requests, documentation improvements, and small pull requests are welcome.

You may write issues in English or Chinese. Do not duplicate the same issue in both languages.

## Before opening an issue

Use one of the repository forms:

- **Bug report** for behavior that does not work as expected.
- **Feature request** for a user problem or new product capability.
- **Implementation task** for a task already shaped by a maintainer.
- **Other** when the request does not fit the first three forms.

Small typo, link, and formatting fixes may go directly to a pull request. Product behavior, features, bugs, and substantial documentation changes should start with an issue.

Issue titles should describe the problem or outcome directly. Do not add version or type prefixes such as `[V2]`, `Bug:`, or `PRD:`. Types belong in labels and planned versions belong in milestones.

## Issue types

Each open issue has one type after triage:

| Label | Use |
| --- | --- |
| `type:bug` | Existing behavior is incorrect |
| `type:feature` | A new or changed user capability |
| `type:task` | A focused implementation, documentation, or maintenance task |

An issue opened through **Other** may temporarily have no type until its first triage.

## Issue states

Each open issue has one workflow state:

| Label | Meaning |
| --- | --- |
| `needs-triage` | A maintainer has not evaluated the issue yet |
| `needs-info` | More information or a product decision is required |
| `backlog` | The issue is valid but not scheduled for implementation |
| `ready-for-agent` | The issue is fully specified and can be claimed |
| `in-progress` | Someone is actively implementing the issue |
| `blocked` | The task is clear but cannot proceed yet |

Workflow labels are removed when an issue is closed. Type labels and milestones remain as history.

## Ready for an agent

Only a maintainer, or a coordinating agent explicitly authorized by a maintainer, adds `ready-for-agent`. The issue must include:

- A clear problem or goal
- A defined scope and explicit exclusions
- Observable acceptance criteria
- Dependencies, or `None`
- No unanswered question that could change the implementation direction

A bug also needs reproducible steps and the current behavior. A technical design is optional unless it is necessary to keep the implementation within scope.

Acceptance criteria should be short and proportional to the change. Do not create evidence packages, formal gates, or long process reports for ordinary work.

## Claiming work

Anyone may work on an unclaimed `ready-for-agent` issue without waiting for approval.

1. Leave a short comment that you are starting.
2. Open a linked draft pull request as soon as there is a useful change to share.
3. A maintainer will assign the issue and change its state to `in-progress`.

If an issue already has an active claim or draft pull request, coordinate with that contributor instead of starting a duplicate implementation. A `backlog` issue is open for discussion, but substantial implementation should wait until its direction is confirmed.

If implementation exposes a product-level ambiguity, stop the affected work, change the state to `needs-info`, and ask the smallest question that resolves it. Ordinary implementation details that do not change product behavior can follow the existing codebase conventions.

## Dependencies and larger work

Write `Dependencies: None` when a task can start independently. Otherwise use direct references such as `Depends on #123` and mark the issue `blocked` until the dependency is complete.

Large features may use GitHub parent and sub-issues. The user-facing issue remains the main discussion entry. Split implementation issues only when the work contains genuinely independent changes.

## Completing an issue

A pull request should reference its issue and use `Closes #123` when merging it should complete the work. Do not close an issue before its implementation reaches the default branch and its acceptance criteria are met.

The final issue update should stay short:

- **Changed:** what was completed
- **Checked:** the relevant checks that ran
- **Linked PR:** the pull request, or the commit when no PR exists

Use GitHub's `Not planned` reason for requests that are declined, out of scope, or no longer relevant. Link the original before closing a duplicate.

## Development setup

The currently supported development environment is Apple Silicon macOS with [Bun](https://bun.sh/) and a locally installed, signed-in Codex CLI.

```bash
git clone https://github.com/mekoand/teamline.git
cd teamline
bun run dev
```

Open <http://127.0.0.1:4310>. Run the test suite with `bun test`.

## 中文说明

Issue 可以只使用中文填写，不需要同时翻译成英文。请根据问题选择 Bug、Feature、Implementation task 或 Other 表单。新 Issue 会先进入 `needs-triage`；只有目标、范围、验收和依赖都明确后，维护者才会添加 `ready-for-agent`。

任何人都可以直接认领尚未被处理的 Ready Issue。开始时请留言，并尽快建立关联的 Draft PR。小型错别字、链接和格式修复可以直接提交 PR；产品行为、功能、Bug 和较大的文档调整应先创建 Issue。

请勿在公开 Issue 中粘贴 Token、凭据、完整本地路径、完整 Codex 会话或其他敏感信息。安全问题请使用仓库的私密漏洞报告入口。

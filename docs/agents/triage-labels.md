# Issue Labels

## Types

Each open issue has one type after triage. An issue submitted through the Other form may temporarily have no type.

| Label | Meaning |
| --- | --- |
| `type:bug` | Existing behavior is incorrect |
| `type:feature` | A new or changed user capability |
| `type:task` | A focused implementation, documentation, or maintenance task |

## Workflow states

Each open issue has exactly one workflow state.

| Label | Meaning |
| --- | --- |
| `needs-triage` | A maintainer has not evaluated the issue yet |
| `needs-info` | More information or a product decision is required |
| `backlog` | The issue is valid but not scheduled for implementation |
| `ready-for-agent` | The issue is fully specified and available to claim |
| `in-progress` | Someone is actively implementing the issue |
| `blocked` | The task is clear but cannot proceed yet |

`priority:critical` is optional and reserved for problems that block use, lose data, or prevent Teamline from running. Other issues do not require a priority label.

Workflow labels are removed when an issue closes. Type labels and milestones remain as historical information.

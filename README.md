# Teamline

<p align="center">
  <img src="public/teamline-logo.png" alt="Teamline" width="240">
</p>

<p align="center">A local control console for running AI work as clear, reviewable goals.</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  v2.1 ·
  Early access · Apple Silicon macOS
</p>

Teamline gives AI work a place outside the chat window. It turns a goal into a plan, runs each AI stage as a separate Codex execution, keeps the current state visible, and collects the result for review.

Teamline's control service and interface run on your Mac, and Teamline does not require an account. Goals, plans, execution records, and references are stored in the local Teamline data directory; uploaded materials are copied into that directory. When Teamline organizes imported sessions, generates a plan, or executes a goal, the local Codex installation may send the necessary session, goal, material, or workspace content to OpenAI under the user's Codex configuration and data settings.

![A three-stage goal in Teamline](docs/images/teamline-progress.jpg)

## What Teamline does

- Creates goals for coding, product design, documentation, research, and other work with a clear outcome.
- Generates an editable plan before execution begins.
- Imports one or more local Codex sessions into a single goal, then continues the work in a new session.
- Runs AI stages one at a time. Each stage has its own Codex execution, result, and validation step.
- Shows progress as a timeline or node graph without exposing every raw tool call by default.
- Collects generated files, completion summaries, and validation results for review.
- Tracks Codex availability and lets each goal choose a priority, pace, and run-time limit.
- Keeps Codex accounts separate, observes each account's available quota windows, and binds a running goal to its account.
- Can opt a goal into paid API fallback with global and per-goal limits when actual usage is available.
- Organizes goals into lightweight projects with referenced or uploaded materials.

## How it works

1. Create a goal or import existing Codex sessions.
2. Generate, edit, and confirm the plan.
3. Choose a Git repository or regular folder and start the goal.
4. Follow each execution stage, respond when needed, and review the final result.

Teamline runs stages serially inside one goal. Different goals can run in parallel up to the local concurrency limit.

## Product views

### Review the actual result

The result view brings the completion summary, changed files, and validation results together before final acceptance.

![Result review with generated files and validation](docs/images/teamline-results.jpg)

### Manage local AI resources

The resource view shows the currently available Codex signal and the run preferences attached to each goal. Usage and cost are only shown when Teamline can read and attribute them reliably.

![Codex availability and goal resource settings](docs/images/teamline-resources.jpg)

## Current status

Teamline is in early access. The current product version is `v2.1`.

The supported setup is:

- Apple Silicon macOS
- [Bun](https://bun.sh/)
- A locally installed and signed-in Codex CLI
- Local browser interface and CLI

There is no packaged installer yet. Windows, Linux, hosted accounts, and full execution support for tools other than Codex are not currently available.

## Run from source

```bash
git clone https://github.com/mekoand/teamline.git
cd teamline
bun run dev
```

Open <http://127.0.0.1:4310>.

Teamline stores its local database under `.teamline/` by default. Set `TEAMLINE_DATA_DIR` to use another location.

Paid API fallback is optional and off by default. Provide a project-scoped `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, and the matching `OPENAI_PROJECT_ID`. Use a project dedicated to Teamline: paid nodes are serialized, and the observed project-cost increase is assigned to the goal that ran. Teamline does not save the keys. It starts no paid run without a per-goal limit and the global monthly budget configured in the resource page. Provider cost reporting can be delayed, so the limits stop later nodes after observed usage reaches them; they are not exact hard caps. If actual usage cannot be attributed to the goal, Teamline waits instead of estimating it; a confirmed zero-cost or cross-month edge can be cleared manually from the resource page.

Run the test suite with:

```bash
bun test
```

## CLI

Keep the local service running, then use the CLI from the directory related to your goal:

```bash
bun run cli -- create "Fix the intermittent blank login page" --acceptance "Relevant tests pass"
bun run cli -- list
bun run cli -- show <goal-id-or-prefix>
bun run cli -- interrupt <goal-id-or-prefix>
bun run cli -- continue <goal-id-or-prefix>
bun run cli -- open <goal-id-or-prefix>
```

Planning, the execution graph, result review, and resource settings remain in the browser interface.

## Roadmap

The next product directions are:

- Easier installation and updates
- More AI tool integrations
- Team collaboration

These are directions, not release commitments or dates.

## Documentation

- [Personal V2 specification](docs/specs/personal-v2.md)
- [Personal v0 specification](docs/specs/personal-v0.md)
- [Architecture decision records](docs/adr/)
- [Product hypothesis](PRODUCT-HYPOTHESIS.md)

The longer specifications and product hypothesis are currently maintained in Chinese. ADRs include English and the original Chinese text.

## Contributing

Bug reports and feature requests can be written in English or Chinese. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## License

Licensed under the [Apache License 2.0](LICENSE).

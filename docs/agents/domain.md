# Domain Docs

How engineering skills should consume Teamline’s domain documentation.

## Before exploring

Read:

- `CONTEXT.md` at the repository root.
- Relevant ADRs under `docs/adr/`.

If either location does not exist, proceed silently. Domain documentation is created and refined when real terminology or decisions are resolved.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── agents/
└── src/
```

## Use the glossary vocabulary

Use domain concepts exactly as defined in `CONTEXT.md`, including issue titles, specifications, tests and implementation language.

Do not replace established Teamline terms with synonyms that the glossary explicitly rejects.

If a required concept is absent, either reconsider whether it belongs in the product or record it as a domain-modeling gap.

## Respect ADRs

Before changing an architectural or product boundary, read the ADRs related to that area.

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.

# Development log

A time-ordered narrative of notable work on host-monitor: what changed, why it
mattered for the hosts that run it, the evidence, and links worth keeping for
future troubleshooting. It is also the release history; this repository has no
`CHANGELOG.md`. It complements the current documents:

- Commit messages say what changed. The devlog says why, and keeps validation
  commands, observed behavior, run numbers, and links that a diff cannot.
- `README.md` and `DEVELOPMENT.md` remain current. Update them first when
  configuration keys, snapshot fields, API routes, entrypoints, or the release
  contract change.
- The devlog is append-only session narrative; when a decision becomes policy,
  update the normative docs and link to them from here.

## When to add an entry

Add one for every release (a `package.json` version bump) and after other
development work that is not a small or trivial change, especially when it
produces a durable outcome worth future lookup: a new collector adapter, an API
or schema addition, a security fix, a change consumers must follow, or an
external link you will want again. Skip trivial, transient, or same-turn fixes
with no future value.

A release entry names the version, the user-visible changes, anything an
infrastructure consumer must change (entrypoint paths, configuration keys,
Node version). The release notes carry the artifact id.

## Conventions

- One file per month: `docs/devlog/YYYY-MM.md`. Newest entry on top.
- English, like all repository content.
- Keep current docs current. The devlog records the narrative; it does not
  replace updates to the owning documents.
- No secrets or sensitive operational data. Never write plaintext secrets,
  private keys, tokens, auth state, machine-local home paths, or collected
  host data beyond what the documentation already uses as examples.
- Commit each entry on its own when committing: `docs(devlog): <month> -
  <subject>`.

### Entry template

```md
## YYYY-MM-DD - <short title>

### Result
- What shipped or changed.

### Why / context
- The non-obvious reasoning or operational context.

### Evidence
- Commands run and key observations.

### Links
- Commits, issues/PRs, external refs, and relevant doc sections.

### Follow-ups
- Optional.
```

## Months

- [2026-09](2026-09.md)

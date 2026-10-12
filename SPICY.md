# SPICY.md: edits to upstream-owned files

OpenCode Spicy Edition keeps new code in new folders. Every change to a file that upstream (`anomalyco/opencode`)
also owns is listed here so upstream merges stay predictable. Each edit in the code carries a `spicy:` comment.

| File | Change | Why |
|---|---|---|
| `packages/schema/src/event-manifest.ts` | Import `Workbench` and `AgentHQ`; add their `Event.Definitions` to `featureDefinitions` | Workbench and Agent HQ events reach the server and client manifests |
| `packages/opencode/src/agent/agent.ts` | Default permissions `verify.exec` ask, `debug.*` ask, `debug.memory` deny | The built-in `"*": "allow"` would otherwise allow these silently |

New files owned by the fork (no upstream conflict): `packages/schema/src/workbench.ts`,
`packages/schema/src/agent-hq.ts`, `packages/opencode/src/workbench/**`, `packages/opencode/src/agenthq/**`,
`packages/app/src/workbench/**`, `packages/app/src/agenthq/**`, `docs/SPICY_IDE_*.md`, `SPICY.md`.

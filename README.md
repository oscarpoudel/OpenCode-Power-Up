# OpenCode Power-Up

> **Important**: This repository is designed to be cloned directly into your `.opencode` directory to enhance your OpenCode environment.

OpenCode Power-Up is an optimized expansion for OpenCode, providing advanced agents, commands, hooks, and skills for professional software engineering.

## Branches

| Branch | Target | Status |
|--------|--------|--------|
| `main` | OpenCode **V1** | Original configuration |
| `v2` | OpenCode **V2** (2.x) | Plugin API port |

> **On the `v2` branch:** OpenCode V2 changed the plugin API and **V1 plugin
> implementations do not load**. See [OpenCode V2](#opencode-v2) below before
> using this branch.

## Installation

To use OpenCode Power-Up, clone this repository directly into your `.opencode` directory in your project folder:

```bash
git clone https://github.com/oscarpoudel/OpenCode-Power-Up.git .opencode
```

If you already have an `.opencode` directory after you create it in your project folder, ensure this content is merged into it.

## Features

### Agents (12)

| Agent | Description |
|-------|-------------|
| planner | Implementation planning |
| architect | System design |
| code-reviewer | Code review |
| security-reviewer | Security analysis |
| tdd-guide | Test-driven development |
| build-error-resolver | Build error fixes |
| e2e-runner | E2E testing |
| doc-updater | Documentation |
| refactor-cleaner | Dead code cleanup |
| go-reviewer | Go code 
| database-reviewer | Database optimization |

### Commands (31)

| Command | Description |
|---------|-------------|
| `/plan` | Create implementation plan |
| `/tdd` | TDD workflow |
| `/code-review` | Review code changes |
| `/security` | Security review |
| `/build-fix` | Fix build errors |
| `/e2e` | E2E tests |
| `/refactor-clean` | Remove dead code |
| `/orchestrate` | Multi-agent workflow |
| `/learn` | Extract patterns |
| `/checkpoint` | Save progress |
| `/verify` | Verification loop |
| `/eval` | Evaluation |
| `/update-docs` | Update docs |
| `/update-codemaps` | Update codemaps |
| `/test-coverage` | Coverage analysis |
| `/setup-pm` | Package manager |
| `/go-review` | Go code review |
| `/go-test` | Go TDD |
| `/go-build` | Go build fix |
| `/skill-create` | Generate skills |
| `/instinct-status` | View instincts |
| `/instinct-import` | Import instincts |
| `/instinct-export` | Export instincts |
| `/evolve` | Cluster instincts |
| `/promote` | Promote project instincts |
| `/projects` | List known projects |
| `/harness-audit` | Audit harness reliability and eval readiness |
| `/loop-start` | Start controlled agentic loops |
| `/loop-status` | Check loop state and checkpoints |
| `/quality-gate` | Run quality gates on file/repo scope |
| `/model-route` | Route tasks by model and budget |
| `/infrastructure-audit` | Audit infrastructure readiness |

### Plugin Hooks

> **V2 only:** these hooks are currently disabled. See
> [OpenCode V2](#plugin-status-on-v2).

| Hook | Event | Purpose |
|------|-------|---------|
| Prettier | `file.edited` | Auto-format JS/TS |
| TypeScript | `tool.execute.after` | Check for type errors |
| console.log | `file.edited` | Warn about debug statements |
| Notification | `session.idle` | Desktop notification |
| Security | `tool.execute.before` | Check for secrets |

## Configuration

Full configuration in `opencode.json`.

```json
{
  "model": "wulver-vllm/Qwen36-Qwen36-27b",
  "small_model": "anthropic/claude-haiku-4-5",
  "plugin": ["./plugins"],
  "instructions": [
    "skills/tdd-workflow/SKILL.md",
    "skills/security-review/SKILL.md"
  ]
}
```

## OpenCode V2

OpenCode 2 changed the plugin API. Per the official migration guide:

> V1 plugin implementations do not run in V2. Moving a file or renaming its
> config entry is not enough.

A V2 plugin must default-export a definition with an `id` and a `setup(ctx)`
function:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

A V1 plugin exports a bare function and returns a hooks object instead. On V2
that fails at load with:

```
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function. (cause: SchemaError(Expected object at ["default"]))
```

### Event API changes

Several V1 events and fields do not exist in V2. A literal port compiles but
never fires:

| V1 | V2 |
|----|----|
| `session.error` | `session.execution.failed` |
| `message.updated` | `session.execution.succeeded` |
| `session.idle` | `session.idle` (unchanged) |
| `error.name` | `error.type` |
| `event.properties` | `event.data` |
| `tool.execute.before` hook key | `ctx.tool.hook("execute.before", ...)` |
| `shell.env` hook key | `ctx.shell.hook("create.before", ...)` |
| returned `event` hook | `ctx.event.subscribe()` |
| returned `dispose()` hook | cleanup function returned by `setup` |

### Setup

The V2 plugin imports `@opencode/plugin`, so install dependencies after
cloning:

```bash
cd .opencode
npm install
```

`package.json` and `package-lock.json` are tracked on this branch for that
reason. `@opencode-ai/plugin` (V1) is still required by the helper scripts in
`tools/`.

Verify:

```bash
opencode plugin list   # expect: opencode-auto-continue
```

### Plugin status on V2

| Plugin | Status | Notes |
|--------|--------|-------|
| `plugins/auto-continue.ts` | **Active** | V2 port, sends `continue` after a retryable error |
| `plugins-disabled/ecc-hooks.ts` | Disabled | V1 API, needs porting |
| `plugins-disabled/index.ts` | Disabled | Re-exported the V1 hooks |
| `plugins-disabled/graphify.js` | Disabled | V1 API, needs porting |

The V1 sources are kept in `plugins-disabled/` so they are not lost. They are
**not** loaded: OpenCode only loads the top level of `.opencode/plugins/`, so
moving them out of that directory disables them while leaving `lib/` available
to `tools/changed-files.ts`.

### auto-continue

Sends `continue` when a session goes idle after a transient provider or tool
error, so long runs recover without manual intervention.

Configure with `.opencode/opencode-auto-continue.jsonc` (all keys optional):

```jsonc
{
  "enabled": true,
  "throttleMs": 10000,      // min ms between auto-continues per session
  "delayMs": 500,           // delay after idle before sending continue
  "maxConsecutive": 5,      // give up after N consecutive retries (0 = unlimited)
  "errorPatterns": [],      // replaces the 19 built-in match patterns
  "excludePatterns": []     // replaces the 2 built-in exclude patterns
}
```

Runtime control:

| Command | Scope | Effect |
|---------|-------|--------|
| `/ac` or `/ac status` | — | Show resolved settings, location, pattern counts, config path |
| `/ac on` / `/ac off` | This session only | Toggle without touching the config file |
| `/ac reset` | This session only | Drop session overrides and reload from the config file |
| `/ac global on` / `/ac global off` | This location | Persist the toggle to `opencode-auto-continue.jsonc` |
| `/ac global reset` | This location | Re-read the config file from disk |

Note: OpenCode passes only the text *after* the command name to a command, so
`/ac status` arrives as `status`. The command accepts both forms.

## License
MIT


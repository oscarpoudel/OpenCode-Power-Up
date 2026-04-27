# OpenCode Power-Up

> **Important**: This repository is designed to be cloned directly into your `.opencode` directory to enhance your OpenCode environment.

OpenCode Power-Up is an optimized expansion for OpenCode, providing advanced agents, commands, hooks, and skills for professional software engineering.

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
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",
  "plugin": ["./plugins"],
  "instructions": [
    "skills/tdd-workflow/SKILL.md",
    "skills/security-review/SKILL.md"
  ]
}
```

## License
MIT


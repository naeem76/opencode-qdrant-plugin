---
name: blueprint
description: >-
  Turn a one-line objective into a step-by-step construction plan for
  multi-session, multi-agent engineering projects. Each step has a
  self-contained context brief so a fresh agent can execute it cold.
  Includes adversarial review gate, dependency graph, parallel step
  detection, anti-pattern catalog, and plan mutation protocol.
  TRIGGER when: user requests a plan, blueprint, or roadmap for a
  complex multi-PR task, or describes work that needs multiple sessions.
  DO NOT TRIGGER when: task is completable in a single PR or fewer
  than 3 tool calls, or user says "just do it".
origin: community
---

# Blueprint — Construction Plan Generator

Turn a one-line objective into a step-by-step construction plan that any coding agent can execute cold.

## When to Use

- Breaking a large feature into multiple PRs with clear dependency order
- Planning a refactor or migration that spans multiple sessions
- Coordinating parallel workstreams across sub-agents
- Any task where context loss between sessions would cause rework

**Do not use** for tasks completable in a single PR, fewer than 3 tool calls, or when the user says "just do it."

## How It Works

Blueprint runs a 5-phase pipeline:

1. **Research** — Pre-flight checks (git, gh auth, remote, default branch), then reads project structure, existing plans, and memory files to gather context.
2. **Design** — Breaks the objective into one-PR-sized steps (3-12 typical). Assigns dependency edges, parallel/serial ordering, model tier (strongest vs default), and rollback strategy per step.
3. **Draft** — Writes a self-contained Markdown plan file to `plans/`. Every step includes a context brief, task list, verification commands, and exit criteria — so a fresh agent can execute any step without reading prior steps.
4. **Review** — Delegates adversarial review to a strongest-model sub-agent (e.g., Opus) against a checklist and anti-pattern catalog. Fixes all critical findings before finalizing.
5. **Register** — Saves the plan, updates memory index, and presents the step count and parallelism summary to the user.

Blueprint detects git/gh availability automatically. With git + GitHub CLI, it generates full branch/PR/CI workflow plans. Without them, it switches to direct mode (edit-in-place, no branches).

## Plan File Structure

Every plan is saved to `plans/` with this structure:

```markdown
# Plan: [Objective]
Generated: [date] | Steps: [N] | Parallel groups: [M]

## Dependency Graph
step-1 → step-2 → step-4
step-1 → step-3 → step-4
(step-2 and step-3 can run in parallel)

## Step 1: [Title]
### Context Brief
[Everything a fresh agent needs to know to execute this step cold]

### Tasks
- [ ] Task 1
- [ ] Task 2

### Verification
[Commands to run to verify this step is complete]

### Exit Criteria
[What must be true before moving to the next step]

### Rollback
[How to undo this step if needed]
```

## Key Features

- **Cold-start execution** — Every step includes a self-contained context brief. No prior context needed.
- **Adversarial review gate** — Every plan is reviewed against a checklist covering completeness, dependency correctness, and anti-pattern detection.
- **Branch/PR/CI workflow** — Built into every step. Degrades gracefully to direct mode when git/gh is absent.
- **Parallel step detection** — Dependency graph identifies steps with no shared files or output dependencies.
- **Plan mutation protocol** — Steps can be split, inserted, skipped, reordered, or abandoned with formal protocols and audit trail.

## Anti-Pattern Catalog

Plans are checked against these common mistakes:

1. **Monolith step** — A step that touches 10+ files or takes >2 hours. Split it.
2. **Missing verification** — A step with no way to confirm it worked. Add tests or commands.
3. **Implicit dependency** — Step 3 needs Step 2's output but the graph doesn't show it. Make it explicit.
4. **Context assumption** — A step assumes knowledge from a previous step without including it in the context brief. Copy the relevant context.
5. **No rollback** — A destructive step (migration, data change) with no undo plan. Add one.
6. **Premature optimization** — Optimizing before the feature works. Defer to a later step.

## Plan Mutation Protocol

During execution, plans can be modified:

- **Split**: Break one step into two or more smaller steps
- **Insert**: Add a new step between existing steps
- **Skip**: Mark a step as unnecessary (with justification)
- **Reorder**: Change execution order (must respect dependency graph)
- **Abandon**: Cancel remaining steps (with reason and cleanup)

All mutations are logged with timestamp and reason.

## Examples

### Basic usage
```
"Build a user authentication system"
```
Produces a plan with steps like:
- Step 1: Database schema for users and sessions
- Step 2: Auth API endpoints (register, login, logout)
- Step 3: Frontend auth components (login form, signup form)
- Step 4: Protected route middleware
- Step 5: Integration tests

### Multi-agent project
```
"Extract LLM providers into a plugin system"
```
Produces a plan with parallel steps where possible (e.g., "implement Anthropic plugin" and "implement OpenAI plugin" run in parallel after the plugin interface step is done).

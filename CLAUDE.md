# Cross-Review MCP Broker

MCP server enabling two Claude Code instances to review each other's projects through structured artifact exchange. Design informed by QSG scaling laws (Tanaka, arXiv:2603.24676) and EvoSkills co-evolutionary verification (Zhang et al., arXiv:2604.01687).

## Quick Start

```bash
# Step 1: Start the broker (keep running)
npm start

# Step 2: In each Claude Code instance, add the MCP server
claude mcp add cross-review --transport http http://localhost:3749/mcp
```

## Architecture

Single-process HTTP server with in-memory state. Two Claude Code instances connect via Streamable HTTP transport to a shared broker process. The broker provides:

- **Task queues**: per-agent message buffers (send_task / poll_tasks)
- **Phase signaling**: lifecycle coordination with blocking wait (signal_phase / wait_for_phase)
- **Bandwidth enforcement**: review bundles must contain ≥ 5 findings (QSG constraint, Γ_h ≈ 1.67)
- **Skill evolution**: agents exchange multi-file skill packages and co-evolve them via surrogate verification (EvoSkills)

## QSG Theory (Tanaka, 2026)

The drift-selection parameter Γ_h = mN·h/α determines whether multi-agent agreement reflects genuine insights (selection, |Γ_h| ≫ 1) or random consensus (drift, |Γ_h| ≪ 1).

- **m** = communication bandwidth (findings per exchange)
- **N** = agent count (2 for cross-review)
- **α** = adaptation rate (how eagerly an agent updates from peer input)
- **h** = systematic bias (domain expertise)

With N=2 and m ≥ 5, the system stays safely in the selection regime (Γ_h ≈ 1.67).

## EvoSkills Theory (Zhang et al., 2026)

EvoSkills enables agents to autonomously construct and refine multi-file skill packages through co-evolutionary verification. The two-agent cross-review topology maps naturally onto this:

- **Skill Generator**: One agent creates a skill package (≥ 2 artifacts) and sends it to the peer
- **Surrogate Verifier**: The peer synthesizes test cases and returns a verification score + feedback
- **Co-evolution**: The generator refines the skill using feedback, up to 5 rounds
- **Convergence**: When consecutive scores stabilize (Δ < 0.05), the skill is considered converged
- **Cross-model transfer**: Evolved skills transfer effectively across different LLMs (35–45pp gains)

Task types: `skill_bundle` (generator → verifier) and `skill_verification` (verifier → generator).

## CLI Orchestrator

Headless conversation driver using tmux + WezTerm. Launches Claude Code instances with heart-pulsed continuous review cycles.

### Modes

| Mode | Agents | Topology |
|------|--------|----------|
| `monologue` | 1 | Self-review loop |
| `dialogue` | 2 | Cross-review pair (standard QSG) |
| `trialogue` | 3 | Ring review (A→B→C→A) |
| `conference` | N | Round-robin ring mesh |

### Usage

```bash
# Single self-review
npm run monologue -- ./my-project

# Standard cross-review pair
npm run dialogue -- ./project-a ./project-b

# Three-way ring review
npm run trialogue -- ./proj-a ./proj-b ./proj-c

# N-way conference
npm run conference -- ./p1 ./p2 ./p3 ./p4

# With options
tsx src/cli.ts dialogue ./proj-a ./proj-b --pulse 60 --rounds 5 --headless
```

### Options

- `--port <n>` — Broker port (default: 3749)
- `--pulse <secs>` — Heartbeat interval (default: 45s)
- `--rounds <n>` — Review rounds, 0=infinite (default: 0)
- `--headless` — WezTerm headless mode (no GUI)
- `--tui` — Enable viridis TUI dashboard (full-screen alternate buffer)
- `--session <name>` — tmux session name
- `--prompt <text>` — Custom prompt for all agents

### TUI Dashboard

`--tui` activates a full-screen terminal interface using the viridis color scheme (indigo → teal → green → yellow). Displays:
- Agent phase progression with viridis gradient bars
- Ring topology visualization with phase-colored nodes
- Heartbeat sparkline (idle activity over time)
- Live tmux pane preview for selected agent (j/k to navigate, tab to cycle)
- Scrolling event log with color-coded levels
- Broker health and session metadata

### Heart Pulse

The orchestrator monitors each agent's tmux pane for activity. Idle agents receive escalating nudges: light (continue), medium (check status), strong (full mission reminder). The pulse also monitors broker health and detects completion.

### Prerequisites

- `tmux` — session/pane management (required)
- `claude` — Claude Code CLI (required)
- `wezterm` — terminal host (optional, enhances headless mode)

**Security note**: The orchestrator runs Claude Code with `--dangerously-skip-permissions`, granting agents unrestricted filesystem and shell access to the specified project directories. A 5-second warning is displayed before launch.

## Commands

```bash
npm start       # Start broker on port 3749 (or CROSS_REVIEW_PORT)
npm run dev     # Start with file watching
npm test        # Run test suite
npm run cli     # Run CLI orchestrator (pass args after --)
```

## MemPalace Integration

In-memory artifact cache for cross-review artifacts, organized in [MemPalace](https://github.com/mila-jovovich/mempalace)-style hierarchy. Agents can store and search briefings, findings, responses, and synthesis results within a session. Data is **in-memory only** — lost on broker restart. External MemPalace server integration is planned for a future release.

Artifacts are organized as: Wing (`cross-review`) → Room (project name) → Drawer (artifact), using AAAK-style compressed formatting.

### Tools

- `mempalace_configure` — Initialize the in-memory artifact cache with URL, palace path, and wing name
- `mempalace_store` — Store a cross-review artifact (briefing/finding/response/synthesis)
- `mempalace_search` — Search stored artifacts by query, kind, or project
- `mempalace_status` — View integration status and entry counts

### Usage

```bash
# Configure via MCP tool call:
#   mempalace_configure({ url: "http://localhost:5173/mcp" })
# Note: URL is stored for future external integration but not currently used.
```

## Files

### Source

- `src/server.ts` — HTTP server, per-session McpServer factory, transport wiring
- `src/broker.ts` — Pure handler functions (extracted for testability)
- `src/mempalace.ts` — MemPalace integration handlers (configure, store, search, status)
- `src/schemas.ts` — Zod payload validation schemas and `validatePayload()` helper
- `src/types.ts` — TypeScript type definitions, QSG constants, MemPalace types, `createFreshState()`
- `src/cli.ts` — CLI orchestrator (tmux/WezTerm, heart pulse, mode dispatch)
- `src/tui.ts` — Viridis TUI dashboard (alternate screen, ANSI rendering)
- `src/test-helpers.ts` — Shared test utilities (state factories, fixture builders)

### Tests

- `src/registration.test.ts` — Agent register/deregister
- `src/deregister.test.ts` — Deregistration edge cases
- `src/send-task.test.ts` — Task sending, bandwidth enforcement, payload validation
- `src/signal-phase.test.ts` — Phase lifecycle and preconditions
- `src/transport.test.ts` — HTTP transport and session management
- `src/long-poll.test.ts` — Long-poll task delivery
- `src/multi-round.test.ts` — Round reset and task archival
- `src/evoskills.test.ts` — Skill evolution, convergence detection
- `src/mempalace.test.ts` — MemPalace in-memory cache
- `src/synthesis.test.ts` — Synthesis phase
- `src/history.test.ts` — Task history retrieval
- `src/finding-tracker.test.ts` — Finding lifecycle tracking
- `src/generate-synthesis.test.ts` — Structured synthesis generation
- `src/cli.test.ts` — CLI orchestrator
- `src/tui.test.ts` — TUI dashboard

### Docs

- `docs/usage-guide.md` — Step-by-step usage guide for agents
- `docs/protocol-reference.md` — Complete tool and protocol reference
- `docs/e2e-session.md` — End-to-end session runbook (CLI orchestrator + manual)

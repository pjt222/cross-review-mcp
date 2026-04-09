# End-to-End Cross-Review Session

How to run a real cross-review between two Claude Code instances.

## Prerequisites

```bash
cd /mnt/d/dev/p/cross-review-mcp
npm install
npm test          # all 168 tests must pass
which tmux        # required
which claude      # required
```

## Option A: CLI Orchestrator (Recommended)

The orchestrator handles broker startup, tmux session management, MCP registration, prompt injection, and idle-agent nudging automatically.

### 1. Pick two projects

Any two local repos work. They should have enough code for meaningful review (>500 LOC). Example pairs from this workspace:

| Project A | Project B | Why |
|-----------|-----------|-----|
| `ez-ar2diff` | `jigsawR` | TypeScript vs R, different domains |
| `agent-almanac` | `cross-review-mcp` | Meta: review the reviewer |
| `cardcertr` | `chainmaille` | Both domain-specific |

### 2. Launch

```bash
# Standard cross-review with TUI dashboard
npm run dialogue -- /mnt/d/dev/p/ez-ar2diff /mnt/d/dev/p/jigsawR --tui --rounds 1

# Same, with custom pulse interval and prompt
npm run dialogue -- /mnt/d/dev/p/ez-ar2diff /mnt/d/dev/p/jigsawR \
  --tui --rounds 1 --pulse 60 \
  --prompt "Focus on error handling and test coverage gaps"
```

A 5-second safety warning is displayed (agents run with `--dangerously-skip-permissions`). Press Ctrl+C to abort.

### 3. Monitor

With `--tui`: the viridis dashboard shows phase progression, heartbeat, and live pane content.

Without `--tui`: attach to the tmux session:

```bash
tmux attach -t xrev-<id>

# Navigate windows:
#   Ctrl+b n  — next window (broker → agent-A → agent-B → monitor)
#   Ctrl+b p  — previous window
#   Ctrl+b w  — window list
```

### 4. Expected timeline (~5-15 min per round)

| Phase | What happens |
|-------|-------------|
| 0:00 | Broker starts, agents register |
| 0:30 | Both agents read their own projects, produce briefings |
| 1:00 | Briefings exchanged, agents read peer code |
| 3:00 | Review bundles sent (each agent: >= 5 findings) |
| 5:00 | Agents respond to findings with accept/reject/discuss |
| 7:00 | Synthesis produced |
| 8:00 | Both signal "complete" |

The orchestrator's heart pulse detects stalled agents and nudges them forward.

### 5. Teardown

```bash
# Kill the tmux session
tmux kill-session -t xrev-<id>
```

### 6. Review results

Telemetry is written to `cross-review.jsonl`:

```bash
# Summary of events
cat cross-review.jsonl | jq -r '.event' | sort | uniq -c | sort -rn

# Review bundles and finding counts
cat cross-review.jsonl | jq 'select(.event == "review_bundle") | {from, to, findingCount, categories}'

# Verdicts
cat cross-review.jsonl | jq 'select(.event == "verdict") | {from, findingId, verdict}'

# Phase changes
cat cross-review.jsonl | jq 'select(.event == "phase_change") | {agentId, from, to}'
```

---

## Option B: Manual (Two Terminals)

For more control or debugging, run each step by hand.

### 1. Start the broker

```bash
# Terminal 0
cd /mnt/d/dev/p/cross-review-mcp
npm start
# Output: cross-review-mcp broker listening on http://localhost:3749/mcp
```

### 2. Start Claude Code instance A

```bash
# Terminal 1
cd /mnt/d/dev/p/ez-ar2diff
claude mcp add cross-review --transport http http://localhost:3749/mcp
claude
```

Once in the Claude Code session, paste this prompt:

> You are agent-A, reviewing agent-B's project. The cross-review MCP broker is connected. Your workflow:
> 1. Call `register` with agentId="agent-a", project="ez-ar2diff", capabilities=["review","typescript"]
> 2. Analyze your own project, then call `send_task` with type="briefing" to agent-b
> 3. Call `signal_phase` with phase="briefing"
> 4. Call `wait_for_phase` with peerId="agent-b", phase="briefing"
> 5. Call `poll_tasks` (with timeout=30000) to get agent-b's briefing
> 6. Call `ack_tasks` to acknowledge received tasks
> 7. Read agent-b's actual code, then produce >= 5 review findings
> 8. Call `send_task` with type="review_bundle", then `signal_phase` "review"
> 9. Wait for and respond to findings about YOUR project with accept/reject/discuss
> 10. Call `signal_phase` "dialogue", then produce synthesis, signal "synthesis", then "complete"

### 3. Start Claude Code instance B

```bash
# Terminal 2
cd /mnt/d/dev/p/jigsawR
claude mcp add cross-review --transport http http://localhost:3749/mcp
claude
```

Same prompt structure, but with agentId="agent-b" and reversed review direction.

### 4. Monitor via broker

```bash
# Terminal 0 (or new terminal)
curl -s http://localhost:3749/health | jq
# {"status":"ok","agents":2}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Not found" on MCP tool calls | MCP not registered | Re-run `claude mcp add cross-review --transport http http://localhost:3749/mcp` |
| Agent stuck waiting | Peer hasn't reached phase | Check `get_status`; nudge the lagging agent |
| "must contain at least 5 findings" | QSG bandwidth enforcement | Agent must produce >= 5 findings per review bundle |
| Broker unreachable | Process died | Check Terminal 0; restart with `npm start` |
| Agents can't see each other | Different broker instances | Both must connect to the same port |
| `claude mcp add` fails | CLI version too old | Update: `claude update` |

## What to Look For

A successful session produces:
- **JSONL telemetry** (`cross-review.jsonl`) with register, phase_change, review_bundle, verdict, and shutdown events
- **Findings** crossing domain boundaries (e.g., TypeScript patterns applied to R code or vice versa)
- **Accept/reject balance**: if all findings are accepted, the reviews may be too shallow; if all rejected, the agents aren't reading code carefully
- **QSG validation**: every review_bundle in the JSONL should have `findingCount >= 5`

---

## First E2E Session — Findings (2026-04-09)

Ran `dialogue` mode with `ez-ar2diff` (TypeScript) and `jigsawR` (R package). Key observations:

### Timing

| Phase | Wall clock |
|-------|-----------|
| Broker start → both registered | ~2 min |
| Briefing exchange | ~4 min |
| Review (reading peer code + producing findings) | ~8 min |
| Dialogue (verdict exchange + discussion) | ~6 min |
| Synthesis + complete | ~4 min |
| **Total** | **~28 min** |

Claude Code `-p` (non-interactive prompt mode) needs time to initialize MCP connections. Allow 2+ minutes before expecting registration events.

### Protocol Behavior

- **45 JSONL events** total (startup, 3 registers, 12 phase changes, 2 review bundles, 15 verdicts, 11 acks, 1 deregister)
- Agent-A produced **7 findings** about jigsawR; Agent-B produced **6 findings** about ez-ar2diff
- Verdict distribution: **~86% accept**, **~7% discuss** (resolved to accept in second exchange), **~7% reject**
- Both `discuss` findings were re-evaluated and accepted after clarification — the dialogue phase works
- Agent-B deregistered and re-registered mid-session once (likely hit a tool error and recovered)

### Bugs Found and Fixed

1. **Phase detection false positive** (`detectPhase()` in `cli.ts`): the function matched `"complete"` in the agent's system prompt, causing the orchestrator to prematurely declare the session done after the first heartbeat. Fixed to match only broker JSON responses (`"phaseUpdated":true`).

2. **`--rounds` semantics**: `--rounds 1` means 1 heartbeat pulse (60s), not 1 review round. A full review cycle takes ~28 minutes. Use `--rounds 0` (unlimited) and let the orchestrator detect natural completion, or `--rounds 30` for a 30-minute cap.

3. **tmux pane capture vs Claude Code output**: `claude -p` uses rich terminal rendering that doesn't appear in `tmux capture-pane`. The orchestrator's idle detection (hash-based) and phase detection work but only see raw text, not the full Claude output. Monitor progress via JSONL telemetry instead.

### Recommendations

- Use `--rounds 0 --pulse 60` for real sessions. The natural completion detection (both agents at "complete") works correctly after the phase detection fix.
- Monitor via `cross-review.jsonl` rather than tmux pane content — the JSONL is the authoritative record.
- Archive `cross-review.jsonl` between sessions (it's append-only).
- The review phase is the bottleneck (~8 min) — agents read multiple source files to produce findings.

# CONTINUE_HERE — Cross-Review MCP Broker

**Written**: 2026-04-01
**By**: Claude Opus 4.6 session `nested-floating-squid`
**Repo**: https://github.com/pjt222/cross-review-mcp

## What Happened

A 42-agent unleash-the-agents analysis was conducted on the cross-review-mcp broker. 11 hypothesis families were identified, 7 were resolved in the same session. The full report is at `UNLEASH_REPORT.md`.

## What Was Done (Issues #1-#7 — all CLOSED)

1. **MIN_BANDWIDTH** raised from 3 to 5 (Γ_h: 1.0 → 1.67)
2. **JSONL telemetry** added for verdicts, bundles, phases (configurable via `CROSS_REVIEW_LOG` env var)
3. **Phase precondition gates** — briefing required before review, review_bundle before dialogue, quorum ≥ 2
4. **Peek-then-ack** delivery replacing destructive drain (new `ack_tasks` tool)
5. **Explicit sender identity** via `from` parameter (self-send rejected)
6. **Non-empty response enforcement** in dialogue phase
7. **Waiter leak fix**, markdown protocol resource, graceful SIGTERM/SIGINT shutdown

## What Remains Open (Issues #8-#11)

### #8 [HIGH] Add test suite
Zero tests exist. Every fix was verified only by `tsc --noEmit`. Priority: phase precondition gates (highest regression risk), then ack_tasks persistence, then sender validation negative cases. Suggest vitest or node:test.

### #9 [HIGH] Migrate stdio → SSE/HTTP transport
The foundational limitation: stdio spawns separate processes per connection, so two Claude Code instances can't share in-memory state. `@hono/node-server` is already a transitive dep. MCP SDK has `SSEServerTransport`. This should happen after #8 (tests first).

### #10 [MEDIUM] Session lifecycle
Completed agents are never removed. Re-registration fails. Need `deregister` tool or auto-cleanup TTL. Relatively straightforward once #8 gives test coverage.

### #11 [MEDIUM] Integration/synthesis phase
No shared artifact produced after dialogue. The 42-agent analysis identified this as "the missing ritual closing." Add a `synthesis` phase between `dialogue` and `complete` where both agents co-produce a shared summary. Consider making `sourceAnalog` required in Finding schema.

## Key Architectural Context

- **QSG theory**: Γ_h = mN·h/α with h/α = 1/6 = 1/|FindingCategory|. Adding categories requires recalibrating MIN_BANDWIDTH. Parameters h≈0.05 and α≈0.3 are assumed, not measured — JSONL logging (#2) enables future empirical estimation.
- **Epistemic independence gap**: Same-model agents share training biases. Temporal ordering ≠ epistemic independence. Cannot be fixed by bandwidth alone — needs model diversity (N>2 with different model families).
- **Terminology inflation** (Family #11): The vocabulary (verdict, selection, drift, bandwidth) systematically overstates epistemic authority. The QSG citation functions as authority-borrowing. Be honest about what the system can and cannot guarantee.

## Files to Know

| File | Purpose |
|------|---------|
| `src/server.ts` | MCP server — 7 tools + 1 resource (~540 lines) |
| `src/types.ts` | Type definitions + QSG constant (~130 lines) |
| `UNLEASH_REPORT.md` | Full 42-agent analysis with 11 hypothesis families |
| `CLAUDE.md` | Project instructions for Claude Code |
| `cross-review.jsonl` | Telemetry output (created at runtime) |

## Suggested Next Session

Start with #8 (test suite). The precondition gates in `signal_phase` are the highest-risk untested code — write those tests first. Then #9 (transport) is the big architectural lift but should not be attempted without test coverage.

## Memory Files

Located at `/home/phtho/.claude/projects/-mnt-d-dev-p-cross-review-mcp/memory/`:
- `MEMORY.md` — index
- `project_qsg_theory.md` — QSG limitations and parameter coupling
- `project_status.md` — completed and remaining work
- `feedback_stuck_agents.md` — lesson about recovering stuck agents

# Cross-Review MCP Broker

MCP server enabling two Claude Code instances to review each other's projects through structured artifact exchange. Design informed by QSG scaling laws (Tanaka, arXiv:2603.24676).

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

## QSG Theory (Tanaka, 2026)

The drift-selection parameter Γ_h = mN·h/α determines whether multi-agent agreement reflects genuine insights (selection, |Γ_h| ≫ 1) or random consensus (drift, |Γ_h| ≪ 1).

- **m** = communication bandwidth (findings per exchange)
- **N** = agent count (2 for cross-review)
- **α** = adaptation rate (how eagerly an agent updates from peer input)
- **h** = systematic bias (domain expertise)

With N=2 and m ≥ 5, the system stays safely in the selection regime (Γ_h ≈ 1.67).

## Commands

```bash
npm start       # Start broker on port 3749 (or CROSS_REVIEW_PORT)
npm run dev     # Start with file watching
npm test        # Run test suite
```

## Files

- `src/server.ts` — HTTP server, per-session McpServer factory, transport wiring
- `src/broker.ts` — Pure handler functions (extracted for testability)
- `src/types.ts` — TypeScript type definitions and QSG constants

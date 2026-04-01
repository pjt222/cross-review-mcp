# Cross-Review MCP Broker

MCP server enabling two Claude Code instances to review each other's projects through structured artifact exchange. Design informed by QSG scaling laws (Tanaka, arXiv:2603.24676).

## Quick Start

```bash
# Start the broker
npm start

# Add to Claude Code (both instances)
claude mcp add cross-review -- npx tsx /mnt/d/dev/p/cross-review-mcp/src/server.ts
```

## Architecture

Single-process MCP server with in-memory state. Two Claude Code instances connect via stdio transport. The broker provides:

- **Task queues**: per-agent message buffers (send_task / poll_tasks)
- **Phase signaling**: lifecycle coordination with blocking wait (signal_phase / wait_for_phase)
- **Bandwidth enforcement**: review bundles must contain ≥ 3 findings (QSG constraint)

## QSG Theory (Tanaka, 2026)

The drift-selection parameter Γ_h = mN·h/α determines whether multi-agent agreement reflects genuine insights (selection, |Γ_h| ≫ 1) or random consensus (drift, |Γ_h| ≪ 1).

- **m** = communication bandwidth (findings per exchange)
- **N** = agent count (2 for cross-review)
- **α** = adaptation rate (how eagerly an agent updates from peer input)
- **h** = systematic bias (domain expertise)

With N=2 and m ≥ 3, the system stays in the selection regime.

## Commands

```bash
npm start       # Start broker via tsx
npm run dev     # Start with file watching
```

## Files

- `src/server.ts` — MCP server with tools and protocol resource
- `src/types.ts` — TypeScript type definitions and QSG constants

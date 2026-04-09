# Cross-Review MCP Usage Guide

## Prerequisites

- Node.js 18+
- Two Claude Code instances with MCP support
- `npm install` in the cross-review-mcp directory

## Quick Start

```bash
# Terminal 1: Start the broker
npm start

# Terminal 2: Claude Code instance A
claude mcp add cross-review --transport http http://localhost:3749/mcp

# Terminal 3: Claude Code instance B
claude mcp add cross-review --transport http http://localhost:3749/mcp
```

## End-to-End Session Walkthrough

### 1. Registration

Both agents register with their project info:

```json
// Agent A calls: register
{ "agentId": "agent-a", "project": "/path/to/project-a", "capabilities": ["review", "typescript"] }

// Agent B calls: register
{ "agentId": "agent-b", "project": "/path/to/project-b", "capabilities": ["review", "python"] }
```

### 2. Briefing Exchange

Each agent reads their own codebase and sends a structured briefing to their peer:

```json
// Agent A calls: send_task
{
  "from": "agent-a",
  "to": "agent-b",
  "type": "briefing",
  "payload": "{\"project\":\"project-a\",\"language\":\"typescript\",\"entryPoints\":[\"src/server.ts\"],\"patterns\":[{\"name\":\"handler pattern\",\"files\":[\"src/broker.ts\"],\"description\":\"Pure functions parameterized by state\"}],\"testCoverage\":{\"hasTests\":true,\"framework\":\"vitest\",\"count\":134}}"
}
```

Both agents signal the briefing phase:

```json
// Agent A calls: signal_phase
{ "agentId": "agent-a", "phase": "briefing" }
```

### 3. Wait for Peer

Each agent waits for their peer to reach the briefing phase:

```json
// Agent A calls: wait_for_phase
{ "peerId": "agent-b", "phase": "briefing" }
```

Use long-polling to efficiently wait for tasks:

```json
// Agent B calls: poll_tasks (long-poll)
{ "agentId": "agent-b", "timeout": 30000 }
```

### 4. Review Bundle

After reading the peer's briefing and actual code, send findings (minimum 5 per QSG constraint):

```json
// Agent A calls: send_task
{
  "from": "agent-a",
  "to": "agent-b",
  "type": "review_bundle",
  "payload": "[{\"id\":\"f1\",\"category\":\"bug_risk\",\"targetFile\":\"src/main.py\",\"description\":\"Uncaught exception in error handler\",\"evidence\":\"Line 42: bare except clause\"},{\"id\":\"f2\",\"category\":\"missing_practice\",\"targetFile\":\"src/main.py\",\"description\":\"No input validation\",\"evidence\":\"User input passed directly to query\"}, ...]"
}
```

Both flat arrays and wrapper objects are accepted:

```json
// Also valid:
{ "payload": "{\"findings\": [...]}" }
```

Signal the review phase after sending:

```json
{ "agentId": "agent-a", "phase": "review" }
```

### 5. Dialogue — Respond to Findings

Each agent reads the findings about their own project and responds:

```json
// Agent B calls: send_task
{
  "from": "agent-b",
  "to": "agent-a",
  "type": "response",
  "payload": "[{\"findingId\":\"f1\",\"verdict\":\"accept\",\"evidence\":\"Good catch, will add proper error handling\"},{\"findingId\":\"f2\",\"verdict\":\"reject\",\"evidence\":\"Input is validated upstream in middleware\",\"counterEvidence\":\"See src/middleware.py line 15\"}]"
}
```

Verdicts: `accept`, `reject`, or `discuss`.

### 6. Synthesis

Each agent produces a synthesis of what they learned:

```json
// Agent A calls: send_task
{
  "from": "agent-a",
  "to": "agent-b",
  "type": "synthesis",
  "payload": "{\"agentId\":\"agent-a\",\"project\":\"project-a\",\"accepted\":[{\"findingId\":\"f3\",\"action\":\"Will add type hints to all public functions\"}],\"rejected\":[{\"findingId\":\"f4\",\"reason\":\"Already handled by CI linter\"}]}"
}
```

### 7. Complete

```json
{ "agentId": "agent-a", "phase": "complete" }
```

### 8. Multi-Round (Optional)

To review a different topic or do a second pass:

```json
// Agent A calls: reset_round
{ "agentId": "agent-a" }
// Returns: { "roundReset": true, "previousRound": 0, "newRound": 1 }
```

The agent is now back at "registered" phase and can go through the full lifecycle again.

## Long-Polling

Instead of polling every N seconds, use the `timeout` parameter:

```json
// Blocks up to 30s, returns immediately when tasks arrive
{ "agentId": "agent-a", "timeout": 30000 }
```

This eliminates empty poll cycles that waste context window space.

## Common Pitfalls

| Pitfall | Error | Fix |
|---------|-------|-----|
| Review bundle with < 5 findings | "must contain at least 5 findings" | Add more findings (QSG constraint) |
| Signaling review without sending briefing | "Cannot enter review phase without sending a briefing" | Call `send_task` with type "briefing" first |
| Signaling dialogue without review bundle | "Cannot enter dialogue phase without sending a review bundle" | Send the review_bundle first |
| Resetting round from non-complete phase | "Can only reset round from complete phase" | Signal "complete" first |
| Sending task to yourself | "Cannot send tasks to yourself" | Use peer's agentId in the "to" field |
| Only 1 agent registered | "Cannot advance phase with fewer than 2 registered agents" | Both agents must register before phase advancement |
| Payload as object instead of JSON string | "Invalid JSON payload" | Use `JSON.stringify()` for the payload parameter |

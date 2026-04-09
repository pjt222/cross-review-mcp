# Cross-Review Protocol Reference v1.0.0

## Overview

The cross-review protocol enables two Claude Code instances to review each other's projects through structured artifact exchange. The broker enforces a 6-phase lifecycle, QSG bandwidth constraints, and multi-round support.

## Phase Lifecycle

```
registered ──(send briefing)──> briefing ──(send review_bundle)──> review
                                                                      │
                                                            (send response)
                                                                      ▼
                                                                  dialogue
                                                                      │
                                                            (send response)
                                                                      ▼
                                                                 synthesis
                                                                      │
                                                                      ▼
                                                                  complete
                                                                      │
                                                            (reset_round)
                                                                      ▼
                                                            registered (round+1)
```

### Phase Preconditions

| Phase | Precondition |
|-------|-------------|
| briefing | None (starting phase) |
| review | Must have sent a `briefing` task |
| dialogue | Must have sent a `review_bundle` task |
| synthesis | Must have sent a `response` task |
| complete | No task precondition (terminal signal) |

### Constraints

- Phases only advance forward (no backward movement)
- Minimum 2 registered agents required for non-complete phases
- `complete` can be signaled with < 2 agents (after peer deregisters)

## Task Types

### briefing

Structured description of an agent's own project.

```json
{
  "project": "my-project",
  "language": "typescript",
  "entryPoints": ["src/server.ts"],
  "dependencyGraph": { "server.ts": ["broker.ts", "types.ts"] },
  "patterns": [{ "name": "handler", "files": ["src/broker.ts"], "description": "Pure functions" }],
  "knownIssues": [{ "severity": "medium", "description": "No input validation" }],
  "testCoverage": { "hasTests": true, "framework": "vitest", "count": 134 }
}
```

### review_bundle

Array of findings about the peer's project. **Minimum 5 findings** (QSG bandwidth constraint: Γ_h ≈ 1.67).

```json
[
  {
    "id": "f1",
    "category": "bug_risk",
    "targetFile": "src/main.py",
    "targetLines": [42, 45],
    "description": "Uncaught exception in error handler",
    "evidence": "Bare except clause on line 42",
    "suggestion": "Use specific exception types",
    "sourceAnalog": "src/broker.ts:114 — our error handling pattern"
  }
]
```

Also accepts `{ "findings": [...] }` wrapper format.

**Finding Categories**: `pattern_transfer`, `missing_practice`, `inconsistency`, `simplification`, `bug_risk`, `documentation_gap`

### response

Array of verdicts on received findings. Minimum 1 response.

```json
[
  {
    "findingId": "f1",
    "verdict": "accept",
    "evidence": "Good catch, will fix",
    "counterEvidence": null
  },
  {
    "findingId": "f2",
    "verdict": "reject",
    "evidence": "Already handled",
    "counterEvidence": "See middleware.py:15"
  }
]
```

Also accepts `{ "responses": [...] }` wrapper format.

**Verdicts**: `accept` (will act on it), `reject` (incorrect/inapplicable), `discuss` (needs clarification)

### synthesis

Summary of accepted and rejected findings for an agent's own project.

```json
{
  "agentId": "agent-a",
  "project": "project-a",
  "accepted": [{ "findingId": "f1", "action": "Add proper error handling" }],
  "rejected": [{ "findingId": "f2", "reason": "Handled by upstream middleware" }]
}
```

### question

Focused clarification request during dialogue.

```json
{
  "id": "q1",
  "aboutFile": "src/server.ts",
  "question": "Why is this handler async?",
  "context": "Line 42 appears to have no await"
}
```

### skill_bundle (EvoSkills)

Multi-file skill package for co-evolutionary refinement. Minimum 2 artifacts, max 5 evolution rounds.

```json
{
  "skillId": "skill-001",
  "name": "TypeScript Error Handler",
  "description": "Pattern for structured error handling",
  "artifacts": [
    { "filename": "index.ts", "content": "...", "role": "entry" },
    { "filename": "types.ts", "content": "...", "role": "helper" }
  ],
  "evolutionRound": 0
}
```

### skill_verification (EvoSkills)

Verification response from the surrogate verifier. Score 0.0-1.0.

```json
{
  "skillId": "skill-001",
  "pass": true,
  "score": 0.85,
  "feedback": "Skill handles basic cases well, needs edge case coverage",
  "testCases": [
    { "input": "null input", "expectedBehavior": "throws TypeError", "passed": true }
  ]
}
```

## QSG Theory (Tanaka, 2026)

The drift-selection parameter:

**Γ_h = mN·h/α**

| Variable | Meaning | Value |
|----------|---------|-------|
| m | Communication bandwidth (findings per bundle) | ≥ 5 |
| N | Agent count | 2 |
| h | Systematic bias (domain expertise) | ≈ 0.05 |
| α | Adaptation rate | ≈ 0.3 |

With m=5, N=2: **Γ_h ≈ 1.67** (selection regime — genuine insights amplified).

## MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `register` | agentId, project, capabilities | Register agent with broker |
| `send_task` | from, to, type, payload | Send task to peer agent |
| `poll_tasks` | agentId, timeout? | Retrieve pending tasks (optional long-poll) |
| `ack_tasks` | agentId, taskIds[] | Acknowledge processed tasks |
| `signal_phase` | agentId, phase | Signal phase advancement |
| `wait_for_phase` | peerId, phase | Block until peer reaches phase |
| `get_status` | — | Get broker state overview |
| `get_skill_status` | agentId | Get EvoSkills evolution state |
| `reset_round` | agentId | Reset for new review round (from complete) |
| `deregister` | agentId | Remove agent from broker |
| `mempalace_configure` | url, palacePath?, wing? | Configure artifact cache |
| `mempalace_store` | agentId, kind, payload | Store artifact |
| `mempalace_search` | query, kind?, project?, limit? | Search artifacts |
| `mempalace_status` | — | Get cache status |

## Telemetry

Events are logged to `cross-review.jsonl` (configurable via `CROSS_REVIEW_LOG`):

- `register`, `deregister` — agent lifecycle
- `review_bundle` — finding exchange with category breakdown
- `verdict` — individual finding verdicts
- `skill_bundle`, `skill_verification` — EvoSkills exchanges
- `phase_change` — phase transitions
- `reset_round` — round resets
- `ack_tasks` — task acknowledgments

#!/usr/bin/env node
/**
 * Cross-Review MCP Broker
 *
 * An MCP server that enables two Claude Code instances to review each other's
 * projects through structured artifact exchange. Design informed by QSG scaling
 * laws (Tanaka, arXiv:2603.24676):
 *
 *   Γ_h = mN·h/α  — drift-selection parameter
 *
 * High bandwidth (m ≥ 3 findings per bundle) pushes the system into the
 * selection regime where genuine insights dominate over random drift.
 */

import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type BrokerState,
  type FindingResponse,
  MIN_BANDWIDTH,
} from "./types.js";
import {
  handleRegister,
  handleSendTask,
  handlePollTasks,
  handleAckTasks,
  handleSignalPhase,
  handleWaitForPhase,
  handleGetStatus,
} from "./broker.js";

// --- Telemetry (append-only JSONL) ---

const LOG_PATH = process.env.CROSS_REVIEW_LOG ?? "./cross-review.jsonl";

function logEvent(event: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ...event, timestamp: Date.now() }) + "\n");
  } catch {
    // Logging failure must never break the broker
  }
}

// --- Broker state (in-memory, single process) ---

const state: BrokerState = {
  agents: new Map(),
  phases: new Map(),
  taskQueues: new Map(),
  phaseWaiters: new Map(),
  sentTaskTypes: new Map(),
};

// --- MCP Server ---

const server = new McpServer({
  name: "cross-review-mcp",
  version: "1.0.0",
});

// --- Tool: register ---

server.tool(
  "register",
  "Register this agent with the broker. Call once at session start.",
  {
    agentId: z.string().describe("Unique agent identifier (e.g., 'ez-ar2diff')"),
    project: z.string().describe("Project name this agent represents"),
    capabilities: z.array(z.string()).describe("List of capabilities (e.g., ['review', 'suggest'])"),
  },
  async (args) => {
    const result = handleRegister(state, args);
    logEvent({ event: "register", agentId: args.agentId, project: args.project });
    return result;
  }
);

// --- Tool: send_task ---

server.tool(
  "send_task",
  "Send a task (briefing, review bundle, question, or response) to a peer agent. Review bundles must contain at least 5 findings (QSG bandwidth constraint: Γ_h ≈ 1.67).",
  {
    from: z.string().describe("Your agent ID (the sender)"),
    to: z.string().describe("Target agent ID"),
    type: z.enum(["briefing", "review_bundle", "question", "response"]).describe("Task type"),
    payload: z.string().describe("JSON-encoded payload matching the task type schema"),
  },
  async (args) => {
    const result = handleSendTask(state, args);
    const parsed = JSON.parse(result.content[0].text);

    // Log review bundles and verdict responses
    if (!parsed.error) {
      if (args.type === "review_bundle") {
        let parsedPayload: unknown[];
        try { parsedPayload = JSON.parse(args.payload); } catch { parsedPayload = []; }
        if (Array.isArray(parsedPayload)) {
          const categories = parsedPayload.map((f) => (f as Record<string, unknown>).category).filter(Boolean);
          logEvent({ event: "review_bundle", taskId: parsed.taskId, from: args.from, to: args.to, findingCount: parsedPayload.length, categories });
        }
      } else if (args.type === "response") {
        let parsedPayload: FindingResponse[];
        try { parsedPayload = JSON.parse(args.payload); } catch { parsedPayload = []; }
        if (Array.isArray(parsedPayload)) {
          for (const response of parsedPayload) {
            logEvent({ event: "verdict", taskId: parsed.taskId, from: args.from, to: args.to, findingId: response.findingId, verdict: response.verdict });
          }
        }
      }
    }

    return result;
  }
);

// --- Tool: poll_tasks ---

server.tool(
  "poll_tasks",
  "Retrieve pending tasks for this agent. Tasks remain in queue until acknowledged via ack_tasks.",
  {
    agentId: z.string().describe("Your agent ID"),
  },
  async (args) => handlePollTasks(state, args)
);

// --- Tool: ack_tasks ---

server.tool(
  "ack_tasks",
  "Acknowledge and remove processed tasks from your queue. Call after successfully processing tasks from poll_tasks.",
  {
    agentId: z.string().describe("Your agent ID"),
    taskIds: z.array(z.string()).describe("IDs of tasks to acknowledge"),
  },
  async (args) => {
    const result = handleAckTasks(state, args);
    const parsed = JSON.parse(result.content[0].text);
    logEvent({ event: "ack_tasks", agentId: args.agentId, ackedCount: parsed.acknowledged, remainingCount: parsed.remaining });
    return result;
  }
);

// --- Tool: signal_phase ---

server.tool(
  "signal_phase",
  "Signal that this agent has reached a protocol phase. Phases: registered → briefing → review → dialogue → complete.",
  {
    agentId: z.string().describe("Your agent ID"),
    phase: z.enum(["briefing", "review", "dialogue", "complete"]).describe("Phase reached"),
  },
  async (args) => {
    const previousPhase = state.phases.get(args.agentId);
    const result = handleSignalPhase(state, args);
    const parsed = JSON.parse(result.content[0].text);
    if (parsed.phaseUpdated) {
      logEvent({ event: "phase_change", agentId: args.agentId, from: previousPhase, to: args.phase });
    }
    return result;
  }
);

// --- Tool: wait_for_phase ---

server.tool(
  "wait_for_phase",
  "Block until a peer agent reaches a specific phase. Returns immediately if the peer is already at or past that phase.",
  {
    peerId: z.string().describe("The peer agent ID to wait for"),
    phase: z.enum(["registered", "briefing", "review", "dialogue", "complete"]).describe("Phase to wait for"),
  },
  async (args) => handleWaitForPhase(state, args)
);

// --- Tool: get_status ---

server.tool(
  "get_status",
  "Get the current broker state: registered agents, their phases, and pending task counts.",
  {},
  async () => handleGetStatus(state)
);

// --- Protocol resource ---

const PROTOCOL_DOC = `# Cross-Review Protocol v1.0.0

## Theory
Based on Quantized Simplex Gossip (Tanaka, 2026, arXiv:2603.24676).
Central formula: **Γ_h = mN·h/α** where m=findings per bundle, N=agents, h=bias, α=adaptation rate.
- |Γ_h| ≪ 1 → consensus is random (drift regime)
- |Γ_h| ≫ 1 → genuine insights amplified (selection regime)
- Design: m ≥ ${MIN_BANDWIDTH} keeps Γ_h ≈ 1.67 in the selection regime

## Phases (sequential, enforced by broker)
1. **briefing** — Read own codebase, produce structured Briefing artifact, send to peer. Both agents do this in parallel.
2. **review** — Wait for peer briefing (wait_for_phase), read peer's actual code, send Finding[] bundle (m ≥ ${MIN_BANDWIDTH}). Must have sent a briefing first.
3. **dialogue** — Read findings about own project, respond with FindingResponse[] verdicts. Must have sent a review_bundle first.
4. **complete** — All findings processed. Signal completion.

## Finding Categories
pattern_transfer, missing_practice, inconsistency, simplification, bug_risk, documentation_gap

## Verdicts
- **accept** — Finding is valid, will act on it
- **reject** — Finding is incorrect or inapplicable (provide counterEvidence if available)
- **discuss** — Needs clarification, creates a sub-task for focused exchange
`;

server.resource(
  "protocol",
  "cross-review://protocol",
  { mimeType: "text/markdown" },
  async () => ({
    contents: [{
      uri: "cross-review://protocol",
      mimeType: "text/markdown",
      text: PROTOCOL_DOC,
    }],
  })
);

// --- Start server ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cross-review-mcp broker started");

  const shutdown = () => {
    logEvent({ event: "shutdown", agentCount: state.agents.size });
    console.error("cross-review-mcp broker shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

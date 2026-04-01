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
  type Task,
  type FindingResponse,
  type Phase,
  type PhaseWaiter,
  PHASES,
  MIN_BANDWIDTH,
} from "./types.js";

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
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function notifyPhaseWaiters(agentId: string, phase: Phase): void {
  const waiters = state.phaseWaiters.get(agentId) ?? [];
  const remaining: PhaseWaiter[] = [];

  for (const waiter of waiters) {
    const targetIndex = PHASES.indexOf(waiter.targetPhase);
    const currentIndex = PHASES.indexOf(phase);
    if (currentIndex >= targetIndex) {
      waiter.resolve({ reached: true });
    } else {
      remaining.push(waiter);
    }
  }

  state.phaseWaiters.set(agentId, remaining);
}

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
  async ({ agentId, project, capabilities }) => {
    if (state.agents.has(agentId)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Agent already registered", agentId }) }],
      };
    }

    state.agents.set(agentId, {
      agentId,
      project,
      capabilities,
      registeredAt: Date.now(),
    });
    state.phases.set(agentId, "registered");
    state.taskQueues.set(agentId, []);
    state.phaseWaiters.set(agentId, []);
    logEvent({ event: "register", agentId, project });

    const peerCount = state.agents.size;
    const peers = [...state.agents.keys()].filter((id) => id !== agentId);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          registered: true,
          agentId,
          project,
          peerCount,
          peers,
          minBandwidth: MIN_BANDWIDTH,
          protocol: "Cross-review protocol: briefing → review → dialogue → complete",
        }),
      }],
    };
  }
);

// --- Tool: send_task ---

server.tool(
  "send_task",
  "Send a task (briefing, review bundle, question, or response) to a peer agent. Review bundles must contain at least 5 findings (QSG bandwidth constraint: Γ_h ≈ 1.67).",
  {
    to: z.string().describe("Target agent ID"),
    type: z.enum(["briefing", "review_bundle", "question", "response"]).describe("Task type"),
    payload: z.string().describe("JSON-encoded payload matching the task type schema"),
  },
  async ({ to, type, payload }, extra) => {
    const fromAgent = [...state.agents.entries()].find(
      ([id]) => id !== to && state.agents.has(id)
    );

    if (!fromAgent) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Sender not registered or no other agent found" }) }],
      };
    }

    const from = fromAgent[0];

    if (!state.agents.has(to)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Target agent not registered", to }) }],
      };
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Invalid JSON payload" }) }],
      };
    }

    // Enforce minimum bandwidth for review bundles (QSG: m ≥ 3)
    if (type === "review_bundle") {
      if (!Array.isArray(parsedPayload) || parsedPayload.length < MIN_BANDWIDTH) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: `Review bundles must contain at least ${MIN_BANDWIDTH} findings (QSG bandwidth constraint: Γ_h = mN·h/α > 1)`,
              received: Array.isArray(parsedPayload) ? parsedPayload.length : 0,
              required: MIN_BANDWIDTH,
            }),
          }],
        };
      }
    }

    const task: Task = {
      id: generateId(),
      from,
      to,
      type,
      payload: parsedPayload as Task["payload"],
      createdAt: Date.now(),
    };

    const queue = state.taskQueues.get(to) ?? [];
    queue.push(task);
    state.taskQueues.set(to, queue);

    // Log review bundles and verdict responses
    if (type === "review_bundle" && Array.isArray(parsedPayload)) {
      const categories = parsedPayload.map((f: Record<string, unknown>) => f.category).filter(Boolean);
      logEvent({ event: "review_bundle", taskId: task.id, from, to, findingCount: parsedPayload.length, categories });
    } else if (type === "response" && Array.isArray(parsedPayload)) {
      for (const response of parsedPayload as FindingResponse[]) {
        logEvent({ event: "verdict", taskId: task.id, from, to, findingId: response.findingId, verdict: response.verdict });
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          sent: true,
          taskId: task.id,
          from,
          to,
          type,
          findingCount: type === "review_bundle" && Array.isArray(parsedPayload) ? parsedPayload.length : undefined,
        }),
      }],
    };
  }
);

// --- Tool: poll_tasks ---

server.tool(
  "poll_tasks",
  "Retrieve and drain all pending tasks for this agent.",
  {
    agentId: z.string().describe("Your agent ID"),
  },
  async ({ agentId }) => {
    if (!state.agents.has(agentId)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Agent not registered", agentId }) }],
      };
    }

    const queue = state.taskQueues.get(agentId) ?? [];
    state.taskQueues.set(agentId, []); // drain

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          tasks: queue,
          count: queue.length,
        }),
      }],
    };
  }
);

// --- Tool: signal_phase ---

server.tool(
  "signal_phase",
  "Signal that this agent has reached a protocol phase. Phases: registered → briefing → review → dialogue → complete.",
  {
    agentId: z.string().describe("Your agent ID"),
    phase: z.enum(["registered", "briefing", "review", "dialogue", "complete"]).describe("Phase reached"),
  },
  async ({ agentId, phase }) => {
    if (!state.agents.has(agentId)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Agent not registered" }) }],
      };
    }

    const currentPhase = state.phases.get(agentId)!;
    const currentIndex = PHASES.indexOf(currentPhase);
    const targetIndex = PHASES.indexOf(phase);

    if (targetIndex <= currentIndex) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "Cannot move backward in phase lifecycle",
            current: currentPhase,
            requested: phase,
          }),
        }],
      };
    }

    state.phases.set(agentId, phase);
    notifyPhaseWaiters(agentId, phase);
    logEvent({ event: "phase_change", agentId, from: currentPhase, to: phase });

    // Report peer phases
    const peerPhases: Record<string, Phase> = {};
    for (const [id, p] of state.phases.entries()) {
      if (id !== agentId) peerPhases[id] = p;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          phaseUpdated: true,
          agentId,
          phase,
          peerPhases,
        }),
      }],
    };
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
  async ({ peerId, phase }) => {
    if (!state.agents.has(peerId)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Peer not registered", peerId }) }],
      };
    }

    const currentPhase = state.phases.get(peerId)!;
    const currentIndex = PHASES.indexOf(currentPhase);
    const targetIndex = PHASES.indexOf(phase);

    // Already at or past target phase
    if (currentIndex >= targetIndex) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ reached: true, peerId, phase, currentPhase }),
        }],
      };
    }

    // Block until peer reaches the phase
    const result = await new Promise<{ reached: boolean }>((resolve) => {
      const waiters = state.phaseWaiters.get(peerId) ?? [];
      waiters.push({ targetPhase: phase, resolve });
      state.phaseWaiters.set(peerId, waiters);

      // Timeout after 5 minutes to prevent indefinite blocking
      setTimeout(() => {
        resolve({ reached: false });
      }, 5 * 60 * 1000);
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          reached: result.reached,
          peerId,
          phase,
          currentPhase: state.phases.get(peerId),
          timedOut: !result.reached,
        }),
      }],
    };
  }
);

// --- Tool: get_status ---

server.tool(
  "get_status",
  "Get the current broker state: registered agents, their phases, and pending task counts.",
  {},
  async () => {
    const agents: Record<string, { project: string; phase: Phase; pendingTasks: number }> = {};

    for (const [id, reg] of state.agents.entries()) {
      agents[id] = {
        project: reg.project,
        phase: state.phases.get(id) ?? "registered",
        pendingTasks: (state.taskQueues.get(id) ?? []).length,
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          agentCount: state.agents.size,
          agents,
          minBandwidth: MIN_BANDWIDTH,
          qsgNote: "Γ_h = mN·h/α — keep m ≥ 3 to stay in selection regime",
        }),
      }],
    };
  }
);

// --- Protocol resource ---

server.resource(
  "protocol",
  "cross-review://protocol",
  { mimeType: "application/json" },
  async () => ({
    contents: [{
      uri: "cross-review://protocol",
      mimeType: "application/json",
      text: JSON.stringify({
        name: "Cross-Review Protocol",
        version: "1.0.0",
        theory: {
          paper: "Tanaka (2026), arXiv:2603.24676",
          model: "Quantized Simplex Gossip (QSG)",
          centralFormula: "Γ_h = mN·h/α",
          regimes: {
            drift: "|Γ_h| ≪ 1 → consensus is random (lottery)",
            selection: "|Γ_h| ≫ 1 → genuine insights amplified",
          },
          designImplication: "Bundle findings (m ≥ 5) to stay in selection regime (Γ_h ≈ 1.67)",
        },
        phases: [
          {
            name: "briefing",
            description: "Read own codebase, produce structured Briefing artifact, send to peer",
            parallel: true,
          },
          {
            name: "review",
            description: "Wait for peer briefing, read peer's actual code, send Finding[] bundle (m ≥ 3)",
            parallel: true,
            constraint: "wait_for_phase(peer, 'briefing') before starting",
          },
          {
            name: "dialogue",
            description: "Read findings about own project, respond with verdicts (accept/reject/discuss with evidence)",
            parallel: true,
            constraint: "wait_for_phase(peer, 'review') before starting",
          },
          {
            name: "complete",
            description: "All findings processed. Signal completion.",
          },
        ],
        findingCategories: [
          "pattern_transfer",
          "missing_practice",
          "inconsistency",
          "simplification",
          "bug_risk",
          "documentation_gap",
        ],
        verdicts: {
          accept: "Finding is valid, will act on it",
          reject: "Finding is incorrect or inapplicable (must provide counter_evidence)",
          discuss: "Needs clarification — creates a sub-task for focused exchange",
        },
      }, null, 2),
    }],
  })
);

// --- Start server ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("cross-review-mcp broker started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

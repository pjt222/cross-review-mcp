#!/usr/bin/env node
/**
 * Cross-Review MCP Broker
 *
 * An MCP server that enables two Claude Code instances to review each other's
 * projects through structured artifact exchange. Design informed by QSG scaling
 * laws (Tanaka, arXiv:2603.24676) and EvoSkills co-evolutionary verification
 * (Zhang et al., arXiv:2604.01687):
 *
 *   Γ_h = mN·h/α  — drift-selection parameter (QSG)
 *   Skill Generator ↔ Surrogate Verifier co-evolution (EvoSkills)
 *
 * High bandwidth (m ≥ 5 findings per bundle) pushes the system into the
 * selection regime where genuine insights dominate over random drift.
 * Skill packages evolve through iterative refinement capped at 5 rounds.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  type BrokerState,
  type FindingResponse,
  MIN_BANDWIDTH,
  MAX_EVOLUTION_ROUNDS,
  MIN_SKILL_ARTIFACTS,
} from "./types.js";
import {
  handleRegister,
  handleSendTask,
  handlePollTasks,
  handleAckTasks,
  handleSignalPhase,
  handleWaitForPhase,
  handleGetStatus,
  handleDeregister,
  handleGetSkillStatus,
} from "./broker.js";
import type { MemPalaceState } from "./types.js";
import {
  createMemPalaceState,
  handleMemPalaceConfigure,
  handleMemPalaceStore,
  handleMemPalaceSearch,
  handleMemPalaceStatus,
} from "./mempalace.js";

// --- Configuration ---

const PORT = parseInt(process.env.CROSS_REVIEW_PORT ?? "3749");
const LOG_PATH = process.env.CROSS_REVIEW_LOG ?? "./cross-review.jsonl";

// --- Telemetry (append-only JSONL) ---

function logEvent(event: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ...event, timestamp: Date.now() }) + "\n");
  } catch {
    // Logging failure must never break the broker
  }
}

// --- Broker state (in-memory, single process, shared across all connections) ---

const state: BrokerState = {
  agents: new Map(),
  phases: new Map(),
  taskQueues: new Map(),
  phaseWaiters: new Map(),
  sentTaskTypes: new Map(),
  skillEvolution: new Map(),
};

const memPalaceState: MemPalaceState = createMemPalaceState();

// --- Protocol resource document ---

const PROTOCOL_DOC = `# Cross-Review Protocol v1.0.0

## Theory
Based on Quantized Simplex Gossip (Tanaka, 2026, arXiv:2603.24676).
Central formula: **Γ_h = mN·h/α** where m=findings per bundle, N=agents, h=bias, α=adaptation rate.
- |Γ_h| ≪ 1 → consensus is random (drift regime)
- |Γ_h| ≫ 1 → genuine insights amplified (selection regime)
- Design: m ≥ ${MIN_BANDWIDTH} keeps Γ_h ≈ 1.67 in the selection regime

## EvoSkills Integration (Zhang et al., 2026, arXiv:2604.01687)
Agents can exchange **skill packages** — multi-file artifact bundles that encode
reusable task strategies. The two-agent cross-review topology maps onto the
EvoSkills co-evolutionary loop:
- **Agent A** acts as Skill Generator, submitting a skill_bundle to Agent B
- **Agent B** acts as Surrogate Verifier, returning a skill_verification with score and feedback
- Agent A refines the skill using feedback (up to ${MAX_EVOLUTION_ROUNDS} rounds)
- Convergence is detected when consecutive scores stabilize

Constraints:
- Skill packages must contain ≥ ${MIN_SKILL_ARTIFACTS} artifacts (multi-file requirement)
- Evolution is capped at ${MAX_EVOLUTION_ROUNDS} rounds (empirically sufficient per Zhang et al.)
- Skills evolved by one agent transfer effectively to others (cross-model portability)

## Phases (sequential, enforced by broker)
1. **briefing** — Read own codebase, produce structured Briefing artifact, send to peer. Both agents do this in parallel.
2. **review** — Wait for peer briefing (wait_for_phase), read peer's actual code, send Finding[] bundle (m ≥ ${MIN_BANDWIDTH}). Must have sent a briefing first.
3. **dialogue** — Read findings about own project, respond with FindingResponse[] verdicts. Must have sent a review_bundle first.
4. **synthesis** — Produce a Synthesis artifact: accepted findings with planned actions, rejected findings with reasons. Must have sent a response first. Each agent synthesizes what it learned about its own project.
5. **complete** — All findings processed and synthesized. Signal completion.

Skill exchange (skill_bundle / skill_verification) can happen during any phase after briefing.

## Finding Categories
pattern_transfer, missing_practice, inconsistency, simplification, bug_risk, documentation_gap

## Verdicts
- **accept** — Finding is valid, will act on it
- **reject** — Finding is incorrect or inapplicable (provide counterEvidence if available)
- **discuss** — Needs clarification, creates a sub-task for focused exchange
`;

// --- Factory: create a new McpServer with all tools registered ---

function createBrokerServer(brokerState: BrokerState, mpState: MemPalaceState): McpServer {
  const server = new McpServer({
    name: "cross-review-mcp",
    version: "1.0.0",
  });

  // Tool: register
  server.tool(
    "register",
    "Register this agent with the broker. Call once at session start.",
    {
      agentId: z.string().describe("Unique agent identifier (e.g., 'ez-ar2diff')"),
      project: z.string().describe("Project name this agent represents"),
      capabilities: z.array(z.string()).describe("List of capabilities (e.g., ['review', 'suggest'])"),
    },
    async (args) => {
      const result = handleRegister(brokerState, args);
      logEvent({ event: "register", agentId: args.agentId, project: args.project });
      return result;
    }
  );

  // Tool: send_task
  server.tool(
    "send_task",
    "Send a task to a peer agent. Review bundles must contain ≥ 5 findings (QSG). Skill bundles must contain ≥ 2 artifacts (EvoSkills) and evolve for up to 5 rounds.",
    {
      from: z.string().describe("Your agent ID (the sender)"),
      to: z.string().describe("Target agent ID"),
      type: z.enum(["briefing", "review_bundle", "question", "response", "synthesis", "skill_bundle", "skill_verification"]).describe("Task type"),
      payload: z.string().describe("JSON-encoded payload matching the task type schema"),
    },
    async (args) => {
      const result = handleSendTask(brokerState, args);
      const parsed = JSON.parse(result.content[0].text);

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
        } else if (args.type === "skill_bundle") {
          // Payload already validated by handleSendTask — safe to parse
          const skillPayload = JSON.parse(args.payload) as Record<string, unknown>;
          logEvent({ event: "skill_bundle", taskId: parsed.taskId, from: args.from, to: args.to, skillId: skillPayload.skillId, evolutionRound: skillPayload.evolutionRound, artifactCount: Array.isArray(skillPayload.artifacts) ? skillPayload.artifacts.length : 0 });
        } else if (args.type === "skill_verification") {
          const verPayload = JSON.parse(args.payload) as Record<string, unknown>;
          logEvent({ event: "skill_verification", taskId: parsed.taskId, from: args.from, to: args.to, skillId: verPayload.skillId, pass: verPayload.pass, score: verPayload.score });
        }
      }

      return result;
    }
  );

  // Tool: poll_tasks
  server.tool(
    "poll_tasks",
    "Retrieve pending tasks for this agent. Tasks remain in queue until acknowledged via ack_tasks.",
    {
      agentId: z.string().describe("Your agent ID"),
    },
    async (args) => handlePollTasks(brokerState, args)
  );

  // Tool: ack_tasks
  server.tool(
    "ack_tasks",
    "Acknowledge and remove processed tasks from your queue. Call after successfully processing tasks from poll_tasks.",
    {
      agentId: z.string().describe("Your agent ID"),
      taskIds: z.array(z.string()).describe("IDs of tasks to acknowledge"),
    },
    async (args) => {
      const result = handleAckTasks(brokerState, args);
      const parsed = JSON.parse(result.content[0].text);
      logEvent({ event: "ack_tasks", agentId: args.agentId, ackedCount: parsed.acknowledged, remainingCount: parsed.remaining });
      return result;
    }
  );

  // Tool: signal_phase
  server.tool(
    "signal_phase",
    "Signal that this agent has reached a protocol phase. Phases: registered → briefing → review → dialogue → complete.",
    {
      agentId: z.string().describe("Your agent ID"),
      phase: z.enum(["briefing", "review", "dialogue", "synthesis", "complete"]).describe("Phase reached"),
    },
    async (args) => {
      const previousPhase = brokerState.phases.get(args.agentId);
      const result = handleSignalPhase(brokerState, args);
      const parsed = JSON.parse(result.content[0].text);
      if (parsed.phaseUpdated) {
        logEvent({ event: "phase_change", agentId: args.agentId, from: previousPhase, to: args.phase });
      }
      return result;
    }
  );

  // Tool: wait_for_phase
  server.tool(
    "wait_for_phase",
    "Block until a peer agent reaches a specific phase. Returns immediately if the peer is already at or past that phase.",
    {
      peerId: z.string().describe("The peer agent ID to wait for"),
      phase: z.enum(["registered", "briefing", "review", "dialogue", "synthesis", "complete"]).describe("Phase to wait for"),
    },
    async (args) => handleWaitForPhase(brokerState, args)
  );

  // Tool: get_status
  server.tool(
    "get_status",
    "Get the current broker state: registered agents, their phases, and pending task counts.",
    {},
    async () => handleGetStatus(brokerState)
  );

  // Tool: get_skill_status (EvoSkills)
  server.tool(
    "get_skill_status",
    "Get the skill evolution state for an agent: current round, convergence status, score history.",
    {
      agentId: z.string().describe("The agent ID to query skill evolution for"),
    },
    async (args) => handleGetSkillStatus(brokerState, args)
  );

  // Tool: deregister
  server.tool(
    "deregister",
    "Remove this agent from the broker. Cleans up queues and resolves pending waiters.",
    {
      agentId: z.string().describe("Your agent ID"),
    },
    async (args) => {
      const result = handleDeregister(brokerState, args);
      logEvent({ event: "deregister", agentId: args.agentId });
      return result;
    }
  );

  // Tool: mempalace_configure
  server.tool(
    "mempalace_configure",
    "Configure MemPalace integration for persistent artifact storage. See https://github.com/mila-jovovich/mempalace",
    {
      url: z.string().describe("MemPalace server URL (e.g., 'http://localhost:5173/mcp')"),
      palacePath: z.string().optional().describe("Palace path (default: ~/.mempalace/palace)"),
      wing: z.string().optional().describe("Wing name for cross-review artifacts (default: 'cross-review')"),
    },
    async (args) => {
      const result = handleMemPalaceConfigure(mpState, args);
      logEvent({ event: "mempalace_configure", url: args.url, wing: args.wing ?? "cross-review" });
      return result;
    }
  );

  // Tool: mempalace_store
  server.tool(
    "mempalace_store",
    "Store a cross-review artifact in the in-memory cache. Artifacts are organized by project (room) within the cross-review wing.",
    {
      agentId: z.string().describe("Your agent ID"),
      kind: z.enum(["briefing", "finding", "response", "synthesis"]).describe("Artifact type to store"),
      payload: z.string().describe("JSON-encoded artifact content"),
    },
    async (args) => {
      const result = handleMemPalaceStore(mpState, brokerState, args);
      logEvent({ event: "mempalace_store", agentId: args.agentId, kind: args.kind });
      return result;
    }
  );

  // Tool: mempalace_search
  server.tool(
    "mempalace_search",
    "Search stored cross-review artifacts in MemPalace. Filter by artifact kind and/or project.",
    {
      query: z.string().describe("Search query string"),
      kind: z.enum(["briefing", "finding", "response", "synthesis"]).optional().describe("Filter by artifact type"),
      project: z.string().optional().describe("Filter by project name"),
      limit: z.number().optional().describe("Max results to return (default: 10)"),
    },
    async (args) => handleMemPalaceSearch(mpState, args)
  );

  // Tool: mempalace_status
  server.tool(
    "mempalace_status",
    "Get MemPalace integration status: configuration, entry counts by kind and project.",
    {},
    async () => handleMemPalaceStatus(mpState)
  );

  // Protocol resource
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

  return server;
}

// --- HTTP request handler factory ---

function createHttpHandler(
  brokerState: BrokerState,
  transportMap: Map<string, StreamableHTTPServerTransport>,
  mpState: MemPalaceState,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", agents: brokerState.agents.size }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transportMap.has(sessionId)) {
        transport = transportMap.get(sessionId)!;
      } else {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcpServer = createBrokerServer(brokerState, mpState);
        await mcpServer.connect(transport);

        transport.onclose = () => {
          if (sessionId) transportMap.delete(sessionId);
        };
      }

      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (sessionId && transportMap.has(sessionId)) {
        await transportMap.get(sessionId)!.handleRequest(req, res);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No active session" }));
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  };
}

// --- Module-level handler (uses shared state) ---

const transports = new Map<string, StreamableHTTPServerTransport>();
const handleHttpRequest = createHttpHandler(state, transports, memPalaceState);

// --- Test helper: start an isolated server on a random port ---

export async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const testState: BrokerState = {
    agents: new Map(),
    phases: new Map(),
    taskQueues: new Map(),
    phaseWaiters: new Map(),
    sentTaskTypes: new Map(),
    skillEvolution: new Map(),
  };
  const testTransports = new Map<string, StreamableHTTPServerTransport>();
  const testMpState = createMemPalaceState();
  const handler = createHttpHandler(testState, testTransports, testMpState);

  const httpServer = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address() as { port: number };
  const serverUrl = `http://localhost:${addr.port}`;

  const close = () =>
    new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );

  return { url: serverUrl, close };
}

// --- Start server ---

async function main(): Promise<void> {
  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res).catch((error) => {
      console.error("Request handling error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  httpServer.listen(PORT, () => {
    console.error(`cross-review-mcp broker listening on http://localhost:${PORT}/mcp`);
    logEvent({ event: "startup", port: PORT });
  });

  const shutdown = () => {
    logEvent({ event: "shutdown", agentCount: state.agents.size });
    console.error("cross-review-mcp broker shutting down");
    httpServer.close();
    for (const transport of transports.values()) {
      transport.close().catch(() => {});
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

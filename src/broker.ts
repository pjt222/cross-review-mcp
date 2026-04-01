/**
 * Cross-Review MCP Broker — Core Logic
 *
 * Pure handler functions parameterized by BrokerState.
 * Extracted from server.ts for testability.
 */

import type {
  BrokerState,
  Task,
  FindingResponse,
  Phase,
  PhaseWaiter,
} from "./types.js";
import { PHASES, MIN_BANDWIDTH } from "./types.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
}

function textResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function notifyPhaseWaiters(state: BrokerState, agentId: string, phase: Phase): void {
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

// --- Handlers ---

export function handleRegister(
  state: BrokerState,
  args: { agentId: string; project: string; capabilities: string[] },
): ToolResult {
  const { agentId, project, capabilities } = args;

  if (state.agents.has(agentId)) {
    // Update registration timestamp to support reconnects (idempotent)
    const existing = state.agents.get(agentId)!;
    state.agents.set(agentId, { ...existing, registeredAt: Date.now() });

    const peerCount = state.agents.size;
    const peers = [...state.agents.keys()].filter((id) => id !== agentId);
    return textResult({
      registered: true,
      agentId,
      project: existing.project,
      peerCount,
      peers,
      minBandwidth: MIN_BANDWIDTH,
      protocol: "Cross-review protocol: briefing → review → dialogue → complete",
      reconnected: true,
    });
  }

  state.agents.set(agentId, { agentId, project, capabilities, registeredAt: Date.now() });
  state.phases.set(agentId, "registered");
  state.taskQueues.set(agentId, []);
  state.phaseWaiters.set(agentId, []);
  state.sentTaskTypes.set(agentId, new Set());

  const peerCount = state.agents.size;
  const peers = [...state.agents.keys()].filter((id) => id !== agentId);

  return textResult({
    registered: true,
    agentId,
    project,
    peerCount,
    peers,
    minBandwidth: MIN_BANDWIDTH,
    protocol: "Cross-review protocol: briefing → review → dialogue → complete",
  });
}

export function handleSendTask(
  state: BrokerState,
  args: { from: string; to: string; type: string; payload: string },
): ToolResult {
  const { from, to, type, payload } = args;

  if (!state.agents.has(from)) {
    return textResult({ error: "Sender not registered", from });
  }
  if (!state.agents.has(to)) {
    return textResult({ error: "Target agent not registered", to });
  }
  if (from === to) {
    return textResult({ error: "Cannot send tasks to yourself", from, to });
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    return textResult({ error: "Invalid JSON payload" });
  }

  if (type === "review_bundle") {
    if (!Array.isArray(parsedPayload) || parsedPayload.length < MIN_BANDWIDTH) {
      return textResult({
        error: `Review bundles must contain at least ${MIN_BANDWIDTH} findings (QSG bandwidth constraint: Γ_h = mN·h/α > 1)`,
        received: Array.isArray(parsedPayload) ? parsedPayload.length : 0,
        required: MIN_BANDWIDTH,
      });
    }
  }

  if (type === "response") {
    if (!Array.isArray(parsedPayload) || parsedPayload.length === 0) {
      return textResult({
        error: "Response must contain at least one FindingResponse",
        received: Array.isArray(parsedPayload) ? parsedPayload.length : 0,
      });
    }
  }

  const task: Task = {
    id: generateId(),
    from,
    to,
    type: type as Task["type"],
    payload: parsedPayload as Task["payload"],
    createdAt: Date.now(),
  };

  const queue = state.taskQueues.get(to) ?? [];
  queue.push(task);
  state.taskQueues.set(to, queue);

  state.sentTaskTypes.get(from)?.add(type as Task["type"]);

  return textResult({
    sent: true,
    taskId: task.id,
    from,
    to,
    type,
    findingCount: type === "review_bundle" && Array.isArray(parsedPayload) ? parsedPayload.length : undefined,
  });
}

export function handlePollTasks(
  state: BrokerState,
  args: { agentId: string },
): ToolResult {
  const { agentId } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  const queue = state.taskQueues.get(agentId) ?? [];
  return textResult({ tasks: queue, count: queue.length });
}

export function handleAckTasks(
  state: BrokerState,
  args: { agentId: string; taskIds: string[] },
): ToolResult {
  const { agentId, taskIds } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  const ackSet = new Set(taskIds);
  const queue = state.taskQueues.get(agentId) ?? [];
  const remaining = queue.filter((task) => !ackSet.has(task.id));
  const ackedCount = queue.length - remaining.length;
  state.taskQueues.set(agentId, remaining);

  return textResult({ acknowledged: ackedCount, remaining: remaining.length });
}

export function handleSignalPhase(
  state: BrokerState,
  args: { agentId: string; phase: Phase },
): ToolResult {
  const { agentId, phase } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered" });
  }

  const currentPhase = state.phases.get(agentId)!;
  const currentIndex = PHASES.indexOf(currentPhase);
  const targetIndex = PHASES.indexOf(phase);

  if (targetIndex <= currentIndex) {
    return textResult({
      error: "Cannot move backward in phase lifecycle",
      current: currentPhase,
      requested: phase,
    });
  }

  const sentTypes = state.sentTaskTypes.get(agentId) ?? new Set();

  if (phase === "review" && !sentTypes.has("briefing")) {
    return textResult({
      error: "Cannot enter review phase without sending a briefing first",
      hint: "Use send_task with type 'briefing' before signaling 'review'",
    });
  }

  if (phase === "dialogue" && !sentTypes.has("review_bundle")) {
    return textResult({
      error: "Cannot enter dialogue phase without sending a review bundle first",
      hint: "Use send_task with type 'review_bundle' before signaling 'dialogue'",
    });
  }

  if (state.agents.size < 2) {
    return textResult({
      error: "Cannot advance phase with fewer than 2 registered agents",
      registered: state.agents.size,
      required: 2,
    });
  }

  state.phases.set(agentId, phase);
  notifyPhaseWaiters(state, agentId, phase);

  const peerPhases: Record<string, Phase> = {};
  for (const [id, p] of state.phases.entries()) {
    if (id !== agentId) peerPhases[id] = p;
  }

  return textResult({ phaseUpdated: true, agentId, phase, peerPhases });
}

export async function handleWaitForPhase(
  state: BrokerState,
  args: { peerId: string; phase: Phase },
  timeoutMs = 5 * 60 * 1000,
): Promise<ToolResult> {
  const { peerId, phase } = args;

  if (!state.agents.has(peerId)) {
    return textResult({ error: "Peer not registered", peerId });
  }

  const currentPhase = state.phases.get(peerId)!;
  const currentIndex = PHASES.indexOf(currentPhase);
  const targetIndex = PHASES.indexOf(phase);

  if (currentIndex >= targetIndex) {
    return textResult({ reached: true, peerId, phase, currentPhase });
  }

  const result = await new Promise<{ reached: boolean }>((resolve) => {
    const waiter: PhaseWaiter = { targetPhase: phase, resolve };
    const waiters = state.phaseWaiters.get(peerId) ?? [];
    waiters.push(waiter);
    state.phaseWaiters.set(peerId, waiters);

    setTimeout(() => {
      const currentWaiters = state.phaseWaiters.get(peerId) ?? [];
      state.phaseWaiters.set(peerId, currentWaiters.filter((w) => w !== waiter));
      resolve({ reached: false });
    }, timeoutMs);
  });

  return textResult({
    reached: result.reached,
    peerId,
    phase,
    currentPhase: state.phases.get(peerId),
    timedOut: !result.reached,
  });
}

export function handleGetStatus(state: BrokerState): ToolResult {
  const agents: Record<string, { project: string; phase: Phase; pendingTasks: number }> = {};

  for (const [id, reg] of state.agents.entries()) {
    agents[id] = {
      project: reg.project,
      phase: state.phases.get(id) ?? "registered",
      pendingTasks: (state.taskQueues.get(id) ?? []).length,
    };
  }

  return textResult({
    agentCount: state.agents.size,
    agents,
    minBandwidth: MIN_BANDWIDTH,
    qsgNote: `Γ_h = mN·h/α — keep m ≥ ${MIN_BANDWIDTH} to stay in selection regime`,
  });
}

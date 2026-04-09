/**
 * Cross-Review MCP Broker — Core Logic
 *
 * Pure handler functions parameterized by BrokerState.
 * Extracted from server.ts for testability.
 */

import type {
  BrokerState,
  Task,
  Phase,
  PhaseWaiter,
  TaskWaiter,
  SkillEvolutionState,
} from "./types.js";
import {
  PHASES,
  MIN_BANDWIDTH,
  MAX_EVOLUTION_ROUNDS,
  SKILL_CONVERGENCE_THRESHOLD,
} from "./types.js";
import { validatePayload } from "./schemas.js";

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

export function notifyTaskWaiters(state: BrokerState, agentId: string): void {
  const waiters = state.taskWaiters.get(agentId) ?? [];
  if (waiters.length === 0) return;

  const queue = state.taskQueues.get(agentId) ?? [];
  for (const waiter of waiters) {
    waiter.resolve({ tasks: queue, count: queue.length });
  }
  state.taskWaiters.set(agentId, []);
}

// --- EvoSkills state updates (validation handled by schemas.ts) ---

function updateSkillBundleState(
  state: BrokerState,
  senderId: string,
  parsedPayload: unknown,
): ToolResult | null {
  const pkg = parsedPayload as { evolutionRound?: number };
  const round = pkg.evolutionRound ?? 0;
  const evoState = state.skillEvolution.get(senderId) ?? {
    agentId: senderId,
    currentRound: 0,
    skillHistory: [],
    converged: false,
  };
  evoState.currentRound = round;
  state.skillEvolution.set(senderId, evoState);
  return null;
}

function updateSkillVerificationState(
  state: BrokerState,
  skillOwnerId: string,
  parsedPayload: unknown,
): void {
  const ver = parsedPayload as { skillId: string; score: number };
  const evoState = state.skillEvolution.get(skillOwnerId) ?? {
    agentId: skillOwnerId,
    currentRound: 0,
    skillHistory: [],
    converged: false,
  };
  evoState.skillHistory.push({ skillId: ver.skillId, score: ver.score });
  const history = evoState.skillHistory;
  if (history.length >= 2) {
    const delta = Math.abs(history[history.length - 1].score - history[history.length - 2].score);
    evoState.converged = delta < SKILL_CONVERGENCE_THRESHOLD;
  }
  state.skillEvolution.set(skillOwnerId, evoState);
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
      protocol: "Cross-review protocol: briefing → review → dialogue → synthesis → complete",
      reconnected: true,
    });
  }

  state.agents.set(agentId, { agentId, project, capabilities, registeredAt: Date.now() });
  state.phases.set(agentId, "registered");
  state.taskQueues.set(agentId, []);
  state.phaseWaiters.set(agentId, []);
  state.sentTaskTypes.set(agentId, new Set());
  state.rounds.set(agentId, 0);
  state.roundHistory.set(agentId, []);
  state.taskWaiters.set(agentId, []);

  const peerCount = state.agents.size;
  const peers = [...state.agents.keys()].filter((id) => id !== agentId);

  return textResult({
    registered: true,
    agentId,
    project,
    peerCount,
    peers,
    minBandwidth: MIN_BANDWIDTH,
    protocol: "Cross-review protocol: briefing → review → dialogue → synthesis → complete",
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

  // Validate payload against type-specific schema
  const validation = validatePayload(type, parsedPayload);
  if (!validation.success) {
    const errorResult: Record<string, unknown> = { error: validation.error! };
    // Preserve extra fields (received, required) for backward-compatible error responses
    const extra = validation as Record<string, unknown>;
    if ("received" in extra) errorResult.received = extra.received;
    if ("required" in extra) errorResult.required = extra.required;
    return textResult(errorResult);
  }
  parsedPayload = validation.data;

  // EvoSkills side effects (state updates after schema validation passes)
  if (type === "skill_bundle") {
    const sideEffectError = updateSkillBundleState(state, from, parsedPayload);
    if (sideEffectError) return sideEffectError;
  }
  if (type === "skill_verification") {
    updateSkillVerificationState(state, to, parsedPayload);
  }

  const task: Task = {
    id: generateId(),
    from,
    to,
    type: type as Task["type"],
    payload: parsedPayload as Task["payload"],
    createdAt: Date.now(),
    round: state.rounds.get(from) ?? 0,
  };

  const queue = state.taskQueues.get(to) ?? [];
  queue.push(task);
  state.taskQueues.set(to, queue);

  state.sentTaskTypes.get(from)?.add(type as Task["type"]);

  // Resolve any long-poll waiters for the target agent
  notifyTaskWaiters(state, to);

  return textResult({
    sent: true,
    taskId: task.id,
    from,
    to,
    type,
    findingCount: type === "review_bundle" && Array.isArray(parsedPayload) ? parsedPayload.length : undefined,
  });
}

export async function handlePollTasks(
  state: BrokerState,
  args: { agentId: string; timeout?: number },
  maxTimeoutMs = 5 * 60 * 1000,
): Promise<ToolResult> {
  const { agentId, timeout } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  const queue = state.taskQueues.get(agentId) ?? [];

  // Immediate return if tasks exist or no timeout requested
  if (queue.length > 0 || !timeout || timeout <= 0) {
    return textResult({ tasks: queue, count: queue.length });
  }

  // Long-poll: wait for tasks to arrive or timeout
  const waitMs = Math.min(timeout, maxTimeoutMs);
  const result = await new Promise<{ tasks: Task[]; count: number }>((resolve) => {
    const waiter: TaskWaiter = { resolve };
    const waiters = state.taskWaiters.get(agentId) ?? [];
    waiters.push(waiter);
    state.taskWaiters.set(agentId, waiters);

    setTimeout(() => {
      const currentWaiters = state.taskWaiters.get(agentId) ?? [];
      const filtered = currentWaiters.filter((w) => w !== waiter);
      state.taskWaiters.set(agentId, filtered);
      // Return current queue state on timeout (may have tasks from concurrent sends)
      const currentQueue = state.taskQueues.get(agentId) ?? [];
      resolve({ tasks: currentQueue, count: currentQueue.length });
    }, waitMs);
  });

  return textResult({ tasks: result.tasks, count: result.count });
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

  if (phase === "synthesis" && !sentTypes.has("response")) {
    return textResult({
      error: "Cannot enter synthesis phase without sending a response first",
      hint: "Use send_task with type 'response' before signaling 'synthesis'",
    });
  }

  if (state.agents.size < 2 && phase !== "complete") {
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

export function handleDeregister(
  state: BrokerState,
  args: { agentId: string },
): ToolResult {
  const { agentId } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  // Resolve any pending phase waiters with reached: false
  const phaseWaiters = state.phaseWaiters.get(agentId) ?? [];
  for (const waiter of phaseWaiters) {
    waiter.resolve({ reached: false });
  }

  // Resolve any pending task waiters with empty result
  const taskWaiters = state.taskWaiters.get(agentId) ?? [];
  for (const waiter of taskWaiters) {
    waiter.resolve({ tasks: [], count: 0 });
  }

  // Remove from all state maps
  state.agents.delete(agentId);
  state.phases.delete(agentId);
  state.taskQueues.delete(agentId);
  state.phaseWaiters.delete(agentId);
  state.sentTaskTypes.delete(agentId);
  state.rounds.delete(agentId);
  state.roundHistory.delete(agentId);
  state.taskWaiters.delete(agentId);

  return textResult({ deregistered: true, agentId });
}

export function handleResetRound(
  state: BrokerState,
  args: { agentId: string },
): ToolResult {
  const { agentId } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  const currentPhase = state.phases.get(agentId)!;
  if (currentPhase !== "complete") {
    return textResult({
      error: "Can only reset round from complete phase",
      currentPhase,
      hint: "Signal phase 'complete' before calling reset_round",
    });
  }

  const currentRound = state.rounds.get(agentId) ?? 0;

  // Archive current round's tasks
  const currentTasks = state.taskQueues.get(agentId) ?? [];
  const history = state.roundHistory.get(agentId) ?? [];
  history.push(currentTasks);
  state.roundHistory.set(agentId, history);

  // Reset for new round
  const nextRound = currentRound + 1;
  state.rounds.set(agentId, nextRound);
  state.phases.set(agentId, "registered");
  state.taskQueues.set(agentId, []);
  state.sentTaskTypes.set(agentId, new Set());

  return textResult({
    roundReset: true,
    agentId,
    previousRound: currentRound,
    newRound: nextRound,
    archivedTasks: currentTasks.length,
  });
}

export function handleGetStatus(state: BrokerState): ToolResult {
  const agents: Record<string, { project: string; phase: Phase; pendingTasks: number; round: number }> = {};

  for (const [id, reg] of state.agents.entries()) {
    agents[id] = {
      project: reg.project,
      phase: state.phases.get(id) ?? "registered",
      pendingTasks: (state.taskQueues.get(id) ?? []).length,
      round: state.rounds.get(id) ?? 0,
    };
  }

  return textResult({
    agentCount: state.agents.size,
    agents,
    minBandwidth: MIN_BANDWIDTH,
    qsgNote: `Γ_h = mN·h/α — keep m ≥ ${MIN_BANDWIDTH} to stay in selection regime`,
  });
}

export function handleGetSkillStatus(
  state: BrokerState,
  args: { agentId: string },
): ToolResult {
  const { agentId } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  const evoState = state.skillEvolution.get(agentId);
  if (!evoState) {
    return textResult({
      agentId,
      hasSkillEvolution: false,
      hint: "Submit a skill_bundle via send_task to begin co-evolutionary skill refinement",
    });
  }

  const latestScore = evoState.skillHistory.length > 0
    ? evoState.skillHistory[evoState.skillHistory.length - 1].score
    : null;

  return textResult({
    agentId,
    hasSkillEvolution: true,
    currentRound: evoState.currentRound,
    maxRounds: MAX_EVOLUTION_ROUNDS,
    converged: evoState.converged,
    latestScore,
    totalIterations: evoState.skillHistory.length,
    history: evoState.skillHistory,
  });
}

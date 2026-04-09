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
  FindingTrackerEntry,
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
  state.taskHistory.set(agentId, []);

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

  // Track findings lifecycle (#21)
  if (type === "review_bundle" && Array.isArray(parsedPayload)) {
    const now = Date.now();
    for (const finding of parsedPayload as Array<{ id?: string; category?: string }>) {
      if (finding.id) {
        state.findingTracker.set(finding.id, {
          findingId: finding.id,
          source: from,
          target: to,
          category: finding.category ?? "unknown",
          status: "open",
          round: task.round,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  if (type === "response" && Array.isArray(parsedPayload)) {
    const now = Date.now();
    for (const resp of parsedPayload as Array<{ findingId?: string; verdict?: string }>) {
      if (resp.findingId && state.findingTracker.has(resp.findingId)) {
        const entry = state.findingTracker.get(resp.findingId)!;
        entry.status = resp.verdict === "accept" ? "accepted"
          : resp.verdict === "reject" ? "rejected"
          : "discussing";
        entry.updatedAt = now;
      }
    }
  }

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
  const acked = queue.filter((task) => ackSet.has(task.id));
  const remaining = queue.filter((task) => !ackSet.has(task.id));
  state.taskQueues.set(agentId, remaining);

  // Archive acked tasks to history (bounded at 1000 per agent)
  const history = state.taskHistory.get(agentId) ?? [];
  history.push(...acked);
  if (history.length > 1000) history.splice(0, history.length - 1000);
  state.taskHistory.set(agentId, history);

  return textResult({ acknowledged: acked.length, remaining: remaining.length });
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
  state.taskHistory.delete(agentId);
  // findingTracker entries are NOT deleted — findings are cross-agent artifacts

  return textResult({ deregistered: true, agentId });
}

export function handleGetHistory(
  state: BrokerState,
  args: { agentId: string; type?: string; round?: number; limit?: number },
): ToolResult {
  const { agentId, type, round, limit = 50 } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  let history = state.taskHistory.get(agentId) ?? [];

  if (type) {
    history = history.filter((t) => t.type === type);
  }
  if (round !== undefined) {
    history = history.filter((t) => t.round === round);
  }

  const bounded = Math.min(limit, 1000);
  const sliced = history.slice(-bounded);

  return textResult({
    history: sliced,
    count: sliced.length,
    totalHistory: (state.taskHistory.get(agentId) ?? []).length,
  });
}

export function handleGetFindingStatus(
  state: BrokerState,
  args: { findingId?: string; agentId?: string; status?: string; round?: number },
): ToolResult {
  const { findingId, agentId, status, round } = args;

  // Single finding lookup
  if (findingId) {
    const entry = state.findingTracker.get(findingId);
    if (!entry) {
      return textResult({ error: "Finding not found", findingId });
    }
    return textResult({ finding: entry });
  }

  // Filtered listing
  let entries = [...state.findingTracker.values()];
  if (agentId) {
    entries = entries.filter((e) => e.source === agentId || e.target === agentId);
  }
  if (status) {
    entries = entries.filter((e) => e.status === status);
  }
  if (round !== undefined) {
    entries = entries.filter((e) => e.round === round);
  }

  const byStatus: Record<string, number> = {};
  for (const e of entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  }

  return textResult({
    findings: entries,
    count: entries.length,
    byStatus,
  });
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

export function handleGenerateSynthesis(
  state: BrokerState,
  args: { agentId: string },
): ToolResult {
  const { agentId } = args;

  if (!state.agents.has(agentId)) {
    return textResult({ error: "Agent not registered", agentId });
  }

  const agent = state.agents.get(agentId)!;

  // Gather all tasks across all agents (history, round archives, and current queues)
  const allTasks: Task[] = [];
  for (const [, tasks] of state.taskHistory) allTasks.push(...tasks);
  for (const [, rounds] of state.roundHistory) allTasks.push(...rounds.flat());
  for (const [, queue] of state.taskQueues) allTasks.push(...queue);

  // Find review_bundles targeting this agent (findings about this agent's project)
  const reviewBundles = allTasks.filter((t) => t.type === "review_bundle" && t.to === agentId);
  const findings: Array<{ id: string; category: string; description: string; from: string }> = [];
  for (const bundle of reviewBundles) {
    if (Array.isArray(bundle.payload)) {
      for (const f of bundle.payload as Array<{ id?: string; category?: string; description?: string }>) {
        if (f.id) {
          findings.push({ id: f.id, category: f.category ?? "unknown", description: f.description ?? "", from: bundle.from });
        }
      }
    }
  }

  // Find responses sent by this agent (verdicts on findings about this project)
  const responses = allTasks.filter((t) => t.type === "response" && t.from === agentId);
  const verdictMap = new Map<string, { verdict: string; evidence: string }>();
  for (const resp of responses) {
    if (Array.isArray(resp.payload)) {
      for (const r of resp.payload as Array<{ findingId?: string; verdict?: string; evidence?: string }>) {
        if (r.findingId) {
          verdictMap.set(r.findingId, { verdict: r.verdict ?? "discuss", evidence: r.evidence ?? "" });
        }
      }
    }
  }

  // Classify findings
  const accepted: Array<{ findingId: string; category: string; description: string; action: string }> = [];
  const rejected: Array<{ findingId: string; category: string; description: string; reason: string }> = [];
  const discussing: Array<{ findingId: string; category: string; description: string }> = [];

  for (const finding of findings) {
    const verdict = verdictMap.get(finding.id);
    if (!verdict) {
      discussing.push({ findingId: finding.id, category: finding.category, description: finding.description });
    } else if (verdict.verdict === "accept") {
      accepted.push({ findingId: finding.id, category: finding.category, description: finding.description, action: "TODO" });
    } else if (verdict.verdict === "reject") {
      rejected.push({ findingId: finding.id, category: finding.category, description: finding.description, reason: verdict.evidence });
    } else {
      discussing.push({ findingId: finding.id, category: finding.category, description: finding.description });
    }
  }

  return textResult({
    agentId,
    project: agent.project,
    draft: { accepted, rejected, discussing },
    findingsProcessed: findings.length,
    responsesProcessed: verdictMap.size,
    hint: "Edit accepted[].action and rejected[].reason, then send as synthesis task",
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

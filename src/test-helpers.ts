/**
 * Test helpers for cross-review-mcp broker tests.
 *
 * Since the broker uses module-level mutable state, each test file
 * must import the broker state and reset it between tests. These
 * helpers provide a clean interface for that.
 */

import type { BrokerState, Phase } from "./types.js";

/**
 * Create a fresh broker state for testing.
 */
export function createFreshState(): BrokerState {
  return {
    agents: new Map(),
    phases: new Map(),
    taskQueues: new Map(),
    phaseWaiters: new Map(),
    sentTaskTypes: new Map(),
    skillEvolution: new Map(),
    rounds: new Map(),
    roundHistory: new Map(),
  };
}

/**
 * Register an agent directly in state (bypasses the MCP tool layer).
 * Useful for setting up preconditions without going through the full tool call.
 */
export function registerAgent(
  state: BrokerState,
  agentId: string,
  project = "test-project",
  capabilities = ["review"],
): void {
  state.agents.set(agentId, {
    agentId,
    project,
    capabilities,
    registeredAt: Date.now(),
  });
  state.phases.set(agentId, "registered");
  state.taskQueues.set(agentId, []);
  state.phaseWaiters.set(agentId, []);
  state.sentTaskTypes.set(agentId, new Set());
  state.rounds.set(agentId, 0);
  state.roundHistory.set(agentId, []);
}

/**
 * Set an agent's phase directly (bypasses precondition checks).
 * Useful for testing downstream behavior that requires a specific phase.
 */
export function setPhase(state: BrokerState, agentId: string, phase: Phase): void {
  state.phases.set(agentId, phase);
}

/**
 * Mark that an agent has sent a specific task type (bypasses send_task).
 * Useful for satisfying phase preconditions without constructing full payloads.
 */
export function markSentType(state: BrokerState, agentId: string, type: string): void {
  const sent = state.sentTaskTypes.get(agentId);
  if (sent) sent.add(type as any);
}

/**
 * Build a minimal valid Finding array of the given size.
 */
export function makeFindingsPayload(count: number): object[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `finding-${i}`,
    category: "bug_risk",
    targetFile: "src/server.ts",
    description: `Test finding ${i}`,
    evidence: `Evidence for finding ${i}`,
  }));
}

/**
 * Build a minimal valid FindingResponse array.
 */
export function makeResponsePayload(count: number): object[] {
  return Array.from({ length: count }, (_, i) => ({
    findingId: `finding-${i}`,
    verdict: "accept",
    evidence: `Response evidence ${i}`,
  }));
}

/**
 * Build a minimal valid SkillPackage payload.
 */
export function makeSkillPackagePayload(
  skillId = "skill-001",
  artifactCount = 2,
  evolutionRound = 0,
): object {
  return {
    skillId,
    name: `Test Skill ${skillId}`,
    description: "A test skill package",
    artifacts: Array.from({ length: artifactCount }, (_, i) => ({
      filename: i === 0 ? "index.ts" : `helper-${i}.ts`,
      content: `// artifact ${i}`,
      role: i === 0 ? "entry" : "helper",
    })),
    evolutionRound,
  };
}

/**
 * Build a minimal valid SkillVerification payload.
 */
export function makeSkillVerificationPayload(
  skillId = "skill-001",
  pass = true,
  score = 0.85,
): object {
  return {
    skillId,
    pass,
    score,
    feedback: pass ? "Skill meets requirements" : "Skill needs improvement",
    testCases: [
      { input: "test input", expectedBehavior: "expected output", passed: pass },
    ],
  };
}

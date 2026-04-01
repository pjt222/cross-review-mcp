import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import {
  handleDeregister,
  handleGetStatus,
  handleWaitForPhase,
  handleSignalPhase,
  handleSendTask,
} from "./broker.js";
import {
  createFreshState,
  registerAgent,
  markSentType,
  setPhase,
} from "./test-helpers.js";

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleDeregister", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
  });

  it("successfully deregisters an existing agent", () => {
    registerAgent(state, "agent-a");
    const result = parseResult(handleDeregister(state, { agentId: "agent-a" }));
    expect(result.deregistered).toBe(true);
    expect(result.agentId).toBe("agent-a");
  });

  it("cleans up all state maps after deregister", () => {
    registerAgent(state, "agent-a");
    handleDeregister(state, { agentId: "agent-a" });
    expect(state.agents.has("agent-a")).toBe(false);
    expect(state.phases.has("agent-a")).toBe(false);
    expect(state.taskQueues.has("agent-a")).toBe(false);
    expect(state.phaseWaiters.has("agent-a")).toBe(false);
    expect(state.sentTaskTypes.has("agent-a")).toBe(false);
  });

  it("resolves PhaseWaiters targeting deregistered agent with reached: false", async () => {
    registerAgent(state, "agent-a");
    registerAgent(state, "agent-b");

    const waitPromise = handleWaitForPhase(
      state,
      { peerId: "agent-a", phase: "briefing" },
      5000,
    );

    handleDeregister(state, { agentId: "agent-a" });

    const result = parseResult(await waitPromise);
    expect(result.reached).toBe(false);
  });

  it("returns error when deregistering unregistered agent", () => {
    const result = parseResult(handleDeregister(state, { agentId: "nonexistent" }));
    expect(result.error).toBe("Agent not registered");
    expect(result.agentId).toBe("nonexistent");
  });

  it("deregistered agent no longer appears in get_status", () => {
    registerAgent(state, "agent-a");
    registerAgent(state, "agent-b");
    handleDeregister(state, { agentId: "agent-a" });

    const result = parseResult(handleGetStatus(state));
    expect(result.agentCount).toBe(1);
    expect(result.agents["agent-a"]).toBeUndefined();
    expect(result.agents["agent-b"]).toBeDefined();
  });

  it("re-registration after deregister creates fresh state", () => {
    registerAgent(state, "agent-a");
    state.phases.set("agent-a", "briefing");
    handleDeregister(state, { agentId: "agent-a" });

    // Re-register — should be treated as new, not idempotent reconnect
    registerAgent(state, "agent-a");
    expect(state.phases.get("agent-a")).toBe("registered");
    expect(state.taskQueues.get("agent-a")).toEqual([]);
    expect(state.sentTaskTypes.get("agent-a")).toEqual(new Set());
  });

  it("tasks from deregistered agent remain in other agents' queues", () => {
    registerAgent(state, "agent-a");
    registerAgent(state, "agent-b");

    handleSendTask(state, {
      from: "agent-a",
      to: "agent-b",
      type: "briefing",
      payload: JSON.stringify({
        project: "proj-a",
        language: "ts",
        entryPoints: [],
        dependencyGraph: {},
        patterns: [],
        knownIssues: [],
        testCoverage: { hasTests: false },
      }),
    });

    handleDeregister(state, { agentId: "agent-a" });

    const agentBQueue = state.taskQueues.get("agent-b") ?? [];
    expect(agentBQueue.length).toBe(1);
    expect(agentBQueue[0].from).toBe("agent-a");
    expect(agentBQueue[0].type).toBe("briefing");
  });

  it("allows 'complete' phase with <2 agents after peer deregisters", () => {
    registerAgent(state, "agent-a");
    registerAgent(state, "agent-b");

    // Advance agent-a through the protocol
    markSentType(state, "agent-a", "briefing");
    markSentType(state, "agent-a", "review_bundle");
    setPhase(state, "agent-a", "dialogue");

    // Peer deregisters
    handleDeregister(state, { agentId: "agent-b" });

    // agent-a should still be able to signal complete
    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "complete" }));
    expect(result.phaseUpdated).toBe(true);
    expect(result.phase).toBe("complete");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import { MIN_BANDWIDTH } from "./types.js";
import {
  handleRegister,
  handleGetStatus,
  handleWaitForPhase,
  notifyPhaseWaiters,
} from "./broker.js";
import {
  createFreshState,
  registerAgent,
  setPhase,
} from "./test-helpers.js";
import { handleSendTask } from "./broker.js";

function parseResult(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleRegister", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
  });

  it("successfully registers a new agent", () => {
    const result = parseResult(
      handleRegister(state, {
        agentId: "agent-a",
        project: "my-project",
        capabilities: ["review"],
      }),
    );

    expect(result.registered).toBe(true);
    expect(result.agentId).toBe("agent-a");
    expect(result.project).toBe("my-project");
    expect(result.peers).toEqual([]);
    expect(result.minBandwidth).toBe(MIN_BANDWIDTH);
  });

  it("rejects duplicate registration", () => {
    handleRegister(state, {
      agentId: "agent-a",
      project: "proj",
      capabilities: [],
    });

    const result = parseResult(
      handleRegister(state, {
        agentId: "agent-a",
        project: "proj",
        capabilities: [],
      }),
    );

    expect(result.error).toBe("Agent already registered");
    expect(result.agentId).toBe("agent-a");
  });

  it("second registration sees first agent in peers list", () => {
    handleRegister(state, {
      agentId: "agent-a",
      project: "proj-a",
      capabilities: ["review"],
    });

    const result = parseResult(
      handleRegister(state, {
        agentId: "agent-b",
        project: "proj-b",
        capabilities: ["review"],
      }),
    );

    expect(result.registered).toBe(true);
    expect(result.peers).toEqual(["agent-a"]);
    expect(result.peerCount).toBe(2);
  });

  it("initializes all state maps correctly", () => {
    handleRegister(state, {
      agentId: "agent-a",
      project: "proj",
      capabilities: ["review"],
    });

    expect(state.agents.has("agent-a")).toBe(true);
    expect(state.phases.get("agent-a")).toBe("registered");
    expect(state.taskQueues.get("agent-a")).toEqual([]);
    expect(state.phaseWaiters.get("agent-a")).toEqual([]);
    expect(state.sentTaskTypes.get("agent-a")).toEqual(new Set());
  });
});

describe("handleGetStatus", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
  });

  it("empty broker returns agentCount 0 and empty agents", () => {
    const result = parseResult(handleGetStatus(state));

    expect(result.agentCount).toBe(0);
    expect(result.agents).toEqual({});
  });

  it("shows correct info after registering 2 agents", () => {
    registerAgent(state, "agent-a", "proj-a");
    registerAgent(state, "agent-b", "proj-b");

    const result = parseResult(handleGetStatus(state));

    expect(result.agentCount).toBe(2);
    expect(result.agents["agent-a"].project).toBe("proj-a");
    expect(result.agents["agent-a"].phase).toBe("registered");
    expect(result.agents["agent-a"].pendingTasks).toBe(0);
    expect(result.agents["agent-b"].project).toBe("proj-b");
    expect(result.agents["agent-b"].phase).toBe("registered");
    expect(result.agents["agent-b"].pendingTasks).toBe(0);
  });

  it("pendingTasks reflects queue length after sending tasks", () => {
    registerAgent(state, "agent-a", "proj-a");
    registerAgent(state, "agent-b", "proj-b");

    handleSendTask(state, {
      from: "agent-a",
      to: "agent-b",
      type: "briefing",
      payload: JSON.stringify({ project: "proj-a", language: "ts", entryPoints: [], dependencyGraph: {}, patterns: [], knownIssues: [], testCoverage: { hasTests: false } }),
    });

    const result = parseResult(handleGetStatus(state));

    expect(result.agents["agent-b"].pendingTasks).toBe(1);
    expect(result.agents["agent-a"].pendingTasks).toBe(0);
  });

  it("minBandwidth value is 5", () => {
    const result = parseResult(handleGetStatus(state));
    expect(result.minBandwidth).toBe(5);
  });
});

describe("handleWaitForPhase", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
  });

  it("returns immediately if peer is already at target phase", async () => {
    registerAgent(state, "agent-a");
    setPhase(state, "agent-a", "briefing");

    const result = parseResult(
      await handleWaitForPhase(state, { peerId: "agent-a", phase: "briefing" }),
    );

    expect(result.reached).toBe(true);
    expect(result.peerId).toBe("agent-a");
    expect(result.currentPhase).toBe("briefing");
  });

  it("returns immediately if peer is past target phase", async () => {
    registerAgent(state, "agent-a");
    setPhase(state, "agent-a", "review");

    const result = parseResult(
      await handleWaitForPhase(state, { peerId: "agent-a", phase: "briefing" }),
    );

    expect(result.reached).toBe(true);
    expect(result.phase).toBe("briefing");
    expect(result.currentPhase).toBe("review");
  });

  it("returns error for unregistered peerId", async () => {
    const result = parseResult(
      await handleWaitForPhase(state, { peerId: "nonexistent", phase: "briefing" }),
    );

    expect(result.error).toBe("Peer not registered");
    expect(result.peerId).toBe("nonexistent");
  });

  it("blocks then resolves when peer reaches target phase", async () => {
    registerAgent(state, "agent-b");

    const waitPromise = handleWaitForPhase(
      state,
      { peerId: "agent-b", phase: "briefing" },
      500,
    );

    state.phases.set("agent-b", "briefing");
    notifyPhaseWaiters(state, "agent-b", "briefing");

    const result = parseResult(await waitPromise);

    expect(result.reached).toBe(true);
    expect(result.peerId).toBe("agent-b");
    expect(result.phase).toBe("briefing");
    expect(result.timedOut).toBe(false);
  });

  it("times out and returns reached: false with short timeout", async () => {
    registerAgent(state, "agent-b");

    const result = parseResult(
      await handleWaitForPhase(state, { peerId: "agent-b", phase: "complete" }, 50),
    );

    expect(result.reached).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.peerId).toBe("agent-b");
  });
});

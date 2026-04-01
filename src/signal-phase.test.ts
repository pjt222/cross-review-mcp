import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState, Phase } from "./types.js";
import { createFreshState, registerAgent, markSentType, setPhase } from "./test-helpers.js";
import { handleSignalPhase, notifyPhaseWaiters } from "./broker.js";

function parseResult(result: ReturnType<typeof handleSignalPhase>): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe("handleSignalPhase", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
  });

  it("successfully advances registered → briefing with 2 agents and briefing sent", () => {
    registerAgent(state, "agent-a", "project-a");
    registerAgent(state, "agent-b", "project-b");
    markSentType(state, "agent-a", "briefing");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "briefing" }));

    expect(result.phaseUpdated).toBe(true);
    expect(result.agentId).toBe("agent-a");
    expect(result.phase).toBe("briefing");
    expect(state.phases.get("agent-a")).toBe("briefing");
  });

  it("rejects backward phase movement (review → briefing)", () => {
    registerAgent(state, "agent-a", "project-a");
    registerAgent(state, "agent-b", "project-b");
    setPhase(state, "agent-a", "review");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "briefing" }));

    expect(result.error).toBe("Cannot move backward in phase lifecycle");
    expect(result.current).toBe("review");
    expect(result.requested).toBe("briefing");
    expect(state.phases.get("agent-a")).toBe("review");
  });

  it("rejects same-phase signal (briefing → briefing)", () => {
    registerAgent(state, "agent-a", "project-a");
    registerAgent(state, "agent-b", "project-b");
    setPhase(state, "agent-a", "briefing");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "briefing" }));

    expect(result.error).toBe("Cannot move backward in phase lifecycle");
    expect(result.current).toBe("briefing");
    expect(result.requested).toBe("briefing");
  });

  it("rejects review without prior briefing sent", () => {
    registerAgent(state, "agent-a", "project-a");
    registerAgent(state, "agent-b", "project-b");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "review" }));

    expect(result.error).toBe("Cannot enter review phase without sending a briefing first");
    expect(result.hint).toContain("briefing");
  });

  it("rejects dialogue without prior review_bundle sent", () => {
    registerAgent(state, "agent-a", "project-a");
    registerAgent(state, "agent-b", "project-b");
    markSentType(state, "agent-a", "briefing");
    setPhase(state, "agent-a", "review");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "dialogue" }));

    expect(result.error).toBe("Cannot enter dialogue phase without sending a review bundle first");
    expect(result.hint).toContain("review_bundle");
  });

  it("rejects phase advance with only 1 registered agent", () => {
    registerAgent(state, "agent-a", "project-a");
    markSentType(state, "agent-a", "briefing");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "briefing" }));

    expect(result.error).toBe("Cannot advance phase with fewer than 2 registered agents");
    expect(result.registered).toBe(1);
    expect(result.required).toBe(2);
  });

  it("rejects signal from unregistered agent", () => {
    const result = parseResult(handleSignalPhase(state, { agentId: "ghost", phase: "briefing" }));

    expect(result.error).toBe("Agent not registered");
  });

  it("reports peerPhases correctly after successful phase change", () => {
    registerAgent(state, "agent-a", "project-a");
    registerAgent(state, "agent-b", "project-b");
    registerAgent(state, "agent-c", "project-c");
    markSentType(state, "agent-a", "briefing");
    setPhase(state, "agent-b", "briefing");
    setPhase(state, "agent-c", "review");

    const result = parseResult(handleSignalPhase(state, { agentId: "agent-a", phase: "briefing" }));

    expect(result.phaseUpdated).toBe(true);
    const peerPhases = result.peerPhases as Record<string, Phase>;
    expect(peerPhases["agent-b"]).toBe("briefing");
    expect(peerPhases["agent-c"]).toBe("review");
    expect(peerPhases).not.toHaveProperty("agent-a");
  });
});

describe("notifyPhaseWaiters", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
  });

  it("resolves waiting promises when phase advances", async () => {
    registerAgent(state, "agent-a", "project-a");

    const waitPromise = new Promise<{ reached: boolean }>((resolve) => {
      const waiters = state.phaseWaiters.get("agent-a")!;
      waiters.push({ targetPhase: "briefing", resolve });
    });

    notifyPhaseWaiters(state, "agent-a", "briefing");

    const result = await waitPromise;
    expect(result.reached).toBe(true);
    expect(state.phaseWaiters.get("agent-a")).toHaveLength(0);
  });

  it("leaves non-matching waiters in place", () => {
    registerAgent(state, "agent-a", "project-a");

    let briefingResolved = false;
    let reviewResolved = false;

    const waiters = state.phaseWaiters.get("agent-a")!;
    waiters.push({
      targetPhase: "briefing",
      resolve: () => { briefingResolved = true; },
    });
    waiters.push({
      targetPhase: "review",
      resolve: () => { reviewResolved = true; },
    });

    notifyPhaseWaiters(state, "agent-a", "briefing");

    expect(briefingResolved).toBe(true);
    expect(reviewResolved).toBe(false);

    const remaining = state.phaseWaiters.get("agent-a")!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].targetPhase).toBe("review");
  });
});

/**
 * Tests for multi-round review support (issues #13, #14, #18).
 *
 * Covers: reset_round lifecycle, round tracking, task archiving,
 * phase reset, sentTaskTypes clearing, and get_status round info.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import {
  handleSendTask,
  handleSignalPhase,
  handleGetStatus,
  handleResetRound,
  handlePollTasks,
} from "./broker.js";
import {
  createFreshState,
  registerAgent,
  setPhase,
  markSentType,
  makeFindingsPayload,
  makeResponsePayload,
} from "./test-helpers.js";

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleResetRound", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("resets round from complete phase", () => {
    setPhase(state, "alice", "complete");

    const result = parse(handleResetRound(state, { agentId: "alice" }));

    expect(result.roundReset).toBe(true);
    expect(result.previousRound).toBe(0);
    expect(result.newRound).toBe(1);
    expect(state.phases.get("alice")).toBe("registered");
    expect(state.rounds.get("alice")).toBe(1);
  });

  it("fails when not in complete phase", () => {
    setPhase(state, "alice", "dialogue");

    const result = parse(handleResetRound(state, { agentId: "alice" }));

    expect(result.error).toMatch(/complete phase/);
    expect(result.currentPhase).toBe("dialogue");
  });

  it("fails for unregistered agent", () => {
    const result = parse(handleResetRound(state, { agentId: "unknown" }));
    expect(result.error).toMatch(/not registered/);
  });

  it("archives current tasks on reset", async () => {
    // Send a task to alice, then reset
    markSentType(state, "bob", "briefing");
    setPhase(state, "bob", "review");
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    setPhase(state, "alice", "complete");
    const result = parse(handleResetRound(state, { agentId: "alice" }));

    expect(result.archivedTasks).toBe(1);
    // Task queue should be empty after reset
    const poll = parse(await handlePollTasks(state, { agentId: "alice" }));
    expect(poll.count).toBe(0);
    // History should contain the archived round
    expect(state.roundHistory.get("alice")!.length).toBe(1);
    expect(state.roundHistory.get("alice")![0].length).toBe(1);
  });

  it("clears sentTaskTypes on reset", () => {
    markSentType(state, "alice", "briefing");
    markSentType(state, "alice", "review_bundle");
    markSentType(state, "alice", "response");
    setPhase(state, "alice", "complete");

    handleResetRound(state, { agentId: "alice" });

    // sentTaskTypes should be empty
    expect(state.sentTaskTypes.get("alice")!.size).toBe(0);
  });

  it("allows full lifecycle after reset", () => {
    // Complete round 0
    setPhase(state, "alice", "complete");
    handleResetRound(state, { agentId: "alice" });

    // Now alice is back at registered, can advance through phases again
    expect(state.phases.get("alice")).toBe("registered");

    // Signal briefing phase (needs 2 agents and a sent briefing)
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "test" }),
    });
    const phaseResult = parse(handleSignalPhase(state, { agentId: "alice", phase: "briefing" }));
    expect(phaseResult.phaseUpdated).toBe(true);
    expect(state.phases.get("alice")).toBe("briefing");
  });

  it("increments round counter on successive resets", () => {
    setPhase(state, "alice", "complete");
    handleResetRound(state, { agentId: "alice" });
    expect(state.rounds.get("alice")).toBe(1);

    setPhase(state, "alice", "complete");
    handleResetRound(state, { agentId: "alice" });
    expect(state.rounds.get("alice")).toBe(2);

    setPhase(state, "alice", "complete");
    handleResetRound(state, { agentId: "alice" });
    expect(state.rounds.get("alice")).toBe(3);

    expect(state.roundHistory.get("alice")!.length).toBe(3);
  });
});

describe("task round tagging", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("tags tasks with sender's current round", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "test" }),
    });

    const tasks = state.taskQueues.get("bob")!;
    expect(tasks[0].round).toBe(0);
  });

  it("tags tasks with round 1 after reset", () => {
    setPhase(state, "alice", "complete");
    handleResetRound(state, { agentId: "alice" });

    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "test" }),
    });

    const tasks = state.taskQueues.get("bob")!;
    expect(tasks[0].round).toBe(1);
  });
});

describe("get_status includes round info", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("shows round 0 for newly registered agents", () => {
    const result = parse(handleGetStatus(state));
    expect(result.agents.alice.round).toBe(0);
    expect(result.agents.bob.round).toBe(0);
  });

  it("shows updated round after reset", () => {
    setPhase(state, "alice", "complete");
    handleResetRound(state, { agentId: "alice" });

    const result = parse(handleGetStatus(state));
    expect(result.agents.alice.round).toBe(1);
    expect(result.agents.bob.round).toBe(0);
  });
});

describe("full multi-round session", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("runs two complete review rounds", () => {
    // === Round 0 ===
    // Briefing
    handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: "a" }) });
    handleSendTask(state, { from: "bob", to: "alice", type: "briefing", payload: JSON.stringify({ project: "b" }) });
    handleSignalPhase(state, { agentId: "alice", phase: "briefing" });
    handleSignalPhase(state, { agentId: "bob", phase: "briefing" });

    // Review
    handleSendTask(state, { from: "alice", to: "bob", type: "review_bundle", payload: JSON.stringify(makeFindingsPayload(5)) });
    handleSendTask(state, { from: "bob", to: "alice", type: "review_bundle", payload: JSON.stringify(makeFindingsPayload(5)) });
    handleSignalPhase(state, { agentId: "alice", phase: "review" });
    handleSignalPhase(state, { agentId: "bob", phase: "review" });

    // Dialogue
    handleSendTask(state, { from: "alice", to: "bob", type: "response", payload: JSON.stringify(makeResponsePayload(3)) });
    handleSendTask(state, { from: "bob", to: "alice", type: "response", payload: JSON.stringify(makeResponsePayload(3)) });
    handleSignalPhase(state, { agentId: "alice", phase: "dialogue" });
    handleSignalPhase(state, { agentId: "bob", phase: "dialogue" });

    // Synthesis
    handleSendTask(state, { from: "alice", to: "bob", type: "synthesis", payload: JSON.stringify({ agentId: "alice", project: "a", accepted: [], rejected: [] }) });
    handleSendTask(state, { from: "bob", to: "alice", type: "synthesis", payload: JSON.stringify({ agentId: "bob", project: "b", accepted: [], rejected: [] }) });
    handleSignalPhase(state, { agentId: "alice", phase: "synthesis" });
    handleSignalPhase(state, { agentId: "bob", phase: "synthesis" });

    // Complete
    handleSignalPhase(state, { agentId: "alice", phase: "complete" });
    handleSignalPhase(state, { agentId: "bob", phase: "complete" });

    expect(state.phases.get("alice")).toBe("complete");
    expect(state.phases.get("bob")).toBe("complete");

    // === Reset both for Round 1 ===
    const resetA = parse(handleResetRound(state, { agentId: "alice" }));
    const resetB = parse(handleResetRound(state, { agentId: "bob" }));
    expect(resetA.newRound).toBe(1);
    expect(resetB.newRound).toBe(1);

    // === Round 1 — new topic ===
    handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: "a-v2" }) });
    handleSendTask(state, { from: "bob", to: "alice", type: "briefing", payload: JSON.stringify({ project: "b-v2" }) });
    handleSignalPhase(state, { agentId: "alice", phase: "briefing" });
    handleSignalPhase(state, { agentId: "bob", phase: "briefing" });

    // Verify round 1 tasks are tagged correctly
    const bobTasks = state.taskQueues.get("bob")!;
    const round1Tasks = bobTasks.filter(t => t.round === 1);
    expect(round1Tasks.length).toBeGreaterThan(0);

    // Status shows round 1
    const status = parse(handleGetStatus(state));
    expect(status.agents.alice.round).toBe(1);
    expect(status.agents.bob.round).toBe(1);
    expect(status.agents.alice.phase).toBe("briefing");
  });
});

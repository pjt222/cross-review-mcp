/**
 * Tests for task history and audit trail (issue #20).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import {
  handleSendTask,
  handlePollTasks,
  handleAckTasks,
  handleGetHistory,
  handleDeregister,
} from "./broker.js";
import {
  createFreshState,
  registerAgent,
} from "./test-helpers.js";

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleGetHistory", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("returns empty history for new agent", () => {
    const result = parse(handleGetHistory(state, { agentId: "alice" }));
    expect(result.count).toBe(0);
    expect(result.history).toEqual([]);
  });

  it("acked tasks appear in history", async () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "a" }),
    });

    const poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: [poll.tasks[0].id] });

    const history = parse(handleGetHistory(state, { agentId: "bob" }));
    expect(history.count).toBe(1);
    expect(history.history[0].type).toBe("briefing");
  });

  it("queue is still drained on ack", async () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "a" }),
    });

    const poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: [poll.tasks[0].id] });

    const afterAck = parse(await handlePollTasks(state, { agentId: "bob" }));
    expect(afterAck.count).toBe(0);
  });

  it("filters by type", async () => {
    handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: "a" }) });
    handleSendTask(state, { from: "alice", to: "bob", type: "question", payload: JSON.stringify({ id: "q1", aboutFile: "x.ts", question: "why?" }) });

    const poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: poll.tasks.map((t: { id: string }) => t.id) });

    const briefings = parse(handleGetHistory(state, { agentId: "bob", type: "briefing" }));
    expect(briefings.count).toBe(1);

    const questions = parse(handleGetHistory(state, { agentId: "bob", type: "question" }));
    expect(questions.count).toBe(1);
  });

  it("filters by round", async () => {
    handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: "a" }) });

    const poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: [poll.tasks[0].id] });

    const round0 = parse(handleGetHistory(state, { agentId: "bob", round: 0 }));
    expect(round0.count).toBe(1);

    const round1 = parse(handleGetHistory(state, { agentId: "bob", round: 1 }));
    expect(round1.count).toBe(0);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: `a-${i}` }) });
    }
    const poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: poll.tasks.map((t: { id: string }) => t.id) });

    const limited = parse(handleGetHistory(state, { agentId: "bob", limit: 2 }));
    expect(limited.count).toBe(2);
    expect(limited.totalHistory).toBe(5);
  });

  it("multiple ack calls accumulate in history", async () => {
    handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: "a" }) });
    let poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: [poll.tasks[0].id] });

    handleSendTask(state, { from: "alice", to: "bob", type: "question", payload: JSON.stringify({ id: "q1", aboutFile: "x", question: "why?" }) });
    poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: [poll.tasks[0].id] });

    const history = parse(handleGetHistory(state, { agentId: "bob" }));
    expect(history.count).toBe(2);
  });

  it("errors for unregistered agent", () => {
    const result = parse(handleGetHistory(state, { agentId: "unknown" }));
    expect(result.error).toMatch(/not registered/);
  });

  it("deregister cleans up history", async () => {
    handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload: JSON.stringify({ project: "a" }) });
    const poll = parse(await handlePollTasks(state, { agentId: "bob" }));
    handleAckTasks(state, { agentId: "bob", taskIds: [poll.tasks[0].id] });

    handleDeregister(state, { agentId: "bob" });
    expect(state.taskHistory.has("bob")).toBe(false);
  });
});

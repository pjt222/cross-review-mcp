/**
 * Tests for long-poll task delivery (issue #17).
 *
 * Covers: backward-compatible immediate return, long-poll blocking,
 * resolution on task arrival, timeout, deregister cleanup.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import {
  handleSendTask,
  handlePollTasks,
  handleDeregister,
} from "./broker.js";
import {
  createFreshState,
  registerAgent,
} from "./test-helpers.js";

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("poll_tasks backward compatibility", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("returns immediately with no timeout", async () => {
    const result = parse(await handlePollTasks(state, { agentId: "alice" }));
    expect(result.count).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  it("returns immediately with timeout=0", async () => {
    const result = parse(await handlePollTasks(state, { agentId: "alice", timeout: 0 }));
    expect(result.count).toBe(0);
  });

  it("returns immediately when tasks exist even with timeout", async () => {
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "briefing",
      payload: JSON.stringify({ project: "b" }),
    });

    const result = parse(await handlePollTasks(state, { agentId: "alice", timeout: 5000 }));
    expect(result.count).toBe(1);
  });

  it("errors for unregistered agent", async () => {
    const result = parse(await handlePollTasks(state, { agentId: "unknown" }));
    expect(result.error).toMatch(/not registered/);
  });
});

describe("poll_tasks long-polling", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("blocks then resolves when task arrives", async () => {
    // Start long-poll with 5s timeout
    const pollPromise = handlePollTasks(state, { agentId: "alice", timeout: 5000 });

    // Verify waiter was registered
    expect(state.taskWaiters.get("alice")!.length).toBe(1);

    // Send a task to alice — should resolve the waiter
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "briefing",
      payload: JSON.stringify({ project: "b" }),
    });

    const result = parse(await pollPromise);
    expect(result.count).toBe(1);
    expect(result.tasks[0].from).toBe("bob");

    // Waiter should be cleaned up
    expect(state.taskWaiters.get("alice")!.length).toBe(0);
  });

  it("times out and returns empty when no task arrives", async () => {
    const result = parse(await handlePollTasks(state, { agentId: "alice", timeout: 50 }));
    expect(result.count).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  it("multiple concurrent waiters all resolve", async () => {
    const poll1 = handlePollTasks(state, { agentId: "alice", timeout: 5000 });
    const poll2 = handlePollTasks(state, { agentId: "alice", timeout: 5000 });

    expect(state.taskWaiters.get("alice")!.length).toBe(2);

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "briefing",
      payload: JSON.stringify({ project: "b" }),
    });

    const [result1, result2] = await Promise.all([poll1, poll2]);
    expect(parse(result1).count).toBe(1);
    expect(parse(result2).count).toBe(1);
  });

  it("deregistration resolves pending waiters with empty result", async () => {
    const pollPromise = handlePollTasks(state, { agentId: "alice", timeout: 5000 });
    expect(state.taskWaiters.get("alice")!.length).toBe(1);

    handleDeregister(state, { agentId: "alice" });

    const result = parse(await pollPromise);
    expect(result.count).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  it("waiter cleanup after timeout leaves no leaks", async () => {
    await handlePollTasks(state, { agentId: "alice", timeout: 50 });
    // After timeout, waiter list should be empty
    expect(state.taskWaiters.get("alice")!.length).toBe(0);
  });
});

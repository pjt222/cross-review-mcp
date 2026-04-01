import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import { handleSendTask, handlePollTasks, handleAckTasks } from "./broker.js";
import {
  createFreshState,
  registerAgent,
  makeFindingsPayload,
  makeResponsePayload,
} from "./test-helpers.js";

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleSendTask", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "project-a");
    registerAgent(state, "bob", "project-b");
  });

  it("successfully sends a briefing between two registered agents", () => {
    const payload = JSON.stringify({
      project: "project-a",
      language: "TypeScript",
      entryPoints: ["src/index.ts"],
      dependencyGraph: {},
      patterns: [],
      knownIssues: [],
      testCoverage: { hasTests: true },
    });

    const result = parse(
      handleSendTask(state, { from: "alice", to: "bob", type: "briefing", payload }),
    );

    expect(result.sent).toBe(true);
    expect(result.from).toBe("alice");
    expect(result.to).toBe("bob");
    expect(result.type).toBe("briefing");
    expect(result.taskId).toBeDefined();
  });

  it("rejects send from unregistered sender", () => {
    const result = parse(
      handleSendTask(state, {
        from: "unknown",
        to: "bob",
        type: "briefing",
        payload: JSON.stringify({}),
      }),
    );

    expect(result.error).toMatch(/Sender not registered/);
  });

  it("rejects send to unregistered target", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "unknown",
        type: "briefing",
        payload: JSON.stringify({}),
      }),
    );

    expect(result.error).toMatch(/Target agent not registered/);
  });

  it("rejects self-send (from === to)", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "alice",
        type: "briefing",
        payload: JSON.stringify({}),
      }),
    );

    expect(result.error).toMatch(/Cannot send tasks to yourself/);
  });

  it("rejects invalid JSON payload", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "briefing",
        payload: "not valid json {{{",
      }),
    );

    expect(result.error).toMatch(/Invalid JSON payload/);
  });

  it("rejects review_bundle with fewer than 5 findings", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "review_bundle",
        payload: JSON.stringify(makeFindingsPayload(3)),
      }),
    );

    expect(result.error).toMatch(/at least 5 findings/);
    expect(result.received).toBe(3);
    expect(result.required).toBe(5);
  });

  it("rejects review_bundle with non-array payload", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "review_bundle",
        payload: JSON.stringify({ findings: makeFindingsPayload(5) }),
      }),
    );

    expect(result.error).toMatch(/at least 5 findings/);
    expect(result.received).toBe(0);
  });

  it("accepts review_bundle with exactly 5 findings", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "review_bundle",
        payload: JSON.stringify(makeFindingsPayload(5)),
      }),
    );

    expect(result.sent).toBe(true);
    expect(result.findingCount).toBe(5);
  });

  it("rejects response with empty array", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "response",
        payload: JSON.stringify([]),
      }),
    );

    expect(result.error).toMatch(/at least one FindingResponse/);
    expect(result.received).toBe(0);
  });

  it("rejects response with non-array payload", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "response",
        payload: JSON.stringify({ findingId: "f1", verdict: "accept", evidence: "ok" }),
      }),
    );

    expect(result.error).toMatch(/at least one FindingResponse/);
    expect(result.received).toBe(0);
  });

  it("accepts valid response with makeResponsePayload(2)", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "response",
        payload: JSON.stringify(makeResponsePayload(2)),
      }),
    );

    expect(result.sent).toBe(true);
    expect(result.from).toBe("alice");
    expect(result.to).toBe("bob");
    expect(result.type).toBe("response");
  });

  it("tracks sent task type in sentTaskTypes", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "a" }),
    });

    const sentTypes = state.sentTaskTypes.get("alice")!;
    expect(sentTypes.has("briefing")).toBe(true);
  });
});

describe("handlePollTasks", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "project-a");
    registerAgent(state, "bob", "project-b");
  });

  it("returns empty (count: 0) for newly registered agent", () => {
    const result = parse(handlePollTasks(state, { agentId: "alice" }));

    expect(result.count).toBe(0);
    expect(result.tasks).toEqual([]);
  });

  it("returns tasks after send_task delivers to the agent", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "project-a" }),
    });

    const result = parse(handlePollTasks(state, { agentId: "bob" }));

    expect(result.count).toBe(1);
    expect(result.tasks[0].from).toBe("alice");
    expect(result.tasks[0].to).toBe("bob");
    expect(result.tasks[0].type).toBe("briefing");
  });

  it("returns error for unregistered agent", () => {
    const result = parse(handlePollTasks(state, { agentId: "unknown" }));

    expect(result.error).toMatch(/Agent not registered/);
  });

  it("tasks persist across multiple polls (peek-not-drain semantics)", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "project-a" }),
    });

    const firstPoll = parse(handlePollTasks(state, { agentId: "bob" }));
    const secondPoll = parse(handlePollTasks(state, { agentId: "bob" }));

    expect(firstPoll.count).toBe(1);
    expect(secondPoll.count).toBe(1);
    expect(firstPoll.tasks[0].id).toBe(secondPoll.tasks[0].id);
  });
});

describe("handleAckTasks", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "project-a");
    registerAgent(state, "bob", "project-b");
  });

  it("removes specific tasks from queue, verified via poll", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "project-a" }),
    });

    const poll = parse(handlePollTasks(state, { agentId: "bob" }));
    const taskId = poll.tasks[0].id;

    const ackResult = parse(handleAckTasks(state, { agentId: "bob", taskIds: [taskId] }));
    expect(ackResult.acknowledged).toBe(1);
    expect(ackResult.remaining).toBe(0);

    const afterAck = parse(handlePollTasks(state, { agentId: "bob" }));
    expect(afterAck.count).toBe(0);
  });

  it("returns acknowledged: 0 for non-existent taskIds", () => {
    const result = parse(
      handleAckTasks(state, { agentId: "bob", taskIds: ["nonexistent-id"] }),
    );

    expect(result.acknowledged).toBe(0);
  });

  it("partial ack — send 2 tasks, ack 1, verify 1 remains", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "briefing",
      payload: JSON.stringify({ project: "a" }),
    });
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "question",
      payload: JSON.stringify({ id: "q1", aboutFile: "src/x.ts", question: "Why?" }),
    });

    const poll = parse(handlePollTasks(state, { agentId: "bob" }));
    expect(poll.count).toBe(2);

    const firstTaskId = poll.tasks[0].id;
    const ackResult = parse(
      handleAckTasks(state, { agentId: "bob", taskIds: [firstTaskId] }),
    );

    expect(ackResult.acknowledged).toBe(1);
    expect(ackResult.remaining).toBe(1);

    const afterAck = parse(handlePollTasks(state, { agentId: "bob" }));
    expect(afterAck.count).toBe(1);
    expect(afterAck.tasks[0].id).toBe(poll.tasks[1].id);
  });

  it("returns error for unregistered agent", () => {
    const result = parse(
      handleAckTasks(state, { agentId: "unknown", taskIds: ["some-id"] }),
    );

    expect(result.error).toMatch(/Agent not registered/);
  });
});

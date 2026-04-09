/**
 * Tests for structured synthesis generation (issue #15).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import {
  handleSendTask,
  handlePollTasks,
  handleAckTasks,
  handleGenerateSynthesis,
} from "./broker.js";
import {
  createFreshState,
  registerAgent,
  makeFindingsPayload,
  makeResponsePayload,
} from "./test-helpers.js";

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleGenerateSynthesis", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("returns empty draft when no history exists", () => {
    const result = parse(handleGenerateSynthesis(state, { agentId: "alice" }));

    expect(result.project).toBe("/project-a");
    expect(result.draft.accepted).toEqual([]);
    expect(result.draft.rejected).toEqual([]);
    expect(result.draft.discussing).toEqual([]);
    expect(result.findingsProcessed).toBe(0);
  });

  it("classifies accepted findings from response verdicts", async () => {
    // Bob sends findings about alice's project
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    // Alice responds with accept verdicts
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "response",
      payload: JSON.stringify(makeResponsePayload(3)),
    });

    // Ack the review bundle so it goes to history
    const poll = parse(await handlePollTasks(state, { agentId: "alice" }));
    handleAckTasks(state, { agentId: "alice", taskIds: poll.tasks.map((t: { id: string }) => t.id) });

    const result = parse(handleGenerateSynthesis(state, { agentId: "alice" }));

    expect(result.draft.accepted.length).toBe(3);
    expect(result.draft.discussing.length).toBe(2); // 5 findings - 3 responded
    expect(result.findingsProcessed).toBe(5);
    expect(result.responsesProcessed).toBe(3);
  });

  it("classifies rejected findings", async () => {
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    // Alice rejects findings
    const rejectPayload = makeFindingsPayload(5).map((_, i) => ({
      findingId: `finding-${i}`,
      verdict: "reject",
      evidence: `Not applicable: ${i}`,
    }));
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "response",
      payload: JSON.stringify(rejectPayload),
    });

    // Ack
    const poll = parse(await handlePollTasks(state, { agentId: "alice" }));
    handleAckTasks(state, { agentId: "alice", taskIds: poll.tasks.map((t: { id: string }) => t.id) });

    const result = parse(handleGenerateSynthesis(state, { agentId: "alice" }));

    expect(result.draft.rejected.length).toBe(5);
    expect(result.draft.rejected[0].reason).toMatch(/Not applicable/);
  });

  it("works with unacked tasks in current queue", () => {
    // Don't ack — findings are still in the queue
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    const result = parse(handleGenerateSynthesis(state, { agentId: "alice" }));
    expect(result.findingsProcessed).toBe(5);
    expect(result.draft.discussing.length).toBe(5); // All unresponded
  });

  it("includes hint for next step", () => {
    const result = parse(handleGenerateSynthesis(state, { agentId: "alice" }));
    expect(result.hint).toMatch(/synthesis task/);
  });

  it("errors for unregistered agent", () => {
    const result = parse(handleGenerateSynthesis(state, { agentId: "unknown" }));
    expect(result.error).toMatch(/not registered/);
  });

  it("handles mixed verdicts correctly", async () => {
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    const mixedResponses = [
      { findingId: "finding-0", verdict: "accept", evidence: "yes" },
      { findingId: "finding-1", verdict: "reject", evidence: "no" },
      { findingId: "finding-2", verdict: "discuss", evidence: "maybe" },
    ];
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "response",
      payload: JSON.stringify(mixedResponses),
    });

    const poll = parse(await handlePollTasks(state, { agentId: "alice" }));
    handleAckTasks(state, { agentId: "alice", taskIds: poll.tasks.map((t: { id: string }) => t.id) });

    const result = parse(handleGenerateSynthesis(state, { agentId: "alice" }));

    expect(result.draft.accepted.length).toBe(1);
    expect(result.draft.rejected.length).toBe(1);
    expect(result.draft.discussing.length).toBe(3); // finding-2 + finding-3 + finding-4
  });
});

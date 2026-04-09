/**
 * Tests for structured finding tracker (issue #21).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import {
  handleSendTask,
  handleGetFindingStatus,
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

describe("finding tracker", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("registers findings as open when review_bundle is sent", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    expect(state.findingTracker.size).toBe(5);
    const entry = state.findingTracker.get("finding-0");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("open");
    expect(entry!.source).toBe("alice");
    expect(entry!.target).toBe("bob");
  });

  it("updates status to accepted on response", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "response",
      payload: JSON.stringify(makeResponsePayload(3)),
    });

    expect(state.findingTracker.get("finding-0")!.status).toBe("accepted");
    expect(state.findingTracker.get("finding-1")!.status).toBe("accepted");
    expect(state.findingTracker.get("finding-2")!.status).toBe("accepted");
    // finding-3 and finding-4 not responded to
    expect(state.findingTracker.get("finding-3")!.status).toBe("open");
  });

  it("get_finding_status returns single finding by ID", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    const result = parse(handleGetFindingStatus(state, { findingId: "finding-2" }));
    expect(result.finding.findingId).toBe("finding-2");
    expect(result.finding.status).toBe("open");
  });

  it("get_finding_status errors for unknown finding", () => {
    const result = parse(handleGetFindingStatus(state, { findingId: "nonexistent" }));
    expect(result.error).toMatch(/not found/);
  });

  it("filters by agentId (as source or target)", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    const asSource = parse(handleGetFindingStatus(state, { agentId: "alice" }));
    expect(asSource.count).toBe(5);

    const asTarget = parse(handleGetFindingStatus(state, { agentId: "bob" }));
    expect(asTarget.count).toBe(5);
  });

  it("filters by status", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "response",
      payload: JSON.stringify(makeResponsePayload(2)),
    });

    const open = parse(handleGetFindingStatus(state, { status: "open" }));
    expect(open.count).toBe(3);

    const accepted = parse(handleGetFindingStatus(state, { status: "accepted" }));
    expect(accepted.count).toBe(2);
  });

  it("returns byStatus counts", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "response",
      payload: JSON.stringify(makeResponsePayload(2)),
    });

    const result = parse(handleGetFindingStatus(state, {}));
    expect(result.byStatus.open).toBe(3);
    expect(result.byStatus.accepted).toBe(2);
  });

  it("persists through round resets", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    // Findings survive round reset (they are cross-agent artifacts)
    expect(state.findingTracker.size).toBe(5);
    // Even after deregister, findings persist
    expect(state.findingTracker.get("finding-0")).toBeDefined();
  });

  it("unknown findingId in response is silently skipped", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "review_bundle",
      payload: JSON.stringify(makeFindingsPayload(5)),
    });

    // Response references a finding that doesn't exist in tracker
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "response",
      payload: JSON.stringify([
        { findingId: "nonexistent", verdict: "accept", evidence: "ok" },
        { findingId: "finding-0", verdict: "reject", evidence: "no" },
      ]),
    });

    // finding-0 was updated, nonexistent was skipped
    expect(state.findingTracker.get("finding-0")!.status).toBe("rejected");
    expect(state.findingTracker.has("nonexistent")).toBe(false);
  });
});

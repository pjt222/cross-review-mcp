/**
 * Tests for EvoSkills co-evolutionary skill evolution.
 *
 * Covers: skill_bundle validation, skill_verification validation,
 * evolution state tracking, convergence detection, get_skill_status.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import { handleSendTask, handleGetSkillStatus } from "./broker.js";
import {
  createFreshState,
  registerAgent,
  makeSkillPackagePayload,
  makeSkillVerificationPayload,
} from "./test-helpers.js";

function parse(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("EvoSkills: skill_bundle validation", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("accepts valid skill bundle", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "skill_bundle",
        payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 0)),
      }),
    );

    expect(result.sent).toBe(true);
    expect(result.type).toBe("skill_bundle");
  });

  it("rejects skill bundle missing skillId", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "skill_bundle",
        payload: JSON.stringify({ name: "test", artifacts: [{ filename: "a.ts", content: "//", role: "entry" }, { filename: "b.ts", content: "//", role: "helper" }] }),
      }),
    );

    expect(result.error).toMatch(/skillId/);
  });

  it("rejects skill bundle with too few artifacts", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "skill_bundle",
        payload: JSON.stringify(makeSkillPackagePayload("skill-001", 1, 0)),
      }),
    );

    expect(result.error).toMatch(/at least.*artifacts/);
  });

  it("rejects skill bundle exceeding max evolution rounds", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "skill_bundle",
        payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 5)),
      }),
    );

    expect(result.error).toMatch(/maximum evolution rounds/);
  });

  it("accepts skill bundle at last valid round (round 4)", () => {
    const result = parse(
      handleSendTask(state, {
        from: "alice",
        to: "bob",
        type: "skill_bundle",
        payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 4)),
      }),
    );

    expect(result.sent).toBe(true);
  });

  it("initializes evolution state for sender on first bundle", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "skill_bundle",
      payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 0)),
    });

    const evoState = state.skillEvolution.get("alice");
    expect(evoState).toBeDefined();
    expect(evoState!.agentId).toBe("alice");
    expect(evoState!.currentRound).toBe(0);
  });
});

describe("EvoSkills: skill_verification validation", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("accepts valid skill verification", () => {
    const result = parse(
      handleSendTask(state, {
        from: "bob",
        to: "alice",
        type: "skill_verification",
        payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.85)),
      }),
    );

    expect(result.sent).toBe(true);
  });

  it("rejects verification missing skillId", () => {
    const result = parse(
      handleSendTask(state, {
        from: "bob",
        to: "alice",
        type: "skill_verification",
        payload: JSON.stringify({ pass: true, score: 0.5, feedback: "ok", testCases: [] }),
      }),
    );

    expect(result.error).toMatch(/skillId/);
  });

  it("rejects verification with out-of-range score", () => {
    const result = parse(
      handleSendTask(state, {
        from: "bob",
        to: "alice",
        type: "skill_verification",
        payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 1.5)),
      }),
    );

    expect(result.error).toMatch(/between 0 and 1/);
  });

  it("initializes evolution state for skill owner on first verification", () => {
    // Verification arrives before skill owner has sent a bundle
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.7)),
    });

    const evoState = state.skillEvolution.get("alice");
    expect(evoState).toBeDefined();
    expect(evoState!.skillHistory).toHaveLength(1);
    expect(evoState!.skillHistory[0].score).toBe(0.7);
  });

  it("accumulates verification history on skill owner", () => {
    // Alice sends bundle, Bob verifies twice
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "skill_bundle",
      payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 0)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", false, 0.4)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.85)),
    });

    const evoState = state.skillEvolution.get("alice");
    expect(evoState!.skillHistory).toHaveLength(2);
    expect(evoState!.converged).toBe(false); // 0.4 -> 0.85 = delta 0.45
  });
});

describe("EvoSkills: convergence detection", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("detects convergence when scores stabilize", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "skill_bundle",
      payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 0)),
    });

    // First verification
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.90)),
    });

    // Second verification with similar score (delta < 0.05)
    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.92)),
    });

    const evoState = state.skillEvolution.get("alice");
    expect(evoState!.converged).toBe(true);
  });

  it("does not converge when scores diverge", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "skill_bundle",
      payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 0)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.5)),
    });

    handleSendTask(state, {
      from: "bob",
      to: "alice",
      type: "skill_verification",
      payload: JSON.stringify(makeSkillVerificationPayload("skill-001", true, 0.9)),
    });

    const evoState = state.skillEvolution.get("alice");
    expect(evoState!.converged).toBe(false);
  });
});

describe("EvoSkills: get_skill_status", () => {
  let state: BrokerState;

  beforeEach(() => {
    state = createFreshState();
    registerAgent(state, "alice", "/project-a");
    registerAgent(state, "bob", "/project-b");
  });

  it("returns hint when no evolution state exists", () => {
    const result = parse(handleGetSkillStatus(state, { agentId: "alice" }));

    expect(result.hasSkillEvolution).toBe(false);
    expect(result.hint).toBeDefined();
  });

  it("returns evolution state after skill bundle", () => {
    handleSendTask(state, {
      from: "alice",
      to: "bob",
      type: "skill_bundle",
      payload: JSON.stringify(makeSkillPackagePayload("skill-001", 2, 0)),
    });

    const result = parse(handleGetSkillStatus(state, { agentId: "alice" }));

    expect(result.hasSkillEvolution).toBe(true);
    expect(result.currentRound).toBe(0);
    expect(result.converged).toBe(false);
  });

  it("errors for unregistered agent", () => {
    const result = parse(handleGetSkillStatus(state, { agentId: "unknown" }));
    expect(result.error).toMatch(/not registered/);
  });
});

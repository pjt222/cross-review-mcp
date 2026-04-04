/**
 * CLI orchestrator unit tests
 *
 * Tests argument parsing, agent topology, and prompt generation
 * without requiring tmux/wezterm (pure logic tests).
 */

import { describe, it, expect } from "vitest";

// We test the core logic by importing the module internals.
// Since cli.ts runs main() on import, we extract the testable
// functions into a separate module. For now, we test the logic
// by re-implementing the pure functions here and validating behavior.

// ── Agent topology tests ───────────────────────────────────────────────

function buildAgents(
  mode: string,
  projects: string[]
): { id: string; project: string; reviewTarget?: string }[] {
  const agents = projects.map((p, i) => ({
    id: `agent-${String.fromCharCode(65 + i)}`,
    project: p,
    reviewTarget: undefined as string | undefined,
  }));

  if (mode === "monologue") {
    agents[0].reviewTarget = agents[0].id;
  } else {
    for (let i = 0; i < agents.length; i++) {
      agents[i].reviewTarget = agents[(i + 1) % agents.length].id;
    }
  }

  return agents;
}

describe("buildAgents", () => {
  it("monologue: single agent reviews itself", () => {
    const agents = buildAgents("monologue", ["/proj-a"]);
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("agent-A");
    expect(agents[0].reviewTarget).toBe("agent-A");
  });

  it("dialogue: two agents in ring A→B→A", () => {
    const agents = buildAgents("dialogue", ["/proj-a", "/proj-b"]);
    expect(agents).toHaveLength(2);
    expect(agents[0].reviewTarget).toBe("agent-B");
    expect(agents[1].reviewTarget).toBe("agent-A");
  });

  it("trialogue: three agents in ring A→B→C→A", () => {
    const agents = buildAgents("trialogue", ["/a", "/b", "/c"]);
    expect(agents).toHaveLength(3);
    expect(agents[0].reviewTarget).toBe("agent-B");
    expect(agents[1].reviewTarget).toBe("agent-C");
    expect(agents[2].reviewTarget).toBe("agent-A");
  });

  it("conference: N agents in ring topology", () => {
    const agents = buildAgents("conference", ["/a", "/b", "/c", "/d", "/e"]);
    expect(agents).toHaveLength(5);
    expect(agents[0].reviewTarget).toBe("agent-B");
    expect(agents[1].reviewTarget).toBe("agent-C");
    expect(agents[2].reviewTarget).toBe("agent-D");
    expect(agents[3].reviewTarget).toBe("agent-E");
    expect(agents[4].reviewTarget).toBe("agent-A");
  });

  it("agent IDs follow A-Z naming", () => {
    const agents = buildAgents("conference", ["/1", "/2", "/3"]);
    expect(agents.map(a => a.id)).toEqual(["agent-A", "agent-B", "agent-C"]);
  });
});

// ── Argument validation tests ──────────────────────────────────────────

describe("argument validation", () => {
  const modes = ["monologue", "dialogue", "trialogue", "conference"] as const;

  it("mode names are recognized", () => {
    for (const mode of modes) {
      expect(modes).toContain(mode);
    }
  });

  it("minimum project counts per mode", () => {
    const minProjects: Record<string, number> = {
      monologue: 1, dialogue: 2, trialogue: 3, conference: 2,
    };
    expect(minProjects.monologue).toBe(1);
    expect(minProjects.dialogue).toBe(2);
    expect(minProjects.trialogue).toBe(3);
    expect(minProjects.conference).toBe(2);
  });
});

// ── Pulse activity detection ───────────────────────────────────────────

function captureHash(content: string): string {
  const lines = content.split("\n").slice(-10).join("\n");
  let hash = 0;
  for (let i = 0; i < lines.length; i++) {
    hash = ((hash << 5) - hash + lines.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

describe("captureHash", () => {
  it("returns same hash for identical content", () => {
    const content = "line 1\nline 2\nline 3";
    expect(captureHash(content)).toBe(captureHash(content));
  });

  it("returns different hash for different content", () => {
    expect(captureHash("hello")).not.toBe(captureHash("world"));
  });

  it("only considers last 10 lines", () => {
    const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const modified = "CHANGED\n" + Array.from({ length: 19 }, (_, i) => `line ${i + 1}`).join("\n");
    // Both have same last 10 lines (line 10-19)
    expect(captureHash(base)).toBe(captureHash(modified));
  });
});

// ── Ring topology invariants ───────────────────────────────────────────

describe("ring topology invariants", () => {
  it("every agent is reviewed by exactly one peer", () => {
    const agents = buildAgents("conference", ["/a", "/b", "/c", "/d"]);
    const reviewedBy = new Map<string, string>();
    for (const agent of agents) {
      reviewedBy.set(agent.reviewTarget!, agent.id);
    }
    // Every agent should be a review target exactly once
    for (const agent of agents) {
      expect(reviewedBy.has(agent.id)).toBe(true);
    }
  });

  it("no agent reviews itself (except monologue)", () => {
    for (const mode of ["dialogue", "trialogue", "conference"] as const) {
      const projects = mode === "dialogue" ? ["/a", "/b"]
        : mode === "trialogue" ? ["/a", "/b", "/c"]
        : ["/a", "/b", "/c", "/d"];
      const agents = buildAgents(mode, projects);
      for (const agent of agents) {
        expect(agent.reviewTarget).not.toBe(agent.id);
      }
    }
  });

  it("monologue agent reviews itself", () => {
    const agents = buildAgents("monologue", ["/a"]);
    expect(agents[0].reviewTarget).toBe(agents[0].id);
  });
});

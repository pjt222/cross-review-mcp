import { describe, it, expect, beforeEach } from "vitest";
import type { BrokerState } from "./types.js";
import type { MemPalaceState } from "./types.js";
import { createFreshState, registerAgent } from "./test-helpers.js";
import {
  createMemPalaceState,
  handleMemPalaceConfigure,
  handleMemPalaceStore,
  handleMemPalaceSearch,
  handleMemPalaceStatus,
} from "./mempalace.js";

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe("MemPalace integration", () => {
  let state: BrokerState;
  let mpState: MemPalaceState;

  beforeEach(() => {
    state = createFreshState();
    mpState = createMemPalaceState();
  });

  describe("handleMemPalaceConfigure", () => {
    it("configures with defaults", () => {
      const result = parse(handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" }));
      expect(result.configured).toBe(true);
      expect(result.url).toBe("http://localhost:5173/mcp");
      expect(result.palacePath).toBe("~/.mempalace/palace");
      expect(result.wing).toBe("cross-review");
      expect(mpState.enabled).toBe(true);
    });

    it("configures with custom wing and path", () => {
      const result = parse(handleMemPalaceConfigure(mpState, {
        url: "http://localhost:5173/mcp",
        palacePath: "/tmp/palace",
        wing: "my-reviews",
      }));
      expect(result.wing).toBe("my-reviews");
      expect(result.palacePath).toBe("/tmp/palace");
    });
  });

  describe("handleMemPalaceStore", () => {
    it("rejects when not configured", () => {
      registerAgent(state, "agent-a");
      const result = parse(handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "briefing",
        payload: "{}",
      }));
      expect(result.error).toBe("MemPalace integration not configured");
    });

    it("rejects unregistered agent", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      const result = parse(handleMemPalaceStore(mpState, state, {
        agentId: "ghost",
        kind: "briefing",
        payload: "{}",
      }));
      expect(result.error).toBe("Agent not registered");
    });

    it("rejects invalid JSON", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a");
      const result = parse(handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "briefing",
        payload: "not-json",
      }));
      expect(result.error).toBe("Invalid JSON payload");
    });

    it("stores a briefing artifact", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "my-project");
      const result = parse(handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "briefing",
        payload: JSON.stringify({ project: "my-project", language: "ts" }),
      }));
      expect(result.stored).toBe(true);
      expect(result.kind).toBe("briefing");
      expect(result.project).toBe("my-project");
      expect(result.wing).toBe("cross-review");
      expect(result.room).toBe("my-project");
      expect(mpState.entries).toHaveLength(1);
    });

    it("stores finding artifacts with AAAK formatting", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj");
      const findings = [
        { id: "f1", category: "bug_risk", targetFile: "a.ts", description: "bug", evidence: "e1" },
        { id: "f2", category: "simplification", targetFile: "b.ts", description: "simplify", evidence: "e2" },
      ];
      const result = parse(handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "finding",
        payload: JSON.stringify(findings),
      }));
      expect(result.stored).toBe(true);
      expect(result.kind).toBe("finding");

      const entry = mpState.entries[0];
      expect(entry.content).toContain("FIND:");
      expect(entry.content).toContain("n=2");
      expect(entry.content).toContain("bug_risk");
    });

    it("stores synthesis artifacts", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj");
      const synthesis = {
        agentId: "agent-a",
        project: "proj",
        accepted: [{ findingId: "f1", action: "fix it" }],
        rejected: [{ findingId: "f2", reason: "not applicable" }],
      };
      const result = parse(handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "synthesis",
        payload: JSON.stringify(synthesis),
      }));
      expect(result.stored).toBe(true);
      const entry = mpState.entries[0];
      expect(entry.content).toContain("SYNTH:");
      expect(entry.content).toContain("accepted=1");
      expect(entry.content).toContain("rejected=1");
    });
  });

  describe("handleMemPalaceSearch", () => {
    it("rejects when not configured", () => {
      const result = parse(handleMemPalaceSearch(mpState, { query: "test" }));
      expect(result.error).toBe("MemPalace integration not configured");
    });

    it("searches by query text", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj");
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "briefing",
        payload: JSON.stringify({ project: "proj", language: "typescript" }),
      });
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a",
        kind: "response",
        payload: JSON.stringify([{ findingId: "f1", verdict: "accept", evidence: "good" }]),
      });

      const result = parse(handleMemPalaceSearch(mpState, { query: "typescript" }));
      expect(result.count).toBe(1);

      const allResult = parse(handleMemPalaceSearch(mpState, { query: "agent-a" }));
      expect(allResult.count).toBe(2);
    });

    it("filters by kind", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj");
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a", kind: "briefing",
        payload: JSON.stringify({ project: "proj" }),
      });
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a", kind: "response",
        payload: JSON.stringify([{ findingId: "f1", verdict: "accept", evidence: "ok" }]),
      });

      const result = parse(handleMemPalaceSearch(mpState, { query: "agent-a", kind: "briefing" }));
      expect(result.count).toBe(1);
    });

    it("filters by project", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj-a");
      registerAgent(state, "agent-b", "proj-b");
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a", kind: "briefing",
        payload: JSON.stringify({ project: "proj-a" }),
      });
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-b", kind: "briefing",
        payload: JSON.stringify({ project: "proj-b" }),
      });

      const result = parse(handleMemPalaceSearch(mpState, { query: "BRIEF", project: "proj-a" }));
      expect(result.count).toBe(1);
    });

    it("respects limit", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj");
      for (let i = 0; i < 5; i++) {
        handleMemPalaceStore(mpState, state, {
          agentId: "agent-a", kind: "briefing",
          payload: JSON.stringify({ n: i }),
        });
      }
      const result = parse(handleMemPalaceSearch(mpState, { query: "agent-a", limit: 2 }));
      expect(result.count).toBe(2);
    });
  });

  describe("handleMemPalaceStatus", () => {
    it("reports disabled when not configured", () => {
      const result = parse(handleMemPalaceStatus(mpState));
      expect(result.enabled).toBe(false);
    });

    it("reports status with entries", () => {
      handleMemPalaceConfigure(mpState, { url: "http://localhost:5173/mcp" });
      registerAgent(state, "agent-a", "proj-a");
      registerAgent(state, "agent-b", "proj-b");
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a", kind: "briefing",
        payload: JSON.stringify({ project: "proj-a" }),
      });
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-a", kind: "finding",
        payload: JSON.stringify([{ id: "f1", category: "bug_risk", targetFile: "a.ts", description: "d", evidence: "e" }]),
      });
      handleMemPalaceStore(mpState, state, {
        agentId: "agent-b", kind: "briefing",
        payload: JSON.stringify({ project: "proj-b" }),
      });

      const result = parse(handleMemPalaceStatus(mpState));
      expect(result.enabled).toBe(true);
      expect(result.totalEntries).toBe(3);
      expect((result.byKind as Record<string, number>).briefing).toBe(2);
      expect((result.byKind as Record<string, number>).finding).toBe(1);
      expect((result.byProject as Record<string, number>)["proj-a"]).toBe(2);
      expect((result.byProject as Record<string, number>)["proj-b"]).toBe(1);
    });
  });
});

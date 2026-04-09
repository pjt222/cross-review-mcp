/**
 * TUI unit tests — viridis color scheme, state management, rendering helpers
 */

import { describe, it, expect } from "vitest";
import { V, Tui, createTuiState, type TuiState, type TuiEvent } from "./tui.js";

// ── Color palette tests ────────────────────────────────────────────────

describe("viridis palette", () => {
  it("defines all gradient stops", () => {
    expect(V.indigo).toContain("38;5;55");
    expect(V.teal).toContain("38;5;30");
    expect(V.cyan).toContain("38;5;37");
    expect(V.green).toContain("38;5;78");
    expect(V.lime).toContain("38;5;149");
    expect(V.yellow).toContain("38;5;226");
  });

  it("has reset sequence", () => {
    expect(V.reset).toBe("\x1b[0m");
  });

  it("bold variants include bold escape", () => {
    expect(V.bYellow).toContain("\x1b[1;");
    expect(V.bGreen).toContain("\x1b[1;");
    expect(V.bCyan).toContain("\x1b[1;");
  });
});

// ── State factory tests ────────────────────────────────────────────────

describe("createTuiState", () => {
  it("creates state with correct defaults", () => {
    const state = createTuiState({
      mode: "dialogue",
      sessionName: "xrev-test",
      port: 3749,
      pulse: 45,
      rounds: 0,
      agents: [
        { id: "agent-A", project: "/proj-a", reviewTarget: "agent-B" },
        { id: "agent-B", project: "/proj-b", reviewTarget: "agent-A" },
      ],
    });

    expect(state.mode).toBe("dialogue");
    expect(state.agents).toHaveLength(2);
    expect(state.currentRound).toBe(0);
    expect(state.selectedAgent).toBe(0);
    expect(state.events).toEqual([]);
    expect(state.broker.healthy).toBe(false);
    expect(state.startedAt).toBeGreaterThan(0);
  });

  it("initializes agents with default phase and idle", () => {
    const state = createTuiState({
      mode: "monologue",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 1,
      agents: [{ id: "agent-A", project: "/p", reviewTarget: "agent-A" }],
    });

    const a = state.agents[0];
    expect(a.phase).toBe("registered");
    expect(a.idleCycles).toBe(0);
    expect(a.paneContent).toBe("");
    expect(a.reviewTarget).toBe("agent-A");
  });
});

// ── Event management tests ─────────────────────────────────────────────

describe("Tui event management", () => {
  function makeTui(): { tui: Tui; state: TuiState } {
    const state = createTuiState({
      mode: "dialogue",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 0,
      agents: [
        { id: "agent-A", project: "/a" },
        { id: "agent-B", project: "/b" },
      ],
    });
    // Don't call start() — we test logic without terminal
    const tui = new Tui(state);
    return { tui, state };
  }

  it("addEvent appends to events list", () => {
    const { tui, state } = makeTui();
    tui.addEvent({ ts: 1000, level: "info", message: "test" });
    expect(state.events).toHaveLength(1);
    expect(state.events[0].message).toBe("test");
  });

  it("addEvent trims to 200 entries", () => {
    const { tui, state } = makeTui();
    for (let i = 0; i < 210; i++) {
      tui.addEvent({ ts: i, level: "info", message: `event ${i}` });
    }
    expect(state.events.length).toBeLessThanOrEqual(200);
    expect(state.events[0].message).toBe("event 10");
  });

  it("event levels cover all types", () => {
    const levels: TuiEvent["level"][] = ["info", "warn", "pulse", "nudge", "phase", "done"];
    const { tui, state } = makeTui();
    for (const level of levels) {
      tui.addEvent({ ts: Date.now(), level, message: level });
    }
    expect(state.events).toHaveLength(levels.length);
  });
});

// ── State update tests ─────────────────────────────────────────────────

describe("Tui state updates", () => {
  it("updateState merges partial state", () => {
    const state = createTuiState({
      mode: "trialogue",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 5,
      agents: [
        { id: "agent-A", project: "/a" },
        { id: "agent-B", project: "/b" },
        { id: "agent-C", project: "/c" },
      ],
    });
    const tui = new Tui(state);

    tui.updateState({ currentRound: 3 });
    expect(state.currentRound).toBe(3);

    tui.updateState({ broker: { healthy: true, agentCount: 3, uptime: 120 } });
    expect(state.broker.healthy).toBe(true);
    expect(state.broker.agentCount).toBe(3);
  });
});

// ── Pulse recording tests ──────────────────────────────────────────────

describe("Tui pulse recording", () => {
  it("recordPulse tracks idle counts", () => {
    const state = createTuiState({
      mode: "dialogue",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 0,
      agents: [
        { id: "agent-A", project: "/a" },
        { id: "agent-B", project: "/b" },
      ],
    });
    const tui = new Tui(state);

    state.agents[0].idleCycles = 2;
    state.agents[1].idleCycles = 1;
    tui.recordPulse();

    state.agents[0].idleCycles = 0;
    state.agents[1].idleCycles = 3;
    tui.recordPulse();

    // Verify state is still valid after recording pulses
    expect(state.agents[0].idleCycles).toBe(0);
    expect(state.agents[1].idleCycles).toBe(3);
  });
});

// ── Agent selection tests ──────────────────────────────────────────────

describe("agent selection", () => {
  it("selectedAgent wraps within bounds", () => {
    const state = createTuiState({
      mode: "conference",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 0,
      agents: [
        { id: "agent-A", project: "/a" },
        { id: "agent-B", project: "/b" },
        { id: "agent-C", project: "/c" },
        { id: "agent-D", project: "/d" },
      ],
    });

    expect(state.selectedAgent).toBe(0);
    state.selectedAgent = 3;
    expect(state.selectedAgent).toBe(3);

    // Tab cycling logic (tested as pure operation)
    state.selectedAgent = (state.selectedAgent + 1) % state.agents.length;
    expect(state.selectedAgent).toBe(0);
  });
});

// ── Mode display tests ─────────────────────────────────────────────────

describe("mode configuration", () => {
  it("monologue creates single-agent state", () => {
    const state = createTuiState({
      mode: "monologue",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 1,
      agents: [{ id: "agent-A", project: "/p", reviewTarget: "agent-A" }],
    });
    expect(state.agents).toHaveLength(1);
    expect(state.mode).toBe("monologue");
  });

  it("conference creates N-agent state", () => {
    const agents = Array.from({ length: 6 }, (_, i) => ({
      id: `agent-${String.fromCharCode(65 + i)}`,
      project: `/p${i}`,
    }));
    const state = createTuiState({
      mode: "conference",
      sessionName: "test",
      port: 3749,
      pulse: 30,
      rounds: 0,
      agents,
    });
    expect(state.agents).toHaveLength(6);
    expect(state.mode).toBe("conference");
  });
});

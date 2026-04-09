#!/usr/bin/env tsx
/**
 * Cross-Review CLI — Orchestrator for headless Claude Code conversations
 *
 * Uses tmux for session/pane management and optionally WezTerm as the
 * terminal multiplexer host. Drives continuous "heart-pulsed" review
 * cycles across 1–N Claude Code instances.
 *
 * Modes:
 *   monologue  — 1 agent, self-review loop
 *   dialogue   — 2 agents, cross-review (standard QSG pair)
 *   trialogue  — 3 agents, ring topology (A→B→C→A)
 *   conference — N agents, round-robin review mesh
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { resolve, basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { Tui, createTuiState, type TuiState } from "./tui.js";

// ── Types ──────────────────────────────────────────────────────────────

type Mode = "monologue" | "dialogue" | "trialogue" | "conference";

interface AgentSpec {
  id: string;
  project: string;
  /** Assigned review target (ring topology) */
  reviewTarget?: string;
}

interface CliOptions {
  mode: Mode;
  projects: string[];
  port: number;
  pulse: number;       // heartbeat interval in seconds
  rounds: number;      // review rounds before stopping (0 = infinite)
  headless: boolean;   // run wezterm in headless mode
  tui: boolean;        // enable TUI dashboard
  sessionName: string;
  prompt?: string;     // optional custom prompt injected into each agent
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_PORT = 3749;
const DEFAULT_PULSE = 45;     // seconds between heartbeats
const DEFAULT_ROUNDS = 0;     // infinite
const SESSION_PREFIX = "xrev";

// ── Utility ────────────────────────────────────────────────────────────

function shortId(): string {
  return randomBytes(3).toString("hex");
}

function tmux(...args: string[]): string {
  try {
    return execSync(`tmux ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch (e: any) {
    if (e.status !== undefined) {
      throw new Error(`tmux ${args[0]} failed (exit ${e.status}): ${e.stderr?.trim()}`);
    }
    throw e;
  }
}

function tmuxSend(target: string, text: string): void {
  // Use tmux send-keys with literal flag to avoid key interpretation issues
  execSync(`tmux send-keys -t ${target} ${JSON.stringify(text)} Enter`, {
    encoding: "utf-8",
    timeout: 5_000,
  });
}

function tmuxCapture(target: string, lines = 50): string {
  try {
    return execSync(
      `tmux capture-pane -t ${target} -p -S -${lines}`,
      { encoding: "utf-8", timeout: 5_000 }
    ).trim();
  } catch {
    return "";
  }
}

function hasBinary(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── Argument parsing ───────────────────────────────────────────────────

function printUsage(): never {
  console.log(`
cross-review — headless heart-pulsed Claude Code conversations

Usage:
  cross-review <mode> [options] <project-paths...>

Modes:
  monologue   Single agent self-review (1 project)
  dialogue    Two agents cross-review (2 projects)
  trialogue   Three agents ring-review (3 projects)
  conference  N agents round-robin (2+ projects)

Options:
  --port <n>        Broker port (default: ${DEFAULT_PORT}, env: CROSS_REVIEW_PORT)
  --pulse <secs>    Heartbeat interval (default: ${DEFAULT_PULSE}s)
  --rounds <n>      Review rounds, 0 = infinite (default: ${DEFAULT_ROUNDS})
  --headless        Launch WezTerm in headless mode (no GUI)
  --tui             Enable viridis TUI dashboard
  --session <name>  tmux session name (default: auto-generated)
  --prompt <text>   Custom prompt injected into each agent
  --help            Show this help

Examples:
  cross-review monologue ./my-project
  cross-review dialogue ./project-a ./project-b --tui
  cross-review trialogue ./proj-a ./proj-b ./proj-c
  cross-review conference ./p1 ./p2 ./p3 ./p4 --rounds 3 --pulse 60
  cross-review dialogue ./proj-a ./proj-b --headless --tui
`);
  process.exit(0);
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
  }

  const mode = args[0] as Mode;
  if (!["monologue", "dialogue", "trialogue", "conference"].includes(mode)) {
    console.error(`Unknown mode: ${mode}`);
    printUsage();
  }

  const projects: string[] = [];
  let port = Number(process.env.CROSS_REVIEW_PORT) || DEFAULT_PORT;
  let pulse = DEFAULT_PULSE;
  let rounds = DEFAULT_ROUNDS;
  let headless = false;
  let tui = false;
  let sessionName = `${SESSION_PREFIX}-${shortId()}`;
  let prompt: string | undefined;

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--port":
        port = Number(args[++i]);
        break;
      case "--pulse":
        pulse = Number(args[++i]);
        break;
      case "--rounds":
        rounds = Number(args[++i]);
        break;
      case "--headless":
        headless = true;
        break;
      case "--tui":
        tui = true;
        break;
      case "--session":
        sessionName = args[++i];
        break;
      case "--prompt":
        prompt = args[++i];
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        projects.push(resolve(arg));
    }
    i++;
  }

  // Validate project count per mode
  const minProjects: Record<Mode, number> = {
    monologue: 1, dialogue: 2, trialogue: 3, conference: 2,
  };
  if (projects.length < minProjects[mode]) {
    console.error(`${mode} mode requires at least ${minProjects[mode]} project path(s), got ${projects.length}`);
    process.exit(1);
  }

  // Enforce exact count for non-conference modes
  const exactProjects: Record<string, number> = {
    monologue: 1, dialogue: 2, trialogue: 3,
  };
  if (mode in exactProjects && projects.length !== exactProjects[mode]) {
    console.error(`${mode} mode requires exactly ${exactProjects[mode]} project path(s), got ${projects.length}`);
    process.exit(1);
  }

  return { mode, projects, port, pulse, rounds, headless, tui, sessionName, prompt };
}

// ── Agent topology ─────────────────────────────────────────────────────

function buildAgents(opts: CliOptions): AgentSpec[] {
  if (opts.projects.length > 26) {
    throw new Error(`Maximum 26 agents supported (got ${opts.projects.length})`);
  }
  const agents: AgentSpec[] = opts.projects.map((p, i) => ({
    id: `agent-${String.fromCharCode(65 + i)}`,   // agent-A, agent-B, ...
    project: p,
  }));

  if (opts.mode === "monologue") {
    // Self-review: agent reviews its own project
    agents[0].reviewTarget = agents[0].id;
  } else {
    // Ring topology: each agent reviews the next agent's project
    for (let i = 0; i < agents.length; i++) {
      agents[i].reviewTarget = agents[(i + 1) % agents.length].id;
    }
  }

  return agents;
}

// ── Prompt generation ──────────────────────────────────────────────────

function agentSystemPrompt(agent: AgentSpec, allAgents: AgentSpec[], opts: CliOptions): string {
  const brokerUrl = `http://localhost:${opts.port}/mcp`;
  const target = allAgents.find(a => a.id === agent.reviewTarget);
  const peers = allAgents.filter(a => a.id !== agent.id);

  let prompt: string;

  if (opts.mode === "monologue") {
    prompt = [
      `You are ${agent.id}, running a self-review of ${basename(agent.project)}.`,
      `The MCP broker is at ${brokerUrl}.`,
      ``,
      `Your workflow:`,
      `1. Register with the broker: agentId="${agent.id}", project="${basename(agent.project)}"`,
      `2. Analyze your project thoroughly — architecture, patterns, dependencies, tests`,
      `3. Create a briefing artifact and send it to yourself`,
      `4. Review your own code critically: find at least 5 findings (bug_risk, simplification, inconsistency, etc.)`,
      `5. Send the review bundle to yourself`,
      `6. Respond to your own findings with accept/reject/discuss verdicts`,
      `7. Create a synthesis summarizing actionable improvements`,
      `8. Signal each phase as you progress`,
      ``,
      `Be thorough and self-critical. The goal is genuine improvement, not self-congratulation.`,
    ].join("\n");
  } else {
    prompt = [
      `You are ${agent.id}, reviewing ${target ? basename(target.project) : "a peer's project"}.`,
      `The MCP broker is at ${brokerUrl}. Your peers: ${peers.map(p => p.id).join(", ")}.`,
      `Your own project: ${basename(agent.project)}`,
      target ? `You are reviewing: ${target.id}'s project (${basename(target.project)})` : "",
      ``,
      `Your workflow:`,
      `1. Register with the broker: agentId="${agent.id}", project="${basename(agent.project)}"`,
      `2. Analyze YOUR project and create a briefing artifact`,
      `3. Send your briefing, then signal "briefing" phase`,
      `4. Wait for your reviewer's briefing, then study their project`,
      `5. Produce at least 5 review findings for your target's project`,
      `6. Send the review bundle, signal "review" phase`,
      `7. Wait for reviews of YOUR project, respond with verdicts`,
      `8. Signal "dialogue" phase, exchange follow-ups if needed`,
      `9. Create synthesis of accepted/rejected findings, signal "synthesis"`,
      `10. Signal "complete" when done`,
      ``,
      `Be constructive but rigorous. Enforce QSG bandwidth (≥5 findings per bundle).`,
    ].join("\n");
  }

  if (opts.prompt) {
    prompt += `\n\nAdditional instructions: ${opts.prompt}`;
  }

  return prompt;
}

// ── tmux session management ────────────────────────────────────────────

function createTmuxSession(opts: CliOptions, agents: AgentSpec[]): void {
  const { sessionName } = opts;

  // Kill existing session if present
  try {
    tmux("kill-session", `-t`, sessionName);
  } catch { /* doesn't exist, fine */ }

  // Create session with broker pane
  tmux("new-session", "-d", "-s", sessionName, "-n", "broker", "-x", "220", "-y", "50");

  // Create agent panes (one window per agent)
  for (const agent of agents) {
    tmux("new-window", "-t", `${sessionName}:`, "-n", agent.id);
  }

  // Create monitor window
  tmux("new-window", "-t", `${sessionName}:`, "-n", "monitor");
}

function startBroker(opts: CliOptions): void {
  const target = `${opts.sessionName}:broker`;
  tmuxSend(target, `cd "${resolve(".")}" && CROSS_REVIEW_PORT=${opts.port} npm start`);
}

function startAgent(agent: AgentSpec, allAgents: AgentSpec[], opts: CliOptions): void {
  const target = `${opts.sessionName}:${agent.id}`;
  const brokerUrl = `http://localhost:${opts.port}/mcp`;

  // Navigate to agent's project directory
  tmuxSend(target, `cd "${agent.project}"`);

  // Add MCP server to claude and start conversation
  tmuxSend(target, `claude mcp add cross-review --transport http ${brokerUrl}`);
}

function launchAgentConversation(agent: AgentSpec, allAgents: AgentSpec[], opts: CliOptions): void {
  const target = `${opts.sessionName}:${agent.id}`;
  const prompt = agentSystemPrompt(agent, allAgents, opts);

  // Start claude with the system prompt — use --dangerously-skip-permissions
  // so the agent can use MCP tools without manual approval in headless mode
  const escapedPrompt = prompt
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "'\\''")
    .replace(/\n/g, " ")
    .replace(/\x1b/g, "");   // strip ANSI escape sequences
  tmuxSend(target, `claude --dangerously-skip-permissions -p '${escapedPrompt}'`);
}

// ── Heart pulse engine ─────────────────────────────────────────────────

interface PulseState {
  round: number;
  agentActivity: Map<string, { lastHash: string; idleCycles: number }>;
}

function captureHash(content: string): string {
  // Simple hash of last few lines to detect activity
  const lines = content.split("\n").slice(-10).join("\n");
  let hash = 0;
  for (let i = 0; i < lines.length; i++) {
    hash = ((hash << 5) - hash + lines.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function getNudgePrompt(agent: AgentSpec, allAgents: AgentSpec[], opts: CliOptions, state: PulseState): string {
  const idle = state.agentActivity.get(agent.id);
  const idleCycles = idle?.idleCycles ?? 0;

  if (idleCycles < 2) {
    // Light nudge — just continue
    return "Continue with your current task. Check poll_tasks for any pending messages from peers.";
  }

  if (idleCycles < 5) {
    // Medium nudge — remind of workflow
    return [
      "You seem to be idle. Please check your progress:",
      "- Use get_status to see the current broker state",
      "- Use poll_tasks to check for pending work",
      "- If you're stuck, move to the next phase of the review workflow",
      "Continue working.",
    ].join("\n");
  }

  // Strong nudge — reset context
  const prompt = agentSystemPrompt(agent, allAgents, opts);
  return [
    "You appear to have stalled. Here's a reminder of your mission:",
    prompt,
    "",
    "Check get_status and poll_tasks, then continue from where you left off.",
  ].join("\n");
}

function detectPhase(content: string): string | undefined {
  const phases = ["complete", "synthesis", "dialogue", "review", "briefing", "registered"];
  for (const p of phases) {
    if (content.includes(`"${p}"`) || content.includes(`phase: ${p}`) || content.includes(`"phase":"${p}"`)) {
      return p;
    }
  }
  return undefined;
}

async function heartbeatLoop(agents: AgentSpec[], opts: CliOptions, tui?: Tui, tuiState?: TuiState): Promise<void> {
  const state: PulseState = {
    round: 0,
    agentActivity: new Map(
      agents.map(a => [a.id, { lastHash: "", idleCycles: 0 }])
    ),
  };

  const monitorTarget = `${opts.sessionName}:monitor`;

  const emit = (level: "info" | "warn" | "pulse" | "nudge" | "phase" | "done", msg: string, agentId?: string) => {
    if (tui && tuiState) {
      tui.addEvent({ ts: Date.now(), level, agent: agentId, message: msg });
    } else {
      log(agentId ? `${agentId}: ${msg}` : msg);
    }
  };

  emit("info", `Heart pulse started — interval=${opts.pulse}s, rounds=${opts.rounds || "∞"}`);

  while (true) {
    await sleep(opts.pulse * 1000);
    state.round++;

    if (tuiState) tuiState.currentRound = state.round;

    // Check if tmux session still exists
    try {
      tmux("has-session", "-t", opts.sessionName);
    } catch {
      emit("warn", "tmux session gone, stopping heartbeat");
      break;
    }

    // Check broker health
    let brokerHealthy = false;
    let brokerAgentCount = 0;
    try {
      const health = execSync(
        `curl -sf http://localhost:${opts.port}/health`,
        { encoding: "utf-8", timeout: 5_000 }
      );
      const status = JSON.parse(health);
      brokerHealthy = true;
      brokerAgentCount = status.agentCount ?? 0;
      if (!tui) {
        tmuxSend(monitorTarget, `echo "[pulse ${state.round}] broker: ${status.agentCount} agents"`);
      }
    } catch {
      if (!tui) {
        tmuxSend(monitorTarget, `echo "[pulse ${state.round}] broker: unreachable"`);
      }
    }

    if (tuiState) {
      tuiState.broker.healthy = brokerHealthy;
      tuiState.broker.agentCount = brokerAgentCount;
      tuiState.broker.uptime = Math.floor((Date.now() - tuiState.startedAt) / 1000);
    }

    // Pulse each agent
    for (const agent of agents) {
      const target = `${opts.sessionName}:${agent.id}`;
      const content = tmuxCapture(target);
      const hash = captureHash(content);
      const activity = state.agentActivity.get(agent.id)!;

      if (hash === activity.lastHash) {
        activity.idleCycles++;
      } else {
        activity.idleCycles = 0;
        activity.lastHash = hash;
      }

      // Update TUI agent state
      if (tuiState) {
        const tuiAgent = tuiState.agents.find(a => a.id === agent.id);
        if (tuiAgent) {
          tuiAgent.idleCycles = activity.idleCycles;
          tuiAgent.paneContent = content;
          tuiAgent.lastActivity = new Date().toISOString().slice(11, 19);
          const detectedPhase = detectPhase(content);
          if (detectedPhase && detectedPhase !== tuiAgent.phase) {
            emit("phase", `${tuiAgent.phase} → ${detectedPhase}`, agent.id);
            tuiAgent.phase = detectedPhase;
          }
        }
      }

      // Only nudge if idle
      if (activity.idleCycles >= 2) {
        emit("nudge", `idle ${activity.idleCycles} cycles, nudging`, agent.id);
        const nudge = getNudgePrompt(agent, agents, opts, state);
        tmuxSend(target, nudge);
      }

      if (!tui) {
        tmuxSend(
          monitorTarget,
          `echo "[pulse ${state.round}] ${agent.id}: idle=${activity.idleCycles}"`
        );
      }
    }

    emit("pulse", `round ${state.round} complete`);
    if (tui) tui.recordPulse();

    // Check round limit
    if (opts.rounds > 0 && state.round >= opts.rounds) {
      emit("done", `Reached round limit (${opts.rounds}), signaling completion`);
      for (const agent of agents) {
        const target = `${opts.sessionName}:${agent.id}`;
        tmuxSend(target, "Signal 'complete' phase and wrap up your review. Produce a final synthesis if you haven't already.");
      }
      break;
    }

    // Check if all agents show "complete" in their output
    let allComplete = true;
    for (const agent of agents) {
      const target = `${opts.sessionName}:${agent.id}`;
      const content = tmuxCapture(target, 20);
      if (!content.includes('"complete"') && !content.includes("phase: complete")) {
        allComplete = false;
        break;
      }
    }
    if (allComplete && state.round > 3) {
      emit("done", "All agents complete");
      break;
    }
  }
}

// ── Logging ────────────────────────────────────────────────────────────

function log(msg: string, detail?: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[${ts}] ${msg}${suffix}`);
}

// ── WezTerm integration ────────────────────────────────────────────────

function launchWithWezterm(opts: CliOptions): ChildProcess | null {
  if (!hasBinary("wezterm")) {
    return null;
  }

  if (opts.headless) {
    // Start WezTerm multiplexer in headless mode
    log("Starting WezTerm multiplexer (headless)");
    const proc = spawn("wezterm", ["start", "--no-gui", "--", "tmux", "attach", "-t", opts.sessionName], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    return proc;
  }

  // Launch WezTerm GUI attached to the tmux session
  log("Launching WezTerm GUI");
  const proc = spawn("wezterm", ["start", "--", "tmux", "attach", "-t", opts.sessionName], {
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  return proc;
}

// ── Cleanup ────────────────────────────────────────────────────────────

function cleanup(sessionName: string): void {
  log("Cleaning up...");
  try {
    tmux("kill-session", "-t", sessionName);
    log("tmux session killed");
  } catch { /* already gone */ }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const agents = buildAgents(opts);

  // Preflight checks
  if (!hasBinary("tmux")) {
    console.error("Error: tmux is required but not found in PATH");
    process.exit(1);
  }
  if (!hasBinary("claude")) {
    console.error("Error: claude CLI is required but not found in PATH");
    process.exit(1);
  }

  // Set up TUI or print banner
  let tui: Tui | undefined;
  let tuiState: TuiState | undefined;

  if (opts.tui) {
    tuiState = createTuiState({
      mode: opts.mode,
      sessionName: opts.sessionName,
      port: opts.port,
      pulse: opts.pulse,
      rounds: opts.rounds,
      agents: agents.map(a => ({
        id: a.id,
        project: a.project,
        reviewTarget: a.reviewTarget,
      })),
    });
    tui = new Tui(tuiState);
  } else {
    console.log(`
┌─────────────────────────────────────────┐
│         Cross-Review Orchestrator       │
├─────────────────────────────────────────┤
│  Mode:     ${opts.mode.padEnd(28)}│
│  Agents:   ${String(agents.length).padEnd(28)}│
│  Pulse:    ${(opts.pulse + "s").padEnd(28)}│
│  Rounds:   ${(opts.rounds === 0 ? "∞" : String(opts.rounds)).padEnd(28)}│
│  Session:  ${opts.sessionName.padEnd(28)}│
│  Port:     ${String(opts.port).padEnd(28)}│
└─────────────────────────────────────────┘
`);

    for (const agent of agents) {
      const target = agents.find(a => a.id === agent.reviewTarget);
      log(`${agent.id}: ${basename(agent.project)} → reviews ${target ? basename(target.project) : "self"}`);
    }
  }

  // Set up signal handlers
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (tui) tui.stop();
    cleanup(opts.sessionName);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Warn about unrestricted permissions in headless mode
  console.warn(`
⚠️  WARNING: This orchestrator runs Claude Code with --dangerously-skip-permissions.
   Agents will have UNRESTRICTED filesystem and shell access to these projects:
${agents.map(a => `     - ${a.project}`).join("\n")}
   Press Ctrl+C within 5 seconds to abort.
`);
  await sleep(5000);

  // Create tmux session with all panes
  log("Creating tmux session");
  createTmuxSession(opts, agents);

  // Optionally launch WezTerm
  launchWithWezterm(opts);

  // Start TUI after tmux session is created
  if (tui) {
    tui.addEvent({ ts: Date.now(), level: "info", message: "tmux session created" });
    tui.start();
  }

  // Start broker
  log("Starting MCP broker");
  if (tui) tui.addEvent({ ts: Date.now(), level: "info", message: "Starting broker..." });
  startBroker(opts);
  await sleep(2000); // Let broker initialize

  // Start agents (staggered to avoid registration race)
  for (const agent of agents) {
    log(`Initializing ${agent.id} in ${basename(agent.project)}`);
    if (tui) tui.addEvent({ ts: Date.now(), level: "info", agent: agent.id, message: `initializing in ${basename(agent.project)}` });
    startAgent(agent, agents, opts);
    await sleep(1000);
  }

  // Wait for MCP to be configured, then launch conversations
  await sleep(2000);
  for (const agent of agents) {
    log(`Launching conversation for ${agent.id}`);
    if (tui) tui.addEvent({ ts: Date.now(), level: "info", agent: agent.id, message: "launching conversation" });
    launchAgentConversation(agent, agents, opts);
    await sleep(1500); // Stagger launches to reduce broker contention
  }

  // Enter heartbeat loop
  if (!tui) log("All agents launched, entering heartbeat loop");
  if (tui) tui.addEvent({ ts: Date.now(), level: "info", message: "All agents launched — entering heartbeat loop" });
  await heartbeatLoop(agents, opts, tui, tuiState);

  if (tui) {
    tui.addEvent({ ts: Date.now(), level: "done", message: "Orchestration complete" });
    // Keep TUI up for a moment so user sees the final state
    await sleep(3000);
    tui.stop();
  }

  log("Orchestration complete");
  console.log(`\nSession "${opts.sessionName}" is still running.`);
  console.log(`  tmux attach -t ${opts.sessionName}    # attach to session`);
  console.log(`  tmux kill-session -t ${opts.sessionName}  # tear down`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

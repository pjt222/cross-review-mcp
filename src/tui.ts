/**
 * Cross-Review TUI — Terminal dashboard with viridis color scheme
 *
 * Full-screen alternate-buffer interface for monitoring orchestrated
 * Claude Code conversations. Renders agent status, broker health,
 * phase topology, heartbeat timeline, and a scrolling event log.
 *
 * Viridis palette (Matplotlib default sequential):
 *   dark indigo → teal → green → yellow
 */

import { execSync } from "node:child_process";

// ── Viridis 256-color palette ──────────────────────────────────────────
// Sampled at 8 stops along the viridis gradient, mapped to xterm-256 indices

export const V = {
  bg:       "\x1b[48;5;234m",    // dark background
  bgAlt:    "\x1b[48;5;235m",    // slightly lighter bg for alternating rows
  indigo:   "\x1b[38;5;55m",     // #440154 — deep viridis start
  purple:   "\x1b[38;5;62m",     // #482878
  blue:     "\x1b[38;5;25m",     // #3e4989
  teal:     "\x1b[38;5;30m",     // #31688e
  cyan:     "\x1b[38;5;37m",     // #21918c
  green:    "\x1b[38;5;78m",     // #35b779
  lime:     "\x1b[38;5;149m",    // #90d743
  yellow:   "\x1b[38;5;226m",    // #fde725 — viridis end
  dim:      "\x1b[38;5;242m",    // muted gray
  white:    "\x1b[38;5;253m",    // near-white text
  bold:     "\x1b[1m",
  reset:    "\x1b[0m",
  // Bright variants for emphasis
  bIndigo:  "\x1b[1;38;5;55m",
  bTeal:    "\x1b[1;38;5;30m",
  bCyan:    "\x1b[1;38;5;37m",
  bGreen:   "\x1b[1;38;5;78m",
  bLime:    "\x1b[1;38;5;149m",
  bYellow:  "\x1b[1;38;5;226m",
} as const;

// Phase → viridis color mapping (progression through the gradient)
const PHASE_COLOR: Record<string, string> = {
  registered: V.indigo,
  briefing:   V.purple,
  review:     V.teal,
  dialogue:   V.cyan,
  synthesis:  V.green,
  complete:   V.yellow,
};

const PHASE_ICON: Record<string, string> = {
  registered: "○",
  briefing:   "◐",
  review:     "◑",
  dialogue:   "◕",
  synthesis:  "◉",
  complete:   "●",
};

// Idle severity → color
function idleColor(cycles: number): string {
  if (cycles === 0) return V.green;
  if (cycles === 1) return V.lime;
  if (cycles < 3) return V.yellow;
  if (cycles < 5) return V.cyan;
  return V.indigo;
}

// ── ANSI helpers ───────────────────────────────────────────────────────

const ESC = "\x1b";
const CSI = `${ESC}[`;

const ansi = {
  altScreenOn:  `${CSI}?1049h`,
  altScreenOff: `${CSI}?1049l`,
  cursorHide:   `${CSI}?25l`,
  cursorShow:   `${CSI}?25h`,
  clear:        `${CSI}2J${CSI}H`,
  moveTo:       (row: number, col: number) => `${CSI}${row};${col}H`,
  eraseRight:   `${CSI}K`,
};

// ── Types ──────────────────────────────────────────────────────────────

export interface TuiAgent {
  id: string;
  project: string;
  reviewTarget?: string;
  phase: string;
  idleCycles: number;
  lastActivity: string;  // timestamp or snippet
  paneContent: string;   // last captured pane text (truncated)
}

export interface TuiBrokerStatus {
  healthy: boolean;
  agentCount: number;
  uptime: number;        // seconds
}

export interface TuiState {
  mode: string;
  sessionName: string;
  port: number;
  pulse: number;
  rounds: number;
  currentRound: number;
  agents: TuiAgent[];
  broker: TuiBrokerStatus;
  events: TuiEvent[];
  startedAt: number;
  selectedAgent: number; // index into agents for detail view
}

export interface TuiEvent {
  ts: number;
  level: "info" | "warn" | "pulse" | "nudge" | "phase" | "done";
  agent?: string;
  message: string;
}

// ── Viridis gradient bar ───────────────────────────────────────────────

const GRADIENT_COLORS = [55, 54, 62, 61, 25, 24, 30, 31, 37, 36, 42, 78, 114, 149, 185, 226];

function viridisBar(width: number, fill: number): string {
  const filled = Math.round((fill / 100) * width);
  let bar = "";
  for (let i = 0; i < width; i++) {
    const colorIdx = Math.floor((i / width) * GRADIENT_COLORS.length);
    const color = GRADIENT_COLORS[Math.min(colorIdx, GRADIENT_COLORS.length - 1)];
    if (i < filled) {
      bar += `\x1b[38;5;${color}m█`;
    } else {
      bar += `${V.dim}░`;
    }
  }
  return bar + V.reset;
}

function viridisSparkline(values: number[], width: number): string {
  if (values.length === 0) return V.dim + "─".repeat(width) + V.reset;
  const sparks = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values, 1);
  const recent = values.slice(-width);
  let line = "";
  for (let i = 0; i < width; i++) {
    const idx = i - (width - recent.length);
    if (idx < 0) {
      line += V.dim + "─";
      continue;
    }
    const val = recent[idx];
    const sparkIdx = Math.floor((val / max) * (sparks.length - 1));
    const colorIdx = Math.floor((val / max) * (GRADIENT_COLORS.length - 1));
    const color = GRADIENT_COLORS[colorIdx];
    line += `\x1b[38;5;${color}m${sparks[sparkIdx]}`;
  }
  return line + V.reset;
}

// ── Layout renderer ────────────────────────────────────────────────────

export class Tui {
  private state: TuiState;
  private rows: number = 24;
  private cols: number = 80;
  private running = false;
  private renderTimer?: ReturnType<typeof setInterval>;
  private pulseHistory: number[] = [];     // idle counts per pulse
  private phaseHistory: Map<string, string[]> = new Map();

  constructor(state: TuiState) {
    this.state = state;
    this.updateSize();
  }

  private updateSize(): void {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Enter alternate screen, hide cursor
    process.stdout.write(ansi.altScreenOn + ansi.cursorHide);

    // Handle resize
    process.stdout.on("resize", () => {
      this.updateSize();
      this.render();
    });

    // Handle keyboard input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (key: string) => this.handleKey(key));
    }

    // Render at 4fps
    this.renderTimer = setInterval(() => this.render(), 250);
    this.render();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write(ansi.cursorShow + ansi.altScreenOff);
  }

  private handleKey(key: string): void {
    switch (key) {
      case "q":
      case "\x03": // Ctrl+C
        this.stop();
        process.emit("SIGINT" as any);
        break;
      case "j":
      case "\x1b[B": // Down arrow
        this.state.selectedAgent = Math.min(
          this.state.selectedAgent + 1,
          this.state.agents.length - 1
        );
        break;
      case "k":
      case "\x1b[A": // Up arrow
        this.state.selectedAgent = Math.max(this.state.selectedAgent - 1, 0);
        break;
      case "\t": // Tab cycles agents
        this.state.selectedAgent = (this.state.selectedAgent + 1) % this.state.agents.length;
        break;
    }
  }

  updateState(partial: Partial<TuiState>): void {
    Object.assign(this.state, partial);
  }

  addEvent(event: TuiEvent): void {
    this.state.events.push(event);
    // Keep last 200 events
    if (this.state.events.length > 200) {
      this.state.events = this.state.events.slice(-200);
    }
  }

  recordPulse(): void {
    const totalIdle = this.state.agents.reduce((s, a) => s + a.idleCycles, 0);
    this.pulseHistory.push(totalIdle);
    if (this.pulseHistory.length > 120) this.pulseHistory.shift();

    for (const agent of this.state.agents) {
      if (!this.phaseHistory.has(agent.id)) this.phaseHistory.set(agent.id, []);
      const history = this.phaseHistory.get(agent.id)!;
      history.push(agent.phase);
      if (history.length > 60) history.shift();
    }
  }

  // ── Render sections ────────────────────────────────────────────────

  private render(): void {
    this.updateSize();
    const buf: string[] = [];
    const W = this.cols;

    buf.push(ansi.clear);

    // Header
    buf.push(this.renderHeader(W));
    buf.push(this.renderBrokerBar(W));
    buf.push(this.renderDivider(W, "agents"));

    // Agent panels
    for (let i = 0; i < this.state.agents.length; i++) {
      buf.push(this.renderAgentRow(this.state.agents[i], i, W));
    }

    // Topology
    buf.push(this.renderDivider(W, "topology"));
    buf.push(this.renderTopology(W));

    // Pulse timeline
    buf.push(this.renderDivider(W, "heartbeat"));
    buf.push(this.renderPulseTimeline(W));

    // Agent detail (selected)
    if (this.state.agents.length > 0) {
      buf.push(this.renderDivider(W, "pane preview"));
      buf.push(this.renderPanePreview(W));
    }

    // Event log (fills remaining space)
    buf.push(this.renderDivider(W, "events"));
    const usedRows = buf.join("").split("\n").length;
    const logRows = Math.max(4, this.rows - usedRows - 2);
    buf.push(this.renderEventLog(W, logRows));

    // Footer
    buf.push(this.renderFooter(W));

    process.stdout.write(buf.join("\n"));
  }

  private renderHeader(W: number): string {
    const elapsed = Math.floor((Date.now() - this.state.startedAt) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");

    const title = ` CROSS-REVIEW `;
    const modeTag = ` ${this.state.mode.toUpperCase()} `;
    const roundTag = `R${this.state.currentRound}/${this.state.rounds === 0 ? "∞" : this.state.rounds}`;
    const timeTag = `${mm}:${ss}`;

    const left = `${V.bold}${V.bg}\x1b[38;5;226m${title}${V.reset}${V.bg} ${V.bCyan}${modeTag}${V.reset}`;
    const right = `${V.dim}${roundTag}  ${V.green}${timeTag}${V.reset}`;

    // Approximate visible length (strip ANSI)
    const visLeft = stripAnsi(left).length;
    const visRight = stripAnsi(right).length;
    const pad = Math.max(1, W - visLeft - visRight);

    return left + " ".repeat(pad) + right;
  }

  private renderBrokerBar(W: number): string {
    const b = this.state.broker;
    const status = b.healthy
      ? `${V.green}● broker:${this.state.port}${V.reset}`
      : `${V.indigo}○ broker:${this.state.port} UNREACHABLE${V.reset}`;
    const agents = `${V.cyan}${b.agentCount} agents${V.reset}`;
    const session = `${V.dim}session: ${this.state.sessionName}${V.reset}`;
    const pulse = `${V.dim}pulse: ${this.state.pulse}s${V.reset}`;
    return `  ${status}  ${agents}  ${session}  ${pulse}`;
  }

  private renderDivider(W: number, label?: string): string {
    if (!label) return V.dim + "─".repeat(W) + V.reset;
    const bar = "─".repeat(2);
    const rest = "─".repeat(Math.max(0, W - label.length - 5));
    return `${V.dim}${bar} ${V.teal}${label} ${V.dim}${rest}${V.reset}`;
  }

  private renderAgentRow(agent: TuiAgent, idx: number, W: number): string {
    const selected = idx === this.state.selectedAgent;
    const sel = selected ? `${V.bYellow}>` : " ";
    const phaseCol = PHASE_COLOR[agent.phase] || V.dim;
    const icon = PHASE_ICON[agent.phase] || "?";
    const idleCol = idleColor(agent.idleCycles);

    const id = `${V.bCyan}${agent.id}${V.reset}`;
    const phase = `${phaseCol}${icon} ${agent.phase.padEnd(12)}${V.reset}`;
    const idle = `${idleCol}idle:${agent.idleCycles}${V.reset}`;
    const project = `${V.dim}${truncate(agent.project, 30)}${V.reset}`;
    const target = agent.reviewTarget
      ? `${V.green}→ ${agent.reviewTarget}${V.reset}`
      : "";

    // Phase progress bar (6 phases)
    const phases = ["registered", "briefing", "review", "dialogue", "synthesis", "complete"];
    const phaseIdx = phases.indexOf(agent.phase);
    const progress = phaseIdx >= 0 ? Math.round(((phaseIdx + 1) / phases.length) * 100) : 0;
    const bar = viridisBar(16, progress);

    return `${sel} ${id} ${phase} ${bar} ${idle}  ${project} ${target}`;
  }

  private renderTopology(W: number): string {
    const agents = this.state.agents;
    if (agents.length === 0) return `  ${V.dim}(no agents)${V.reset}`;

    if (this.state.mode === "monologue") {
      const a = agents[0];
      const col = PHASE_COLOR[a.phase] || V.dim;
      return `  ${col}${a.id} ⟲ self-review${V.reset}`;
    }

    // Ring visualization
    const parts: string[] = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const col = PHASE_COLOR[a.phase] || V.dim;
      const icon = PHASE_ICON[a.phase] || "○";
      parts.push(`${col}${icon}${a.id.replace("agent-", "")}${V.reset}`);
      if (i < agents.length - 1) {
        parts.push(`${V.teal}→${V.reset}`);
      }
    }
    // Close the ring
    parts.push(`${V.teal}→${V.reset}`);
    const firstCol = PHASE_COLOR[agents[0].phase] || V.dim;
    parts.push(`${firstCol}${PHASE_ICON[agents[0].phase] || "○"}${agents[0].id.replace("agent-", "")}${V.reset}`);

    return `  ${parts.join(" ")}`;
  }

  private renderPulseTimeline(W: number): string {
    const sparkW = Math.min(W - 20, 80);
    const spark = viridisSparkline(this.pulseHistory, sparkW);
    const label = `${V.dim}idle Σ${V.reset}`;
    return `  ${label} ${spark}`;
  }

  private renderPanePreview(W: number): string {
    const agent = this.state.agents[this.state.selectedAgent];
    if (!agent) return "";

    const lines = agent.paneContent.split("\n").slice(-5);
    const maxW = W - 4;
    return lines
      .map(l => `  ${V.dim}│${V.reset} ${V.white}${truncate(l, maxW)}${V.reset}`)
      .join("\n");
  }

  private renderEventLog(W: number, maxRows: number): string {
    const events = this.state.events.slice(-maxRows);
    if (events.length === 0) {
      return `  ${V.dim}(no events yet)${V.reset}`;
    }

    const levelColor: Record<string, string> = {
      info:  V.white,
      warn:  V.yellow,
      pulse: V.teal,
      nudge: V.lime,
      phase: V.green,
      done:  V.bYellow,
    };

    return events.map(e => {
      const ts = new Date(e.ts).toISOString().slice(11, 19);
      const col = levelColor[e.level] || V.dim;
      const agentTag = e.agent ? `${V.cyan}${e.agent}${V.reset} ` : "";
      return `  ${V.dim}${ts}${V.reset} ${agentTag}${col}${truncate(e.message, W - 22)}${V.reset}`;
    }).join("\n");
  }

  private renderFooter(W: number): string {
    const keys = `${V.dim}q${V.teal}:quit  ${V.dim}j/k${V.teal}:select  ${V.dim}tab${V.teal}:cycle${V.reset}`;
    const viridisLabel = `${V.indigo}v${V.purple}i${V.blue}r${V.teal}i${V.cyan}d${V.green}i${V.lime}s${V.reset}`;
    return `${V.dim}${"─".repeat(W)}${V.reset}\n  ${keys}${"  ".repeat(3)}${viridisLabel}`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Factory ────────────────────────────────────────────────────────────

export function createTuiState(opts: {
  mode: string;
  sessionName: string;
  port: number;
  pulse: number;
  rounds: number;
  agents: { id: string; project: string; reviewTarget?: string }[];
}): TuiState {
  return {
    mode: opts.mode,
    sessionName: opts.sessionName,
    port: opts.port,
    pulse: opts.pulse,
    rounds: opts.rounds,
    currentRound: 0,
    agents: opts.agents.map(a => ({
      ...a,
      phase: "registered",
      idleCycles: 0,
      lastActivity: "–",
      paneContent: "",
    })),
    broker: { healthy: false, agentCount: 0, uptime: 0 },
    events: [],
    startedAt: Date.now(),
    selectedAgent: 0,
  };
}

/**
 * Cross-Review MCP Broker — Type Definitions
 *
 * Informed by QSG scaling laws (Tanaka, 2026):
 * - Finding bundles enforce bandwidth m ≥ 3 to stay in the selection regime
 * - Response verdicts with evidence structurally enforce α < 1
 * - Phase signaling prevents premature consensus
 */

// --- Phase lifecycle ---

export const PHASES = ["registered", "briefing", "review", "dialogue", "complete"] as const;
export type Phase = typeof PHASES[number];

// --- Agent identity ---

export interface AgentRegistration {
  agentId: string;
  project: string;
  capabilities: string[];
  registeredAt: number;
}

// --- Briefing artifacts ---

export interface Briefing {
  project: string;
  language: string;
  entryPoints: string[];
  dependencyGraph: Record<string, string[]>;
  patterns: PatternDescriptor[];
  knownIssues: Issue[];
  testCoverage: TestCoverage;
}

export interface PatternDescriptor {
  name: string;
  files: string[];
  description: string;
}

export interface Issue {
  severity: "low" | "medium" | "high";
  description: string;
}

export interface TestCoverage {
  hasTests: boolean;
  framework?: string;
  count?: number;
}

// --- Review findings ---

export type FindingCategory =
  | "pattern_transfer"
  | "missing_practice"
  | "inconsistency"
  | "simplification"
  | "bug_risk"
  | "documentation_gap";

export interface Finding {
  id: string;
  category: FindingCategory;
  targetFile: string;
  targetLines?: [number, number];
  description: string;
  evidence: string;
  suggestion?: string;
  sourceAnalog?: string;
}

// --- Responses ---

export interface FindingResponse {
  findingId: string;
  verdict: "accept" | "reject" | "discuss";
  evidence: string;
  counterEvidence?: string;
}

// --- Task envelope ---

export type TaskType = "briefing" | "review_bundle" | "question" | "response";

export interface Task {
  id: string;
  from: string;
  to: string;
  type: TaskType;
  payload: Briefing | Finding[] | Question | FindingResponse[];
  createdAt: number;
}

export interface Question {
  id: string;
  aboutFile: string;
  question: string;
  context?: string;
}

// --- Broker state ---

export interface BrokerState {
  agents: Map<string, AgentRegistration>;
  phases: Map<string, Phase>;
  taskQueues: Map<string, Task[]>;
  phaseWaiters: Map<string, PhaseWaiter[]>;
}

export interface PhaseWaiter {
  targetPhase: Phase;
  resolve: (value: { reached: boolean }) => void;
}

/**
 * QSG-derived minimum bandwidth constant.
 * From Γ_h = mN·h/α > 1 with N=2, α≈0.3, h≈0.05 → m > 3
 */
export const MIN_BANDWIDTH = 3;

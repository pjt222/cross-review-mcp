/**
 * Cross-Review MCP Broker — Type Definitions
 *
 * Informed by QSG scaling laws (Tanaka, 2026):
 * - Finding bundles enforce bandwidth m ≥ 3 to stay in the selection regime
 * - Response verdicts with evidence structurally enforce α < 1
 * - Phase signaling prevents premature consensus
 */

// --- Phase lifecycle ---

export const PHASES = ["registered", "briefing", "review", "dialogue", "synthesis", "complete"] as const;
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

// --- Synthesis ---

export interface SynthesisAccepted {
  findingId: string;
  action: string;
}

export interface SynthesisRejected {
  findingId: string;
  reason: string;
}

export interface Synthesis {
  agentId: string;
  project: string;
  accepted: SynthesisAccepted[];
  rejected: SynthesisRejected[];
}

// --- Responses ---

export interface FindingResponse {
  findingId: string;
  verdict: "accept" | "reject" | "discuss";
  evidence: string;
  counterEvidence?: string;
}

// --- Task envelope ---

export type TaskType = "briefing" | "review_bundle" | "question" | "response" | "synthesis";

export interface Task {
  id: string;
  from: string;
  to: string;
  type: TaskType;
  payload: Briefing | Finding[] | Question | FindingResponse[] | Synthesis;
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
  /** Track task types each agent has sent, for phase precondition checks. */
  sentTaskTypes: Map<string, Set<TaskType>>;
}

export interface PhaseWaiter {
  targetPhase: Phase;
  resolve: (value: { reached: boolean }) => void;
}

/**
 * QSG-derived minimum bandwidth constant.
 *
 * From Γ_h = mN·h/α with N=2, α≈0.3, h≈0.05:
 *   m=3 → Γ_h = 1.0 (critical boundary, not selection regime)
 *   m=5 → Γ_h = 5/3 ≈ 1.67 (safely above boundary)
 *
 * Note: h/α = 1/6 = 1/|FindingCategory|. Adding categories
 * without raising this constant degrades selection pressure.
 */
export const MIN_BANDWIDTH = 5;

// --- MemPalace integration ---

export interface MemPalaceConfig {
  /** Base URL of the MemPalace MCP server (e.g., "http://localhost:5173/mcp") */
  url: string;
  /** Palace path for storage (defaults to "~/.mempalace/palace") */
  palacePath?: string;
  /** Wing name for cross-review artifacts (defaults to "cross-review") */
  wing?: string;
}

export type MemPalaceArtifactKind = "briefing" | "finding" | "response" | "synthesis";

export interface MemPalaceEntry {
  id: string;
  agentId: string;
  project: string;
  kind: MemPalaceArtifactKind;
  phase: Phase;
  content: string;
  storedAt: number;
}

export interface MemPalaceState {
  enabled: boolean;
  config: MemPalaceConfig | null;
  /** Local buffer of stored entries (for status reporting) */
  entries: MemPalaceEntry[];
}

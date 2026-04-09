/**
 * Cross-Review MCP Broker — Type Definitions
 *
 * Informed by QSG scaling laws (Tanaka, 2026):
 * - Finding bundles enforce bandwidth m ≥ 3 to stay in the selection regime
 * - Response verdicts with evidence structurally enforce α < 1
 * - Phase signaling prevents premature consensus
 *
 * EvoSkills integration (Zhang et al., 2026, arXiv:2604.01687):
 * - Skill Generator ↔ Surrogate Verifier co-evolution maps onto
 *   the two-agent cross-review architecture
 * - Multi-file skill packages exchanged as structured artifacts
 * - Iterative refinement bounded by MAX_EVOLUTION_ROUNDS
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

// --- EvoSkills: Skill packages (Zhang et al., 2026) ---

export interface SkillArtifact {
  filename: string;
  content: string;
  role: "entry" | "helper" | "config" | "test";
}

export interface SkillPackage {
  skillId: string;
  name: string;
  description: string;
  artifacts: SkillArtifact[];
  evolutionRound: number;
  parentSkillId?: string;
}

export interface SkillVerification {
  skillId: string;
  pass: boolean;
  score: number;
  feedback: string;
  testCases: SkillTestCase[];
}

export interface SkillTestCase {
  input: string;
  expectedBehavior: string;
  passed: boolean;
  observation?: string;
}

export interface SkillEvolutionState {
  agentId: string;
  currentRound: number;
  skillHistory: { skillId: string; score: number }[];
  converged: boolean;
}

// --- Task envelope ---

export type TaskType = "briefing" | "review_bundle" | "question" | "response" | "synthesis" | "skill_bundle" | "skill_verification";

export interface Task {
  id: string;
  from: string;
  to: string;
  type: TaskType;
  payload: Briefing | Finding[] | Question | FindingResponse[] | Synthesis | SkillPackage | SkillVerification;
  createdAt: number;
  /** Review round this task belongs to (0-indexed). */
  round: number;
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
  /** EvoSkills: per-agent skill evolution state. */
  skillEvolution: Map<string, SkillEvolutionState>;
  /** Current review round per agent (0-indexed). */
  rounds: Map<string, number>;
  /** Archived tasks from completed rounds, per agent. */
  roundHistory: Map<string, Task[][]>;
  /** Long-poll waiters: agents waiting for tasks to arrive. */
  taskWaiters: Map<string, TaskWaiter[]>;
}

export interface PhaseWaiter {
  targetPhase: Phase;
  resolve: (value: { reached: boolean }) => void;
}

export interface TaskWaiter {
  resolve: (value: { tasks: Task[]; count: number }) => void;
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

/**
 * EvoSkills co-evolutionary constants (Zhang et al., 2026).
 *
 * MAX_EVOLUTION_ROUNDS: Paper shows skills surpass human-curated
 * quality within 5 iterations; capping prevents runaway loops.
 *
 * MIN_SKILL_ARTIFACTS: Skills are multi-file packages by definition;
 * a single file is just a script, not a composable skill.
 *
 * SKILL_CONVERGENCE_THRESHOLD: When consecutive verification scores
 * differ by less than this, the skill is considered converged.
 */
export const MAX_EVOLUTION_ROUNDS = 5;
export const MIN_SKILL_ARTIFACTS = 2;
export const SKILL_CONVERGENCE_THRESHOLD = 0.05;

// --- MemPalace integration ---

export interface MemPalaceConfig {
  /** Base URL of the MemPalace MCP server (reserved for future external integration) */
  url: string;
  /** Palace path for storage */
  palacePath: string;
  /** Wing name for cross-review artifacts */
  wing: string;
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
  /** Local in-memory buffer of stored entries (not persisted to external MemPalace server yet) */
  entries: MemPalaceEntry[];
}

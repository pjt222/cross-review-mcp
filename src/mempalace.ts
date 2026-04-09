/**
 * MemPalace Integration — Cross-Review MCP Broker
 *
 * In-memory artifact cache for review artifacts (briefings, findings,
 * responses, synthesis) organized in MemPalace-style hierarchy.
 * Data lives in-process only — lost on broker restart.
 *
 * Hierarchy: Wing ("cross-review") → Room (project name) → Drawer (artifact)
 *
 * Future: connect to external MemPalace server for persistence.
 * See: https://github.com/mila-jovovich/mempalace
 */

import type {
  MemPalaceConfig,
  MemPalaceEntry,
  MemPalaceArtifactKind,
  MemPalaceState,
  Phase,
  BrokerState,
  Finding,
  Synthesis,
} from "./types.js";
import type { ToolResult } from "./broker.js";

function textResult(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function generateEntryId(): string {
  return `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a fresh MemPalace state for the broker.
 */
export function createMemPalaceState(): MemPalaceState {
  return {
    enabled: false,
    config: null,
    entries: [],
  };
}

/**
 * Format a cross-review artifact into MemPalace AAAK-style compressed content.
 * AAAK is MemPalace's lossless shorthand dialect (~30x compression).
 */
function formatArtifact(
  kind: MemPalaceArtifactKind,
  agentId: string,
  project: string,
  payload: unknown,
): string {
  switch (kind) {
    case "briefing":
      return `BRIEF:${agentId}|proj=${project}|${JSON.stringify(payload)}`;
    case "finding": {
      const findings = payload as Finding[];
      const categories = findings.map((f) => f.category);
      const uniqueCats = [...new Set(categories)];
      return `FIND:${agentId}|proj=${project}|n=${findings.length}|cats=${uniqueCats.join(",")}|${JSON.stringify(findings.map((f) => ({ id: f.id, cat: f.category, file: f.targetFile, desc: f.description })))}`;
    }
    case "response":
      return `RESP:${agentId}|proj=${project}|${JSON.stringify(payload)}`;
    case "synthesis": {
      const synth = payload as Synthesis;
      return `SYNTH:${agentId}|proj=${project}|accepted=${synth.accepted.length}|rejected=${synth.rejected.length}|${JSON.stringify(payload)}`;
    }
  }
}

// --- Handlers ---

/**
 * Configure the MemPalace integration.
 */
export function handleMemPalaceConfigure(
  mpState: MemPalaceState,
  args: { url: string; palacePath?: string; wing?: string },
): ToolResult {
  const config: MemPalaceConfig = {
    url: args.url,
    palacePath: args.palacePath ?? "~/.mempalace/palace",
    wing: args.wing ?? "cross-review",
  };
  mpState.config = config;
  mpState.enabled = true;

  return textResult({
    configured: true,
    url: config.url,
    palacePath: config.palacePath,
    wing: config.wing,
    hint: "MemPalace integration active. Artifacts will be stored on mempalace_store calls.",
  });
}

/**
 * Store a cross-review artifact in MemPalace.
 */
export function handleMemPalaceStore(
  mpState: MemPalaceState,
  brokerState: BrokerState,
  args: { agentId: string; kind: MemPalaceArtifactKind; payload: string },
): ToolResult {
  if (!mpState.enabled || !mpState.config) {
    return textResult({
      error: "MemPalace integration not configured",
      hint: "Call mempalace_configure first with the MemPalace server URL",
    });
  }

  if (!brokerState.agents.has(args.agentId)) {
    return textResult({ error: "Agent not registered", agentId: args.agentId });
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(args.payload);
  } catch {
    return textResult({ error: "Invalid JSON payload" });
  }

  const agent = brokerState.agents.get(args.agentId)!;
  const phase = brokerState.phases.get(args.agentId) ?? "registered";

  const content = formatArtifact(args.kind, args.agentId, agent.project, parsedPayload);

  const entry: MemPalaceEntry = {
    id: generateEntryId(),
    agentId: args.agentId,
    project: agent.project,
    kind: args.kind,
    phase: phase as Phase,
    content,
    storedAt: Date.now(),
  };

  mpState.entries.push(entry);

  return textResult({
    stored: true,
    entryId: entry.id,
    kind: args.kind,
    project: agent.project,
    wing: mpState.config.wing,
    room: agent.project,
    contentLength: content.length,
  });
}

/**
 * Search stored MemPalace entries.
 */
export function handleMemPalaceSearch(
  mpState: MemPalaceState,
  args: { query: string; kind?: MemPalaceArtifactKind; project?: string; limit?: number },
): ToolResult {
  if (!mpState.enabled || !mpState.config) {
    return textResult({
      error: "MemPalace integration not configured",
      hint: "Call mempalace_configure first",
    });
  }

  const queryLower = args.query.toLowerCase();
  const limit = args.limit ?? 10;

  let results = mpState.entries.filter((entry) => {
    if (args.kind && entry.kind !== args.kind) return false;
    if (args.project && entry.project !== args.project) return false;
    return entry.content.toLowerCase().includes(queryLower);
  });

  results = results.slice(0, limit);

  return textResult({
    results: results.map((e) => ({
      id: e.id,
      kind: e.kind,
      project: e.project,
      agentId: e.agentId,
      phase: e.phase,
      storedAt: e.storedAt,
      contentPreview: e.content.slice(0, 200),
    })),
    count: results.length,
    totalEntries: mpState.entries.length,
  });
}

/**
 * Get MemPalace integration status.
 */
export function handleMemPalaceStatus(mpState: MemPalaceState): ToolResult {
  if (!mpState.enabled) {
    return textResult({
      enabled: false,
      hint: "Call mempalace_configure to enable MemPalace integration",
    });
  }

  const byKind: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const entry of mpState.entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    byProject[entry.project] = (byProject[entry.project] ?? 0) + 1;
  }

  return textResult({
    enabled: true,
    config: mpState.config,
    totalEntries: mpState.entries.length,
    byKind,
    byProject,
  });
}

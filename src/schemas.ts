/**
 * Zod schemas for task payload validation.
 *
 * Centralizes all payload validation that was previously inline in
 * handleSendTask. Each task type has a schema that validates structure
 * and enforces constraints (QSG bandwidth, EvoSkills artifact counts).
 */

import { z } from "zod";
import type { TaskType } from "./types.js";
import {
  MIN_BANDWIDTH,
  MIN_SKILL_ARTIFACTS,
  MAX_EVOLUTION_ROUNDS,
} from "./types.js";

// --- Individual schemas ---

const FindingSchema = z.object({
  id: z.string(),
  category: z.enum([
    "pattern_transfer",
    "missing_practice",
    "inconsistency",
    "simplification",
    "bug_risk",
    "documentation_gap",
  ]),
  targetFile: z.string(),
  targetLines: z.tuple([z.number(), z.number()]).optional(),
  description: z.string(),
  evidence: z.string(),
  suggestion: z.string().optional(),
  sourceAnalog: z.string().optional(),
});

const FindingResponseSchema = z.object({
  findingId: z.string(),
  verdict: z.enum(["accept", "reject", "discuss"]),
  evidence: z.string(),
  counterEvidence: z.string().optional(),
});

const SkillArtifactSchema = z.object({
  filename: z.string(),
  content: z.string(),
  role: z.enum(["entry", "helper", "config", "test"]),
});

export const ReviewBundleSchema = z.array(FindingSchema).min(MIN_BANDWIDTH);
export const ResponseBundleSchema = z.array(FindingResponseSchema).min(1);

export const SkillPackageSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  artifacts: z.array(SkillArtifactSchema).min(MIN_SKILL_ARTIFACTS),
  evolutionRound: z.number().int().min(0).max(MAX_EVOLUTION_ROUNDS - 1).optional().default(0),
  parentSkillId: z.string().optional(),
});

export const SkillVerificationSchema = z.object({
  skillId: z.string(),
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  feedback: z.string(),
  testCases: z.array(z.object({
    input: z.string(),
    expectedBehavior: z.string(),
    passed: z.boolean(),
    observation: z.string().optional(),
  })).optional(),
});

// --- Unwrap helper ---

/** Unwrap single-key wrapper objects: {findings:[...]} -> [...] */
function unwrapArrayPayload(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length === 1) {
      const value = (parsed as Record<string, unknown>)[keys[0]];
      if (Array.isArray(value)) return value;
    }
  }
  return parsed;
}

// --- Validation ---

export interface ValidationResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Validate a task payload against its type schema.
 * Pre-unwraps wrapper objects for array-expecting types.
 * Returns broker-compatible error messages.
 */
export function validatePayload(type: string, raw: unknown): ValidationResult {
  let payload = raw;

  // Pre-unwrap for array-expecting types
  if (type === "review_bundle" || type === "response") {
    payload = unwrapArrayPayload(payload);
  }

  // Type-specific validation
  switch (type) {
    case "review_bundle": {
      if (!Array.isArray(payload)) {
        const receivedDescription = typeof payload === "object" && payload !== null
          ? `object with keys: ${Object.keys(payload).join(", ")}`
          : typeof payload;
        return {
          success: false,
          error: `Review bundles must contain at least ${MIN_BANDWIDTH} findings (QSG bandwidth constraint: Γ_h = mN·h/α > 1)`,
          received: receivedDescription,
        } as ValidationResult & { received: unknown };
      }
      const result = ReviewBundleSchema.safeParse(payload);
      if (!result.success) {
        return {
          success: false,
          error: `Review bundles must contain at least ${MIN_BANDWIDTH} findings (QSG bandwidth constraint: Γ_h = mN·h/α > 1)`,
          received: (payload as unknown[]).length,
          required: MIN_BANDWIDTH,
        } as ValidationResult & { received: unknown; required: number };
      }
      return { success: true, data: result.data };
    }

    case "response": {
      if (!Array.isArray(payload)) {
        const receivedDescription = typeof payload === "object" && payload !== null
          ? `object with keys: ${Object.keys(payload).join(", ")}`
          : typeof payload;
        return {
          success: false,
          error: "Response must contain at least one FindingResponse",
          received: receivedDescription,
        } as ValidationResult & { received: unknown };
      }
      const result = ResponseBundleSchema.safeParse(payload);
      if (!result.success) {
        return {
          success: false,
          error: "Response must contain at least one FindingResponse",
          received: (payload as unknown[]).length,
        } as ValidationResult & { received: unknown };
      }
      return { success: true, data: result.data };
    }

    case "skill_bundle": {
      const result = SkillPackageSchema.safeParse(payload);
      if (!result.success) {
        const issues = result.error.issues;
        const missingField = issues.find((i) => i.code === "invalid_type" && i.path?.length <= 1);
        if (missingField) {
          return { success: false, error: "Skill bundle must include skillId, name, and artifacts array" };
        }
        const artifactIssue = issues.find((i) => i.path?.includes("artifacts"));
        if (artifactIssue) {
          return {
            success: false,
            error: `Skill packages must contain at least ${MIN_SKILL_ARTIFACTS} artifacts (EvoSkills multi-file constraint)`,
          };
        }
        const roundIssue = issues.find((i) => i.path?.includes("evolutionRound"));
        if (roundIssue) {
          return { success: false, error: `Skill has reached maximum evolution rounds (${MAX_EVOLUTION_ROUNDS})` };
        }
        return { success: false, error: `Payload validation failed: ${issues[0].message}` };
      }
      return { success: true, data: result.data };
    }

    case "skill_verification": {
      const result = SkillVerificationSchema.safeParse(payload);
      if (!result.success) {
        const issues = result.error.issues;
        const missingField = issues.find((i) => i.code === "invalid_type" && i.path?.length <= 1);
        if (missingField) {
          return { success: false, error: "Skill verification must include skillId, pass, and score" };
        }
        const scoreIssue = issues.find((i) => i.path?.includes("score"));
        if (scoreIssue) {
          return { success: false, error: "Verification score must be between 0 and 1" };
        }
        return { success: false, error: `Payload validation failed: ${issues[0].message}` };
      }
      return { success: true, data: result.data };
    }

    default:
      // Briefing, question, synthesis — passthrough
      return { success: true, data: payload };
  }
}

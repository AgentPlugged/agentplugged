import { z } from "zod";
import { DOMAIN_IDS, PHASE_IDS, SkillNameSchema } from "./method-config.js";
import { MODEL_TIERS, type ModelTier } from "./models.js";

export { MODEL_TIERS, type ModelTier, SkillNameSchema };

/** Risk level of an agent's actions. */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const portableKeys = {
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).max(500).optional(),
  /** Space-separated list of pre-approved tools (experimental in the standard). */
  "allowed-tools": z.string().optional(),
};

/** Frontmatter of a skill's `SKILL.md`: only the portable keys of the standard. */
export const SkillFrontmatterSchema = z.strictObject({
  ...portableKeys,
  metadata: z.record(z.string(), z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/** `metadata` of an agent: its own fields, as strings; other string entries are allowed. */
export const AgentMetadataSchema = z
  .object({
    domain: z.enum(DOMAIN_IDS),
    phase: z.enum(PHASE_IDS),
    risk: z.enum(RISK_LEVELS),
    model_tier: z.enum(MODEL_TIERS),
    /**
     * A developer's specialty: a field of work (`backend`, `frontend`, `mobile`, or
     * the creator's own, such as `embedded`), never a language. An agent of the `code` domain
     * that carries one is a developer: one instance per story, in its own worktree.
     */
    specialty: SkillNameSchema.optional(),
  })
  .catchall(z.string());

/** Frontmatter of an agent's `SKILL.md`. */
export const AgentFrontmatterSchema = z.strictObject({
  ...portableKeys,
  metadata: AgentMetadataSchema,
});

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

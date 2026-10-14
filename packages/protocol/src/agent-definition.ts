import { z } from "zod";
import { ISSUE } from "./issues.js";
import { MODEL_TIERS } from "./models.js";
import { SkillNameSchema } from "./skill-definition.js";

const Text = z.string().trim().min(1);

/** One entry of an agent's menu: exactly one of `skill` (a skill to call) or `prompt`. */
export const AgentMenuItemSchema = z
  .strictObject({
    /** Short code the creator can type, unique in the menu (for example `FP`). */
    code: z.string().regex(/^[A-Za-z0-9-]{1,12}$/, { message: ISSUE.menuCode }),
    description: Text,
    skill: SkillNameSchema.optional(),
    prompt: Text.optional(),
  })
  .superRefine((item, context) => {
    const count = Number(item.skill !== undefined) + Number(item.prompt !== undefined);
    if (count !== 1) {
      context.addIssue({
        code: "custom",
        path: item.skill !== undefined ? ["prompt"] : ["skill"],
        message: ISSUE.skillOrPrompt,
      });
    }
  });

export type AgentMenuItem = z.infer<typeof AgentMenuItemSchema>;

/** Menu codes are compared without case: `FP` and `fp` are the same item. */
export function menuKey(code: string): string {
  return code.toUpperCase();
}

const MenuSchema = z.array(AgentMenuItemSchema).superRefine((menu, context) => {
  const seen = new Set<string>();
  menu.forEach((item, index) => {
    const key = menuKey(item.code);
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: [index, "code"], message: ISSUE.duplicateCode });
    }
    seen.add(key);
  });
});

/** A sentence, or `file:<project-relative path>` whose contents are loaded as facts. */
const FactSchema = Text.refine((fact) => fact !== "file:", "empty file path");

/** One short trait of the agent's voice, such as "warm and curious" or "unhurried". */
const VoiceTrait = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\r\n]*$/, { message: ISSUE.oneLine });

/**
 * How the agent sounds, for the spoken briefing: `tone` (the attitude it conveys), `pace` (how
 * fast and how dense it speaks) and `register` (how formal it is). A customisation replaces it
 * whole.
 */
export const AgentVoiceSchema = z.strictObject({
  tone: VoiceTrait,
  pace: VoiceTrait,
  register: VoiceTrait,
});

export type AgentVoice = z.infer<typeof AgentVoiceSchema>;

/** Fields of `agent.yaml` a product may adjust, in `.agentplugged/overrides/agents/<id>.yaml`. */
const customisable = {
  icon: z.string().trim().min(1).max(8),
  role: Text,
  identity: Text,
  communication_style: Text,
  voice: AgentVoiceSchema,
} as const;

/**
 * `agent.yaml`, next to an agent's `SKILL.md`: who the agent is and what it offers. `name` and
 * `title` define the agent and are never customised; the other fields may be adjusted later.
 */
export const AgentDefinitionSchema = z.strictObject({
  /** Display name, as the creator reads it ("Iris", "Chloé"). The folder name is the identifier. */
  name: z.string().trim().min(1).max(40),
  title: Text,
  icon: customisable.icon.optional(),
  role: customisable.role.optional(),
  identity: customisable.identity.optional(),
  communication_style: customisable.communication_style.optional(),
  principles: z.array(Text).default([]),
  persistent_facts: z.array(FactSchema).default([]),
  activation_steps_prepend: z.array(Text).default([]),
  activation_steps_append: z.array(Text).default([]),
  menu: MenuSchema.default([]),
  /** How the agent sounds, for the spoken briefing. */
  voice: customisable.voice.optional(),
  /**
   * True when the agent's `SKILL.md` body already says who it is, what it is for and how it
   * sounds: the generated persona then leaves out `role`, `identity` and `voice`
   * (the spoken briefing still reads `voice`), unless the creator's customisation sets one.
   */
  compact_persona: z.boolean().optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/** Fields of `agent.yaml` that define the agent: refused in a customisation. */
export const AGENT_IDENTITY_FIELDS = ["name", "title"] as const;

const refused = z
  .unknown()
  .refine((value) => value === undefined, { message: ISSUE.notCustomisable })
  .optional();

/**
 * A customisation of an agent (`.agentplugged/overrides/agents/<id>.yaml`): the fields of
 * `agent.yaml`, all optional, except `name` and `title`. `sync` merges it at render time: a
 * scalar (`voice` included, replaced whole) replaces the agent's own; a menu item with an
 * existing code replaces that item in place, a new code is added at the end; the other lists are
 * added after the agent's own.
 */
export const AgentOverrideSchema = z.strictObject({
  name: refused,
  title: refused,
  icon: customisable.icon.optional(),
  role: customisable.role.optional(),
  identity: customisable.identity.optional(),
  communication_style: customisable.communication_style.optional(),
  principles: z.array(Text).optional(),
  persistent_facts: z.array(FactSchema).optional(),
  activation_steps_prepend: z.array(Text).optional(),
  activation_steps_append: z.array(Text).optional(),
  menu: MenuSchema.optional(),
  /** Replaces the tier of the agent's definition; `agents.settings.<id>.model_tier` wins. */
  model_tier: z.enum(MODEL_TIERS).optional(),
  /** Replaces the agent's voice whole: `tone`, `pace` and `register` together. */
  voice: customisable.voice.optional(),
});

export type AgentOverride = Omit<z.infer<typeof AgentOverrideSchema>, "name" | "title">;

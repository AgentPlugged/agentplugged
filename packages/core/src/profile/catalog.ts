import {
  DEVELOPER_SPECIALTIES,
  type DeveloperSpecialty,
  DOMAIN_IDS,
  type DomainId,
  MAX_PARALLEL_STORIES,
  PHASE_IDS,
  type PhaseId,
  PROFILE_PRESET_IDS,
  PROFILE_PRESET_SPECS,
  type Profile,
  type ProfilePresetId,
} from "@agentplugged/protocol";

export type { DeveloperSpecialty, DomainId, PhaseId, ProfilePresetId };
export { DEVELOPER_SPECIALTIES, DOMAIN_IDS, MAX_PARALLEL_STORIES, PHASE_IDS, PROFILE_PRESET_IDS };

/** Agents of the method and the domain each one serves (team renamed). */
export const AGENT_DOMAINS = {
  iris: "product",
  maya: "product",
  izzy: "product",
  stella: "ux",
  alex: "architecture",
  sam: "code",
  ethan: "code",
  hugo: "code",
  lina: "code",
  jade: "code",
  quentin: "quality",
  tess: "quality",
  chloe: "security",
  omar: "delivery",
  zoe: "docs",
  lou: "creativity",
  julien: "marketing",
  milo: "sales",
} as const satisfies Record<string, DomainId>;

export type AgentId = keyof typeof AGENT_DOMAINS;

/**
 * The method's developers and their specialty: a developer is active while
 * its specialty is in `profile.specialties`. Several stories may go to the same developer, one
 * instance per story.
 */
export const DEVELOPER_SPECIALTY = {
  sam: "backend",
  ethan: "backend",
  hugo: "frontend",
  lina: "frontend",
  jade: "mobile",
} as const satisfies Partial<Record<AgentId, DeveloperSpecialty>>;

/** The method's developers, in catalog order. */
export const DEVELOPER_AGENTS = Object.keys(DEVELOPER_SPECIALTY) as readonly string[];

export type { PresetSpec } from "@agentplugged/protocol";

/** Starting profiles: the same table the creator's devices read to propose the boxes of a profile. */
export const PROFILE_PRESETS = PROFILE_PRESET_SPECS;

/** Preset applied when the creator just presses Enter, or when nobody can be asked. */
export const DEFAULT_PRESET: ProfilePresetId = "new-product";

export function isPresetId(value: string): value is ProfilePresetId {
  return (PROFILE_PRESET_IDS as readonly string[]).includes(value);
}

/** The specialty of a method's developer, or undefined for any other agent. */
export function specialtyOf(agent: string): DeveloperSpecialty | undefined {
  return Object.hasOwn(DEVELOPER_SPECIALTY, agent)
    ? DEVELOPER_SPECIALTY[agent as keyof typeof DEVELOPER_SPECIALTY]
    : undefined;
}

/** Agents that work for this product: their domain is active, and developers of a specialty on. */
export function activeAgents(profile: Profile): string[] {
  return (Object.keys(AGENT_DOMAINS) as AgentId[])
    .filter((agent) => {
      if (!profile.domains.includes(AGENT_DOMAINS[agent])) return false;
      const specialty = specialtyOf(agent);
      return specialty === undefined || profile.specialties.includes(specialty);
    })
    .sort();
}

/**
 * `agents.inactive`: the method's agents left out by the profile (disabled domain, or developer of
 * a specialty that is off), sorted.
 */
export function inactiveAgents(profile: Profile): string[] {
  const active = new Set(activeAgents(profile));
  return (Object.keys(AGENT_DOMAINS) as AgentId[]).filter((agent) => !active.has(agent)).sort();
}

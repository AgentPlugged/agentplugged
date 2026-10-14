import {
  DEFAULT_PRESET,
  DEVELOPER_SPECIALTIES,
  DOMAIN_IDS,
  inactiveAgents,
  MAX_PARALLEL_STORIES,
  PHASE_IDS,
  PROFILE_PRESET_IDS,
  resolveProfile,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import {
  DEFAULT_INSTALL_MODE,
  DEFAULT_VALIDATION_MODE,
  DEFAULT_VALIDATION_POINTS,
  INSTALL_MODES,
  type InstallMode,
  type Profile,
  VALIDATION_MODES,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import {
  askNumber,
  askYesNo,
  chooseMany,
  chooseOne,
  chooseValue,
  type Prompter,
} from "./prompt.js";

const indexesOf = <T>(catalog: readonly T[], values: readonly T[]) =>
  catalog.flatMap((value, i) => (values.includes(value) ? [i] : []));

/**
 * Asks for the profile: a starting profile, then, on request, domains, phases and developers.
 * `start` is the recorded profile, whose values are the defaults.
 */
export async function chooseProfile(
  t: Translate,
  prompter: Prompter,
  start: Profile | undefined,
): Promise<Profile> {
  const presetIndex = await chooseOne(t, prompter, {
    title: t("profile.title"),
    options: PROFILE_PRESET_IDS.map((id) => ({
      label: t(`profile.preset.${id}`),
      hint: t(`profile.preset.${id}.description`),
    })),
    question: (fallback) => t("profile.prompt.preset", { default: fallback }),
    fallback: PROFILE_PRESET_IDS.indexOf(start?.preset ?? DEFAULT_PRESET),
  });
  const preset = PROFILE_PRESET_IDS[presetIndex] ?? DEFAULT_PRESET;
  const base = start?.preset === preset ? start : resolveProfile(preset);

  if (!(await askYesNo(t, prompter, t("profile.prompt.adjust")))) return base;

  const domains = (
    await chooseMany(t, prompter, {
      title: t("profile.prompt.domains.title"),
      options: DOMAIN_IDS.map((id) => ({ label: t(`profile.domain.${id}`) })),
      question: (fallback) => t("profile.prompt.domains", { default: fallback }),
      fallback: indexesOf(DOMAIN_IDS, base.domains),
    })
  ).flatMap((i) => DOMAIN_IDS[i] ?? []);

  const phases = (
    await chooseMany(t, prompter, {
      title: t("profile.prompt.phases.title"),
      options: PHASE_IDS.map((id) => ({ label: t(`profile.phase.${id}`) })),
      question: (fallback) => t("profile.prompt.phases", { default: fallback }),
      fallback: indexesOf(PHASE_IDS, base.phases),
    })
  ).flatMap((i) => PHASE_IDS[i] ?? []);

  // Without code there is no developer; with it, at least one specialty.
  if (!domains.includes("code")) {
    return resolveProfile(preset, { domains, phases, specialties: [] });
  }
  const current =
    base.specialties.length > 0
      ? base.specialties
      : resolveProfile(preset, { domains }).specialties;
  const specialties = (
    await chooseMany(t, prompter, {
      title: t("profile.prompt.specialties.title"),
      options: DEVELOPER_SPECIALTIES.map((id) => ({
        label: t(`profile.specialty.${id}`),
        hint: t(`profile.specialty.${id}.description`),
      })),
      question: (fallback) => t("profile.prompt.specialties", { default: fallback }),
      fallback: indexesOf(DEVELOPER_SPECIALTIES, current),
    })
  ).flatMap((i) => DEVELOPER_SPECIALTIES[i] ?? []);
  // 0: no ceiling, every story ready may start at once.
  const ceiling = await askNumber(
    t,
    prompter,
    (fallback) =>
      t("profile.prompt.max_parallel", { default: fallback, max: MAX_PARALLEL_STORIES }),
    0,
    MAX_PARALLEL_STORIES,
    base.max_parallel_stories ?? 0,
  );
  return resolveProfile(preset, {
    domains,
    phases,
    specialties,
    ...(ceiling > 0 ? { max_parallel_stories: ceiling } : {}),
  });
}

/**
 * Asks the validation level: `chat`, `auto` or `strict`, with `current` (else
 * `chat`) as the default.
 */
export const chooseValidationMode = (
  t: Translate,
  prompter: Prompter,
  current: ValidationMode | undefined,
): Promise<ValidationMode> =>
  chooseValue(t, prompter, {
    title: t("validation.title"),
    values: VALIDATION_MODES,
    option: (mode) => ({ label: t(`validation.mode.${mode}`) }),
    question: (fallback) => t("validation.prompt", { default: fallback }),
    current,
    fallback: DEFAULT_VALIDATION_MODE,
  });

/**
 * Asks the installs mode: `visible` (the installations the approved architecture
 * plans go through without a validation and show in the activity) or `validate` (one validation
 * per installation), with `current` (else `validate`) as the default.
 */
export const chooseInstallMode = (
  t: Translate,
  prompter: Prompter,
  current: InstallMode | undefined,
): Promise<InstallMode> =>
  chooseValue(t, prompter, {
    title: t("installs.title"),
    values: INSTALL_MODES,
    option: (mode) => ({ label: t(`installs.mode.${mode}`) }),
    question: (fallback) => t("installs.prompt", { default: fallback }),
    current,
    fallback: DEFAULT_INSTALL_MODE,
  });

/**
 * Asks the points that wait for the creator, in one list: the others are decided by the
 * agent responsible for them, with its reason in the journal, and the creator can reopen them. `current`
 * (else the proposed defaults: framing, architecture, release, publication) is the default.
 */
export async function choosePoints(
  t: Translate,
  prompter: Prompter,
  current: readonly ValidationPoint[] | undefined,
): Promise<ValidationPoint[]> {
  const picked = await chooseMany(t, prompter, {
    title: t("points.title"),
    options: VALIDATION_POINTS.map((point) => ({ label: t(`points.point.${point}`) })),
    question: (fallback) => t("points.prompt", { default: fallback }),
    fallback: indexesOf(VALIDATION_POINTS, current ?? DEFAULT_VALIDATION_POINTS),
  });
  return picked.flatMap((index) => VALIDATION_POINTS[index] ?? []);
}

/** The points line. */
export function formatPoints(t: Translate, points: readonly ValidationPoint[]): string {
  const list = points.map((point) => t(`points.point.${point}`)).join(", ");
  return `${t(points.length === 0 ? "points.summary.none" : "points.summary", { list })}\n`;
}

/** The installs mode line. */
export function formatInstallMode(t: Translate, mode: InstallMode): string {
  return `${t("installs.summary", { mode: t(`installs.mode.${mode}`) })}\n`;
}

/** The validation level line. */
export function formatValidationMode(t: Translate, mode: ValidationMode): string {
  return `${t("validation.summary", { mode: t(`validation.mode.${mode}`) })}\n`;
}

/** The profile section: what the method does for this product. */
export function formatProfile(t: Translate, profile: Profile): string {
  const inactive = inactiveAgents(profile);
  const lines = [
    t("profile.summary.title", { preset: t(`profile.preset.${profile.preset}`) }),
    `  ${t("profile.summary.domains", {
      list: profile.domains.map((id) => t(`profile.domain.${id}`)).join(", "),
    })}`,
    `  ${t("profile.summary.phases", {
      list: profile.phases.map((id) => t(`profile.phase.${id}`)).join(", "),
    })}`,
    `  ${
      profile.specialties.length === 0
        ? t("profile.summary.specialties.none")
        : t("profile.summary.specialties", {
            list: profile.specialties.map((id) => t(`profile.specialty.${id}`)).join(", "),
          })
    }`,
    ...(profile.max_parallel_stories === undefined
      ? []
      : [`  ${t("profile.summary.max_parallel", { count: profile.max_parallel_stories })}`]),
    `  ${
      inactive.length === 0
        ? t("profile.summary.inactive.none")
        : t("profile.summary.inactive", { list: inactive.join(", ") })
    }`,
  ];
  return `${lines.join("\n")}\n`;
}

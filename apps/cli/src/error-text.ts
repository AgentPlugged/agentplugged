import { isMessageKey, type MessageParams, type Translate } from "@agentplugged/i18n";
import { displayText } from "./history-text.js";

/**
 * The message of an error in the creator's language. A `reason_key` in the details (a schema
 * reason core recognised) replaces the English `reason` with its translation; the `action` a
 * checkpoint blocks (`CHECKPOINT_OPEN`) is shown by its label (`checkpoint.action.*`).
 */
export function errorMessage(
  t: Translate,
  error: { readonly message_key: string; readonly details: Readonly<Record<string, unknown>> },
): string {
  const params: Record<string, string | number> = {};
  // The errors of deferred work carry texts agents wrote (an item's title): no
  // control character reaches the terminal.
  // The deviations too.
  const agentText =
    /^error\.(?:story_locked|deferred_|deviation_|merge_failed|merge_conflict)/.test(
      error.message_key,
    );
  for (const [key, value] of Object.entries(error.details)) {
    if (typeof value === "string") params[key] = agentText ? displayText(value) : value;
    else if (typeof value === "number") params[key] = value;
    else if (Array.isArray(value)) {
      params[key] = value
        .map((item) => (agentText ? displayText(String(item)) : String(item)))
        .join(", ");
    }
  }
  // A phase by its name (`next.phase.*`); no phase at all is « none », never `null`.
  for (const key of ["phase", "current"]) {
    if (!Object.hasOwn(error.details, key)) continue;
    const value = error.details[key];
    const phaseKey = `next.phase.${value === null ? "none" : String(value)}`;
    if (isMessageKey(phaseKey)) params[key] = t(phaseKey);
  }
  // Why a merge waits for another story, and why a resolution cannot be verified.
  const whyPrefix =
    error.message_key === "error.merge_failed.out_of_order"
      ? "merge.wait"
      : error.message_key === "error.merge_failed.conflict_unverified"
        ? "merge.unverified"
        : undefined;
  const whyKey = `${whyPrefix}.${String(error.details.why)}`;
  if (whyPrefix !== undefined && isMessageKey(whyKey)) params.why = t(whyKey);
  const reasonKey = error.details.reason_key;
  if (typeof reasonKey === "string" && isMessageKey(reasonKey)) {
    params.reason = t(reasonKey, params as MessageParams);
  }
  // A gesture of the forge that failed after its approval: its reason in words, not as a code.
  const gestureKey = `error.forge_gesture.${String(error.details.reason)}`;
  if (error.message_key === "error.creator_action_failed.forge" && isMessageKey(gestureKey)) {
    params.reason = t(gestureKey, params as MessageParams);
  }
  const actionKey = `checkpoint.action.${String(error.details.action)}`;
  if (error.message_key === "error.checkpoint_open" && isMessageKey(actionKey)) {
    params.action = t(actionKey);
  }
  return isMessageKey(error.message_key)
    ? t(error.message_key, params as MessageParams)
    : error.message_key;
}

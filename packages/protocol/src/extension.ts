/**
 * The extension point of the journal: event types of the form `x.<module>.<type>` that a program
 * built on top of the engine writes for its own use.
 *
 * Such an event is signed, chained and ordered like any other, and kept in the journal. An engine
 * that does not know the module never blocks on it: the event is carried through and applied to
 * nothing. Only the types of the core that this engine does not know stop it (`UPGRADE_REQUIRED`).
 * The content of an extension event is always written encrypted with the product key: the engine
 * cannot know what a module puts in it.
 */

/** The reserved first segment of every extension type. */
export const EXTENSION_DOMAIN = "x";

/** The name of a module: lowercase letters, digits and underscores, starting with a letter. */
export const EXTENSION_MODULE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** `x.<module>.<type>`, lowercase. */
export const EXTENSION_TYPE_PATTERN = /^x\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The version an extension event is written at; the module versions its own payload. */
export const EXTENSION_EVENT_VERSION = 1;

/** True for a type of the extension point (`x.<module>.<type>`). */
export function isExtensionEventType(type: string): boolean {
  return EXTENSION_TYPE_PATTERN.test(type);
}

/** The module an extension type belongs to, or undefined for any other type. */
export function extensionModuleOf(type: string): string | undefined {
  return isExtensionEventType(type) ? type.split(".")[1] : undefined;
}

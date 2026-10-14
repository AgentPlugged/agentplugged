/**
 * What the launcher of the MCP server tells the engine it runs, by environment
 * variables: kept apart from the launcher so that the engine reads them without loading it.
 */

/** Marks the process the launcher runs: the engine itself (the server), not a launcher again. */
export const ENGINE_CHILD_ENV = "AGENTPLUGGED_ENGINE_CHILD";
/** The name the server gives its session, kept across children (`server:<id>`). */
export const SESSION_INSTANCE_ENV = "AGENTPLUGGED_SESSION_INSTANCE";
/** The secret that seals the state of a form, kept across children (64 hexadecimal characters). */
export const SESSION_KEY_ENV = "AGENTPLUGGED_SESSION_KEY";

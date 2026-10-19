import { disableSchemaCodegen } from "./schema-runtime.js";

// Importing this module, before anything that defines a schema, turns the run-time code
// generation of the schemas off (the schemas read the setting when they are defined, so it has to
// come first). A page under a strict content policy imports it first.
disableSchemaCodegen();

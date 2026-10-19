import type { z } from "zod";

/**
 * The rule for what a device reads from a machine: a device ignores the optional fields it does
 * not know and still validates every field it knows, so a newer bridge never makes an older app
 * show the machine offline; what a machine reads from a device (orders and their parameters) stays
 * strict, and a field it does not know refuses the order.
 *
 * `readTolerant` derives the reading side from a schema written strict: every object level of it
 * drops the keys it does not declare (they are never kept, shown or run) and keeps every other
 * check as it was: types, bounds, patterns, enumerations and required fields.
 */

type AnyDef = Record<string, unknown> & { type: string };
type Schema = z.ZodType;

const cache = new WeakMap<object, Schema>();

const defOf = (schema: Schema): AnyDef => (schema as unknown as { _zod: { def: AnyDef } })._zod.def;

const cloneWith = (schema: Schema, def: Record<string, unknown>): Schema =>
  (schema as unknown as { clone: (def: Record<string, unknown>) => Schema }).clone(def);

function derive(schema: Schema): Schema {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, Schema>;
      const next: Record<string, Schema> = {};
      for (const key of Object.keys(shape)) next[key] = readTolerant(shape[key] as Schema);
      // No catch-all: an object that carried "never" for unknown keys now strips them.
      return cloneWith(schema, { ...def, shape: next, catchall: undefined });
    }
    case "array":
      return cloneWith(schema, { ...def, element: readTolerant(def.element as Schema) });
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "prefault":
    case "nonoptional":
    case "catch":
      return cloneWith(schema, { ...def, innerType: readTolerant(def.innerType as Schema) });
    case "union":
      return cloneWith(schema, {
        ...def,
        options: (def.options as Schema[]).map((option) => readTolerant(option)),
      });
    case "record":
      return cloneWith(schema, { ...def, valueType: readTolerant(def.valueType as Schema) });
    case "tuple":
      return cloneWith(schema, {
        ...def,
        items: (def.items as Schema[]).map((item) => readTolerant(item)),
      });
    case "pipe":
      return cloneWith(schema, {
        ...def,
        in: readTolerant(def.in as Schema),
        out: readTolerant(def.out as Schema),
      });
    default:
      return schema;
  }
}

/** The same schema, reading what a device receives: unknown keys dropped, known ones as strict as before. */
export function readTolerant<T extends z.ZodType>(schema: T): T {
  const known = cache.get(schema);
  if (known !== undefined) return known as T;
  const derived = derive(schema);
  cache.set(schema, derived);
  return derived as T;
}

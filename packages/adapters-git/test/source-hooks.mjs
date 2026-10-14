// Lets Node.js run this package's TypeScript sources directly (types stripped by Node.js): the
// sources import each other as `./x.js`, resolved here to `./x.ts`. Tests and bench only.

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

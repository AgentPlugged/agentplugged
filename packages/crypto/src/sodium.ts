type Sodium = typeof import("libsodium-wrappers")["default"];
type SodiumSumo = typeof import("libsodium-wrappers-sumo")["default"];

let loading: Promise<Sodium> | undefined;
let loadingSumo: Promise<SodiumSumo> | undefined;

/** libsodium, loaded and initialised once, on first use; a failed load is retried next time. */
export function sodium(): Promise<Sodium> {
  loading ??= import("libsodium-wrappers")
    .then(async ({ default: lib }) => {
      await lib.ready;
      return lib;
    })
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

/**
 * The "sumo" build of libsodium, for Argon2id (`crypto_pwhash`) only, which the standard build
 * leaves out: loaded on first use (`key export` and `key import`), like `sodium()`.
 */
export function sodiumSumo(): Promise<SodiumSumo> {
  loadingSumo ??= import("libsodium-wrappers-sumo")
    .then(async ({ default: lib }) => {
      await lib.ready;
      return lib;
    })
    .catch((error: unknown) => {
      loadingSumo = undefined;
      throw error;
    });
  return loadingSumo;
}

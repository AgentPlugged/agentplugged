/**
 * Test-only entry point (`@agentplugged/crypto/testing`): the product key functions with fixed
 * nonces and salt, for the shared test vectors. Never imported by the product: a fixed nonce or
 * salt reused with a real key breaks the encryption.
 */

export { sealPairBoxWith } from "./pairing.js";
export { encryptPeerMessageWith, type PeerMessageHooks } from "./peer-message.js";
export { sealToPublicKeyWith } from "./primitives.js";
export {
  encryptFileWith,
  encryptPayloadWith,
  exportProductKeyWith,
  type VectorHooks,
} from "./product-key.js";

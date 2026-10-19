import { canonicalBytes, sha256, toBase64url } from "@agentplugged/crypto";
import { type DocumentRef, DocumentRefSchema } from "@agentplugged/protocol";

/**
 * The fingerprint of what the creator saw before giving an order: the documents it refers to, each
 * as `{ path, branch, blob_sha }`. It is the one function that computes it: the views read it from
 * the published projection, and the bridge compares it with the order's `basis` before applying
 * anything, so that an order given on a document that changed meanwhile is rejected.
 *
 * Order does not matter (the references are sorted) and a reference listed twice counts once.
 */
export function computeBasis(refs: readonly DocumentRef[]): string {
  const unique = new Map<string, DocumentRef>();
  for (const ref of refs) {
    const checked = DocumentRefSchema.parse(ref);
    unique.set(JSON.stringify([checked.path, checked.branch, checked.blob_sha]), {
      path: checked.path,
      branch: checked.branch,
      blob_sha: checked.blob_sha,
    });
  }
  const sorted = [...unique.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, ref]) => ref);
  return `sha256:${toBase64url(sha256(canonicalBytes({ t: "order.basis/v1", documents: sorted })))}`;
}

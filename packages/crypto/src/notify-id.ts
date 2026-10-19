import { toBase64url, utf8 } from "./encoding.js";
import { sha256 } from "./hash.js";

/**
 * The opaque identifier of a notification about a point of a product: a digest both ends compute
 * from what they know (the machine when it notifies, the phone when it finds the point again), so
 * that nothing but 43 characters travels. A point's own identifier is only unique inside its
 * product, which is why the product goes in.
 */
export function notificationId(product: string, point: string): string {
  return toBase64url(sha256(utf8(`notify.id/v1\u0000${product}\u0000${point}`)));
}

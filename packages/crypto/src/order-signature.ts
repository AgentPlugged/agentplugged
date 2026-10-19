import {
  ORDER_RECEIPT_TAG,
  type Order,
  type OrderReceipt,
  parseOrderTag,
  type UnsignedOrder,
  type UnsignedOrderReceipt,
} from "@agentplugged/protocol";
import { canonicalBytes } from "./canonical.js";
import { signBytesEd25519, verifyEd25519 } from "./ed25519.js";
import { fromBase64url, toBase64url } from "./encoding.js";

/**
 * The signatures of orders and of their receipts. A signature covers the canonical JSON (RFC 8785)
 * of the object without `sig`, `t` and `alg` included: an order signed for one type, one bridge or
 * one product is no other order, and an order never serves as an authorization or a message (their
 * labels differ). Ed25519 only.
 */

export function orderSigningBytes(order: UnsignedOrder | Order): Uint8Array {
  if (parseOrderTag(order.t) === undefined) throw new TypeError("not an order label");
  if (order.alg !== "ed25519") throw new TypeError("orders are signed with ed25519");
  const { sig: _sig, ...unsigned } = order as Order;
  return canonicalBytes(unsigned);
}

/** The order, signed by `secretKey` (libsodium format). */
export async function signOrder(unsigned: UnsignedOrder, secretKey: Uint8Array): Promise<Order> {
  const signature = await signBytesEd25519(orderSigningBytes(unsigned), secretKey);
  return { ...unsigned, sig: toBase64url(signature) };
}

/** True when `order.sig` is the signature of the order by `publicKey`. Never throws. */
export async function verifyOrderSignature(order: Order, publicKey: Uint8Array): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = orderSigningBytes(order);
  } catch {
    return false;
  }
  const signature = fromBase64url(order.sig);
  if (signature === undefined || signature.length !== 64 || publicKey.length !== 32) return false;
  return await verifyEd25519(bytes, signature, publicKey);
}

export function receiptSigningBytes(receipt: UnsignedOrderReceipt | OrderReceipt): Uint8Array {
  if (receipt.t !== ORDER_RECEIPT_TAG) throw new TypeError("not a receipt label");
  const { sig: _sig, ...unsigned } = receipt as OrderReceipt;
  return canonicalBytes(unsigned);
}

/** The receipt, signed by the bridge's key. */
export async function signOrderReceipt(
  unsigned: UnsignedOrderReceipt,
  secretKey: Uint8Array,
): Promise<OrderReceipt> {
  const signature = await signBytesEd25519(receiptSigningBytes(unsigned), secretKey);
  return { ...unsigned, sig: toBase64url(signature) };
}

/** True when the receipt carries the signature of the bridge's `publicKey`. Never throws. */
export async function verifyOrderReceipt(
  receipt: OrderReceipt,
  publicKey: Uint8Array,
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = receiptSigningBytes(receipt);
  } catch {
    return false;
  }
  const signature = fromBase64url(receipt.sig);
  if (signature === undefined || signature.length !== 64 || publicKey.length !== 32) return false;
  return await verifyEd25519(bytes, signature, publicKey);
}

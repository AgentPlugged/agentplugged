import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BrowserKeysError,
  type BrowserSubtle,
  browserAgreement,
  browserKeysAreUnreadable,
  createBrowserDeviceKeys,
  deviceIdOf,
  encryptPeerMessage,
  generateEd25519,
  generateX25519,
  openPeerMessage,
  signWithBrowserKey,
  verifyEd25519,
  x25519,
} from "./index.js";

const host = { subtle: webcrypto.subtle as unknown as BrowserSubtle, isSecureContext: true };

describe("the keys of a browser", () => {
  it("are made by the browser and cannot be read out, whatever the format asked for", async () => {
    const keys = await createBrowserDeviceKeys(host);
    expect(keys.signingKey.extractable).toBe(false);
    expect(keys.encryption.privateKey.extractable).toBe(false);
    for (const key of [keys.signingKey, keys.encryption.privateKey]) {
      for (const format of ["raw", "pkcs8"] as const) {
        await expect(host.subtle.exportKey(format, key)).rejects.toThrow();
      }
    }
    expect(await browserKeysAreUnreadable(keys, host)).toBe(true);
    expect(keys.sigPublicKey).toHaveLength(32);
    expect(keys.encryption.publicKey).toHaveLength(32);
    expect(keys.device).toBe(deviceIdOf("browser", keys.sigPublicKey));
  });

  it("sign with standard Ed25519: the signature is checked by the libsodium side", async () => {
    const keys = await createBrowserDeviceKeys(host);
    const message = new TextEncoder().encode("a message");
    const signature = await signWithBrowserKey(keys, message, host);
    expect(await verifyEd25519(message, signature, keys.sigPublicKey)).toBe(true);
    const other = await generateEd25519();
    expect(await verifyEd25519(message, signature, other.publicKey)).toBe(false);
  });

  it("agree on the same X25519 secret as libsodium does, without the private key leaving the browser", async () => {
    const keys = await createBrowserDeviceKeys(host);
    const peer = await generateX25519();
    const fromBrowser = await browserAgreement(keys.encryption, host).agree(peer.publicKey);
    const fromPeer = await x25519(peer.secretKey, keys.encryption.publicKey);
    expect(fromBrowser).toBeDefined();
    expect(Buffer.from(fromBrowser as Uint8Array).equals(Buffer.from(fromPeer as Uint8Array))).toBe(
      true,
    );
  });

  it("refuse a key of low order, as libsodium does", async () => {
    const keys = await createBrowserDeviceKeys(host);
    expect(await browserAgreement(keys.encryption, host).agree(new Uint8Array(32))).toBeUndefined();
    expect(await browserAgreement(keys.encryption, host).agree(new Uint8Array(31))).toBeUndefined();
  });

  it("open a message encrypted for the browser's public key, by agreement", async () => {
    const browser = await createBrowserDeviceKeys(host);
    const sender = await generateEd25519();
    const sendDevice = deviceIdOf("machine", sender.publicKey);
    const envelope = await encryptPeerMessage({
      to: browser.device,
      from: "label",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sender: sendDevice,
      senderSecretKey: sender.secretKey,
      recipientEncKey: browser.encryption.publicKey,
      seq: 5,
      type: "hello",
      body: { n: 1 },
    });
    const registry = (device: string) =>
      device === sendDevice ? { signingKey: sender.publicKey, routingId: "label" } : undefined;
    const opened = await openPeerMessage(envelope, {
      recipientAgreement: browserAgreement(browser.encryption, host),
      registry,
    });
    expect(opened).toMatchObject({ ok: true, sender: sendDevice, seq: 5, body: { n: 1 } });
    // Another browser's key opens nothing.
    const stranger = await createBrowserDeviceKeys(host);
    expect(
      await openPeerMessage(envelope, {
        recipientAgreement: browserAgreement(stranger.encryption, host),
        registry,
      }),
    ).toEqual({ ok: false, reason: "decrypt_failed" });
    // No way to open at all.
    expect(await openPeerMessage(envelope, { registry })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("are refused outside a secure context, with a reason that says so", async () => {
    await expect(
      createBrowserDeviceKeys({ subtle: host.subtle, isSecureContext: false }),
    ).rejects.toMatchObject({ reason: "insecure_context" });
  });

  it("are refused by a browser without the algorithms, rather than made readable", async () => {
    const without = {
      ...host,
      subtle: {
        generateKey: async () => {
          throw new DOMException("not supported", "NotSupportedError");
        },
      } as unknown as BrowserSubtle,
    };
    await expect(createBrowserDeviceKeys(without)).rejects.toBeInstanceOf(BrowserKeysError);
    await expect(createBrowserDeviceKeys({ isSecureContext: true })).rejects.toMatchObject({
      reason: "unsupported",
    });
  });

  it("are refused when the browser makes them readable", async () => {
    const readable = {
      ...host,
      subtle: new Proxy(host.subtle, {
        get(target, property) {
          if (property === "generateKey") {
            return (algorithm: unknown, _extractable: boolean, usages: string[]) =>
              (target.generateKey as (...args: unknown[]) => unknown)(algorithm, true, usages);
          }
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    await expect(createBrowserDeviceKeys(readable)).rejects.toMatchObject({
      reason: "unsupported",
    });
  });
});

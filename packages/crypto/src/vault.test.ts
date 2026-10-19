import {
  diffPublished,
  type FeedChange,
  type FeedCursor,
  type FeedSnapshot,
  type PublishedState,
  VaultBlobSchema,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { generateEd25519 } from "./ed25519.js";
import { fromUtf8, utf8 } from "./encoding.js";
import { deviceIdOf, generateX25519 } from "./primitives.js";
import {
  compressBytes,
  decompressBytes,
  openVault,
  sealDeltaVault,
  sealFullVault,
} from "./vault.js";

const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const AT = "2026-10-16T09:00:00.000Z";

function state(extra: Record<string, unknown> = {}, applied = 0): PublishedState {
  return {
    projection: {
      format: 1,
      journal_head: null,
      computed_at: null,
      product: PRODUCT,
      devices: [],
      applied,
      ignored: [],
      warnings: [],
      state: extra,
    },
    trust: { blocked: false, devices: {}, revoked: [] },
    machines: { primary: null, automatic: false },
    import: { state: "none" },
  };
}

const cursor = (n: number): FeedCursor => ({ n, heads: { "machine:w": `h${n}` } });

async function party(kind: "machine" | "phone" | "browser") {
  const sig = await generateEd25519();
  const enc = await generateX25519();
  return { sig, enc, device: deviceIdOf(kind, sig.publicKey) };
}

const snapshot = (s: PublishedState, n: number): FeedSnapshot => ({
  kind: "snapshot",
  schema: 1,
  product: PRODUCT,
  cursor: cursor(n),
  state: s,
});

describe("le coffre : scellé une fois, ouvert par chaque appareil de confiance", () => {
  it("un appareil de confiance rouvre l'état exact : instantané puis changements", async () => {
    const machine = await party("machine");
    const phone = await party("phone");
    const first = state({ stories: { a: { status: "done" } } }, 3);
    const second = state({ stories: { a: { status: "done" }, b: { status: "todo" } } }, 4);
    const full = await sealFullVault({
      product: PRODUCT,
      rev: 100,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      content: {
        content: snapshot(first, 3),
        report: {
          name: "Atelier",
          bridge_version: "1.0.0",
          protocol_version: 1,
          products: [{ id: PRODUCT, name: "mon-produit" }],
          agents: 0,
          tools: [],
        },
      },
      recipients: [{ device: phone.device, encKey: phone.enc.publicKey }],
    });
    const change: FeedChange = {
      kind: "change",
      schema: 1,
      product: PRODUCT,
      from_cursor: cursor(3),
      to_cursor: cursor(4),
      ops: diffPublished(first, second),
    };
    const delta = await sealDeltaVault({
      product: PRODUCT,
      rev: 101,
      baseRev: 100,
      at: "2026-10-16T09:05:00.000Z",
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      contentKey: full.contentKey,
      content: { content: change },
    });
    const opened = await openVault([full.bytes, delta], {
      self: phone.device,
      secretKey: phone.enc.secretKey,
      signerKey: (bridge) => (bridge === machine.device ? machine.sig.publicKey : undefined),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.vault.state).toEqual(second);
    expect(opened.vault.cursor).toEqual(cursor(4));
    expect(opened.vault.rev).toBe(101);
    expect(opened.vault.at).toBe("2026-10-16T09:05:00.000Z");
    expect(opened.vault.report?.name).toBe("Atelier");
  });

  it("le contenu n'est pas lisible dans les octets que le relais garde", async () => {
    const machine = await party("machine");
    const phone = await party("phone");
    const full = await sealFullVault({
      product: PRODUCT,
      rev: 1,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      content: { content: snapshot(state({ secret_word: "marmelade-orange" }), 1) },
      recipients: [{ device: phone.device, encKey: phone.enc.publicKey }],
    });
    const text = fromUtf8(full.bytes) ?? "";
    expect(text).not.toContain("marmelade");
    expect(VaultBlobSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it("un appareil sans boîte dans ce coffre ne peut pas l'ouvrir (relié après le dépôt)", async () => {
    const machine = await party("machine");
    const phone = await party("phone");
    const late = await party("browser");
    const full = await sealFullVault({
      product: PRODUCT,
      rev: 1,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      content: { content: snapshot(state(), 1) },
      recipients: [{ device: phone.device, encKey: phone.enc.publicKey }],
    });
    const opened = await openVault([full.bytes], {
      self: late.device,
      secretKey: late.enc.secretKey,
      signerKey: () => machine.sig.publicKey,
    });
    expect(opened).toEqual({ ok: false, reason: "no_key" });
  });

  it("un coffre signé par une machine inconnue ou avec un octet changé est refusé", async () => {
    const machine = await party("machine");
    const other = await party("machine");
    const phone = await party("phone");
    const full = await sealFullVault({
      product: PRODUCT,
      rev: 1,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      content: { content: snapshot(state(), 1) },
      recipients: [{ device: phone.device, encKey: phone.enc.publicKey }],
    });
    const options = {
      self: phone.device,
      secretKey: phone.enc.secretKey,
    };
    expect(await openVault([full.bytes], { ...options, signerKey: () => undefined })).toEqual({
      ok: false,
      reason: "unknown_signer",
    });
    // The key the view trusts for that machine is another one: the signature does not verify.
    expect(
      await openVault([full.bytes], { ...options, signerKey: () => other.sig.publicKey }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    // A byte of the body altered by the relay.
    const blob = JSON.parse(fromUtf8(full.bytes) ?? "{}") as { body: string };
    const flipped = blob.body.startsWith("A") ? `B${blob.body.slice(1)}` : `A${blob.body.slice(1)}`;
    const altered = utf8(JSON.stringify({ ...blob, body: flipped }));
    expect(
      await openVault([altered], { ...options, signerKey: () => machine.sig.publicKey }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("un changement qui ne suit pas le coffre complet est refusé", async () => {
    const machine = await party("machine");
    const phone = await party("phone");
    const first = state({}, 1);
    const full = await sealFullVault({
      product: PRODUCT,
      rev: 10,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      content: { content: snapshot(first, 1) },
      recipients: [{ device: phone.device, encKey: phone.enc.publicKey }],
    });
    const wrongBase = await sealDeltaVault({
      product: PRODUCT,
      rev: 12,
      baseRev: 11,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      contentKey: full.contentKey,
      content: {
        content: {
          kind: "change",
          schema: 1,
          product: PRODUCT,
          from_cursor: cursor(1),
          to_cursor: cursor(2),
          ops: [],
        },
      },
    });
    const wrongCursor = await sealDeltaVault({
      product: PRODUCT,
      rev: 11,
      baseRev: 10,
      at: AT,
      bridge: machine.device,
      sigSecretKey: machine.sig.secretKey,
      contentKey: full.contentKey,
      content: {
        content: {
          kind: "change",
          schema: 1,
          product: PRODUCT,
          from_cursor: cursor(7),
          to_cursor: cursor(8),
          ops: [],
        },
      },
    });
    const options = {
      self: phone.device,
      secretKey: phone.enc.secretKey,
      signerKey: () => machine.sig.publicKey,
    };
    expect(await openVault([full.bytes, wrongBase], options)).toEqual({
      ok: false,
      reason: "chain_broken",
    });
    expect(await openVault([full.bytes, wrongCursor], options)).toEqual({
      ok: false,
      reason: "chain_broken",
    });
    // A change alone, without the full vault it follows, is not a vault.
    expect(await openVault([wrongCursor], options)).toEqual({ ok: false, reason: "malformed" });
  });

  it("la taille ne dépend pas du nombre d'appareils : moins de 1 Ko par appareil de plus", async () => {
    const machine = await party("machine");
    const content = {
      content: snapshot(
        state(
          Object.fromEntries(
            Array.from({ length: 200 }, (_, i) => [
              `story-${i}`,
              { title: `Story ${i}`, status: "done" },
            ]),
          ),
          200,
        ),
        200,
      ),
    };
    const devices = await Promise.all(Array.from({ length: 10 }, () => party("phone")));
    const sizeFor = async (count: number): Promise<number> =>
      (
        await sealFullVault({
          product: PRODUCT,
          rev: 1,
          at: AT,
          bridge: machine.device,
          sigSecretKey: machine.sig.secretKey,
          content,
          recipients: devices
            .slice(0, count)
            .map((d) => ({ device: d.device, encKey: d.enc.publicKey })),
        })
      ).bytes.length;
    const one = await sizeFor(1);
    const ten = await sizeFor(10);
    expect((ten - one) / 9).toBeLessThan(1024);
    // Sealing the content once and only the key per device: ten devices cost a few hundred bytes each.
    expect(ten - one).toBeLessThan(9 * 400);
  });

  it("la décompression refuse une bombe et un texte qui n'est pas compressé", async () => {
    const big = new Uint8Array(2_000_000);
    const packed = await compressBytes(big);
    expect(packed.length).toBeLessThan(10_000);
    expect(await decompressBytes(packed, 1_000_000)).toBeUndefined();
    expect((await decompressBytes(packed, 3_000_000))?.length).toBe(2_000_000);
    expect(await decompressBytes(utf8("pas du gzip"))).toBeUndefined();
  });
});

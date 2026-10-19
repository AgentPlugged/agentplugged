import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { PublishedState } from "@agentplugged/protocol";
import { describe, it } from "vitest";
import { generateEd25519 } from "./ed25519.js";
import { deviceIdOf, generateX25519 } from "./primitives.js";
import { sealFullVault } from "./vault.js";

/**
 * A measure, not a check: the size of a sealed vault for products of growing size, written to the
 * test output. Run with `VAULT_MEASURE=<output file>`.
 */
const run = process.env.VAULT_MEASURE === undefined ? describe.skip : describe;

const WORDS = Array.from({ length: 800 }, (_, i) => `mot${(i * 7919) % 10007}`);
const words = (count: number): string =>
  Array.from({ length: count }, () => WORDS[randomBytes(2).readUInt16BE() % WORDS.length]).join(
    " ",
  );

function productOf(stories: number): PublishedState {
  const state: Record<string, unknown> = {};
  for (let i = 0; i < stories; i += 1) {
    state[`story-${i}`] = {
      title: words(8),
      status: i % 3 === 0 ? "done" : "in_progress",
      criteria: Array.from({ length: 5 }, () => words(14)),
      notes: words(60),
      cost: { tokens: 12_000 + i, usd: 0.42 },
      versions: Array.from({ length: 3 }, (_, v) => ({
        v,
        at: "2026-10-16T09:00:00.000Z",
        sha: randomBytes(20).toString("hex"),
      })),
    };
  }
  return {
    projection: {
      format: 1,
      journal_head: null,
      computed_at: null,
      product: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
      devices: [],
      applied: stories * 12,
      ignored: [],
      warnings: [],
      state,
    },
    trust: { blocked: false, devices: {}, revoked: [] },
    machines: { primary: null, automatic: false },
    import: { state: "none" },
  };
}

run("vault size (measure)", () => {
  it("prints the size of a sealed vault by product size and by number of devices", async () => {
    const machine = await generateEd25519();
    const lines: string[] = [];
    for (const stories of [10, 100, 500, 2000, 5000]) {
      const state = productOf(stories);
      const plain = Buffer.byteLength(JSON.stringify(state));
      const sizes: number[] = [];
      for (const devices of [1, 10]) {
        const recipients = await Promise.all(
          Array.from({ length: devices }, async () => {
            const enc = await generateX25519();
            const sig = await generateEd25519();
            return { device: deviceIdOf("phone", sig.publicKey), encKey: enc.publicKey };
          }),
        );
        const sealed = await sealFullVault({
          product: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
          rev: 1,
          at: "2026-10-16T09:00:00.000Z",
          bridge: deviceIdOf("machine", machine.publicKey),
          sigSecretKey: machine.secretKey,
          content: {
            content: {
              kind: "snapshot",
              schema: 1,
              product: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
              cursor: { n: stories * 12, heads: {} },
              state,
            },
          },
          recipients,
        });
        sizes.push(sealed.bytes.length);
      }
      lines.push(
        `${stories} stories: state ${plain} B, vault ${sizes[0]} B (1 device), ${sizes[1]} B (10 devices)`,
      );
    }
    writeFileSync(process.env.VAULT_MEASURE ?? "vault-measure.txt", `${lines.join("\n")}\n`);
  });
});

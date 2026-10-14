import { keychainFull } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-text.js";
import { formatInitProductKey } from "./key-flow.js";

const reason = "Platform failure: Windows error code 8";

describe("a full Windows Credential Manager", () => {
  it("has a stable code, and says how to make room, in French and in English", () => {
    const error = keychainFull(reason).toPayload();
    expect(error).toEqual({
      code: ErrorCode.KEYCHAIN_FULL,
      message_key: "error.keychain_full",
      details: { reason },
    });
    expect(ErrorCode.KEYCHAIN_FULL).toBe("KEYCHAIN_FULL");
    const fr = errorMessage(createTranslator("fr"), error);
    expect(fr).toContain("Le gestionnaire d'identifiants de Windows est plein (");
    expect(fr).toContain(reason);
    expect(fr).toContain("`cmdkey /list`");
    expect(fr).toContain("Ne supprime jamais les entrées `agentplugged`");
    const en = errorMessage(createTranslator("en"), error);
    expect(en).toContain("The Windows Credential Manager is full (");
    expect(en).toContain("`cmdkey /delete:<target>`");
    expect(en).toContain("Never remove the `agentplugged` entries");
  });

  it("is said at init, after what was not created", () => {
    const lines = formatInitProductKey(createTranslator("fr"), {
      status: "keychain_full",
      publishReason: reason,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Pas de clé du produit/);
    expect(lines[1]).toContain("est plein");
  });
});

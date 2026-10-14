// The `presence` credential through Windows Hello: `webauthn.dll` called by the `koffi` FFI, as
// measured by spike 2.1 (struct layouts of version 1, x64; parent window from the console, else
// the foreground window). `koffi` is an optional dependency, loaded on Windows only: without it,
// or without Windows Hello, the creator's validations stay `locale`. Tests never run this file's
// system calls: they use a software authenticator through the same port.
import type { PresenceAuthenticator, PresenceAvailability, PresenceUser } from "@agentplugged/core";
import { fromBase64url, randomBytes, toBase64url, utf8 } from "@agentplugged/crypto";
import { parsePresenceAttestation } from "@agentplugged/crypto/webauthn-verify";
import type { PresenceCredential, WebAuthnSignature } from "@agentplugged/protocol";

const RP_ID = "agentplugged.local";
const ORIGIN = `https://${RP_ID}`;
const COSE_ES256 = -7;
const COSE_RS256 = -257;
const PROMPT_TIMEOUT_MS = 120_000;
const S_OK = 0;
const ATTACHMENT_PLATFORM = 1;
const UV_REQUIRED = 1;
const ATTESTATION_NONE = 1;

// biome-ignore lint/suspicious/noExplicitAny: the FFI's values are untyped by nature.
type Native = any;

interface WebAuthnApi {
  readonly koffi: Native;
  readonly fn: Record<string, Native>;
  readonly ATTESTATION: Native;
  readonly ASSERTION: Native;
}

/** The bindings of `webauthn.dll`, `kernel32.dll` and `user32.dll` (spike 2.1). */
async function bind(): Promise<WebAuthnApi> {
  const imported = (await import("koffi")) as Native;
  const koffi = imported.default ?? imported;
  const lib = koffi.load("webauthn.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const user32 = koffi.load("user32.dll");
  const PWSTR = "str16";
  koffi.struct("WEBAUTHN_RP_ENTITY_INFORMATION", {
    dwVersion: "uint32",
    pwszId: PWSTR,
    pwszName: PWSTR,
    pwszIcon: PWSTR,
  });
  koffi.struct("WEBAUTHN_USER_ENTITY_INFORMATION", {
    dwVersion: "uint32",
    cbId: "uint32",
    pbId: "void *",
    pwszName: PWSTR,
    pwszIcon: PWSTR,
    pwszDisplayName: PWSTR,
  });
  const COSE_PARAM = koffi.struct("WEBAUTHN_COSE_CREDENTIAL_PARAMETER", {
    dwVersion: "uint32",
    pwszCredentialType: PWSTR,
    lAlg: "int32",
  });
  koffi.struct("WEBAUTHN_COSE_CREDENTIAL_PARAMETERS", {
    cCredentialParameters: "uint32",
    pCredentialParameters: koffi.pointer(COSE_PARAM),
  });
  koffi.struct("WEBAUTHN_CLIENT_DATA", {
    dwVersion: "uint32",
    cbClientDataJSON: "uint32",
    pbClientDataJSON: "void *",
    pwszHashAlgId: PWSTR,
  });
  const CREDENTIAL = koffi.struct("WEBAUTHN_CREDENTIAL", {
    dwVersion: "uint32",
    cbId: "uint32",
    pbId: "void *",
    pwszCredentialType: PWSTR,
  });
  const CREDENTIALS = koffi.struct("WEBAUTHN_CREDENTIALS", {
    cCredentials: "uint32",
    pCredentials: koffi.pointer(CREDENTIAL),
  });
  const EXTENSIONS = koffi.struct("WEBAUTHN_EXTENSIONS", {
    cExtensions: "uint32",
    pExtensions: "void *",
  });
  koffi.struct("WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS", {
    dwVersion: "uint32",
    dwTimeoutMilliseconds: "uint32",
    CredentialList: CREDENTIALS,
    Extensions: EXTENSIONS,
    dwAuthenticatorAttachment: "uint32",
    bRequireResidentKey: "int32",
    dwUserVerificationRequirement: "uint32",
    dwAttestationConveyancePreference: "uint32",
    dwFlags: "uint32",
  });
  koffi.struct("WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS", {
    dwVersion: "uint32",
    dwTimeoutMilliseconds: "uint32",
    CredentialList: CREDENTIALS,
    Extensions: EXTENSIONS,
    dwAuthenticatorAttachment: "uint32",
    dwUserVerificationRequirement: "uint32",
    dwFlags: "uint32",
  });
  // Only the version 1 prefix of the output structs is read.
  const ATTESTATION = koffi.struct("WEBAUTHN_CREDENTIAL_ATTESTATION_V1", {
    dwVersion: "uint32",
    pwszFormatType: "void *",
    cbAuthenticatorData: "uint32",
    pbAuthenticatorData: "void *",
    cbAttestation: "uint32",
    pbAttestation: "void *",
    dwAttestationDecodeType: "uint32",
    pvAttestationDecode: "void *",
    cbAttestationObject: "uint32",
    pbAttestationObject: "void *",
    cbCredentialId: "uint32",
    pbCredentialId: "void *",
  });
  const ASSERTION = koffi.struct("WEBAUTHN_ASSERTION_V1", {
    dwVersion: "uint32",
    cbAuthenticatorData: "uint32",
    pbAuthenticatorData: "void *",
    cbSignature: "uint32",
    pbSignature: "void *",
    Credential: CREDENTIAL,
    cbUserId: "uint32",
    pbUserId: "void *",
  });
  const fn = {
    IsUVPAA: lib.func(
      "int32 __stdcall WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(_Out_ int32 *pbIsUserVerifyingPlatformAuthenticatorAvailable)",
    ),
    MakeCredential: lib.func(
      "int32 __stdcall WebAuthNAuthenticatorMakeCredential(void *hWnd, const WEBAUTHN_RP_ENTITY_INFORMATION *rp, const WEBAUTHN_USER_ENTITY_INFORMATION *user, const WEBAUTHN_COSE_CREDENTIAL_PARAMETERS *params, const WEBAUTHN_CLIENT_DATA *clientData, const WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS *options, _Out_ void **ppAttestation)",
    ),
    FreeCredentialAttestation: lib.func(
      "void __stdcall WebAuthNFreeCredentialAttestation(void *p)",
    ),
    GetAssertion: lib.func(
      "int32 __stdcall WebAuthNAuthenticatorGetAssertion(void *hWnd, str16 pwszRpId, const WEBAUTHN_CLIENT_DATA *clientData, const WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS *options, _Out_ void **ppAssertion)",
    ),
    FreeAssertion: lib.func("void __stdcall WebAuthNFreeAssertion(void *p)"),
    GetErrorName: lib.func("str16 __stdcall WebAuthNGetErrorName(int32 hr)"),
    GetConsoleWindow: kernel32.func("void * __stdcall GetConsoleWindow()"),
    GetForegroundWindow: user32.func("void * __stdcall GetForegroundWindow()"),
  };
  return { koffi, fn, ATTESTATION, ASSERTION };
}

/** Bytes behind a native pointer, copied. */
function bytes(api: WebAuthnApi, pointer: Native, length: number): Uint8Array {
  return pointer && length
    ? new Uint8Array(api.koffi.view(pointer, length).slice(0))
    : new Uint8Array();
}

/** The prompt's parent window: the console's, else the foreground window (spike 2.1). */
function parentWindow(api: WebAuthnApi): Native {
  return api.fn.GetConsoleWindow() || api.fn.GetForegroundWindow() || null;
}

function failure(api: WebAuthnApi, what: string, hresult: number): Error {
  let name: string | undefined;
  try {
    name = api.fn.GetErrorName(hresult) ?? undefined;
  } catch {
    name = undefined;
  }
  const code = `0x${(hresult >>> 0).toString(16).padStart(8, "0")}`;
  return new Error(`Windows Hello ${what} failed: ${name ?? "error"} (${code})`);
}

function clientData(type: string, challenge: Uint8Array): Uint8Array {
  return utf8(
    JSON.stringify({ type, challenge: toBase64url(challenge), origin: ORIGIN, crossOrigin: false }),
  );
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * `PresenceAuthenticator` through Windows Hello. `availability` never prompts (it asks
 * `WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable`); `create` and `assert` show the
 * system's prompt (user verification required, relying party `agentplugged.local`). Any other
 * system than Windows: unavailable (`platform`).
 */
export class NodePresenceAuthenticator implements PresenceAuthenticator {
  readonly #platform: string;
  #api: Promise<WebAuthnApi> | undefined;

  constructor(options: { platform?: string } = {}) {
    this.#platform = options.platform ?? process.platform;
  }

  #load(): Promise<WebAuthnApi> {
    this.#api ??= bind().catch((error: unknown) => {
      this.#api = undefined;
      throw error;
    });
    return this.#api;
  }

  async availability(): Promise<PresenceAvailability> {
    if (this.#platform !== "win32") return { available: false, reason: "platform" };
    let api: WebAuthnApi;
    try {
      api = await this.#load();
    } catch {
      return { available: false, reason: "unsupported" };
    }
    const out = [0];
    const hresult = api.fn.IsUVPAA(out);
    return hresult === S_OK && out[0] !== 0
      ? { available: true }
      : { available: false, reason: "not_configured" };
  }

  async create(user: PresenceUser): Promise<PresenceCredential> {
    const api = await this.#load();
    const challenge = randomBytes(32);
    const data = asBuffer(clientData("webauthn.create", challenge));
    const userId = asBuffer(user.id);
    const out = [null];
    const hresult = api.fn.MakeCredential(
      parentWindow(api),
      { dwVersion: 1, pwszId: RP_ID, pwszName: "AgentPlugged", pwszIcon: null },
      {
        dwVersion: 1,
        cbId: userId.length,
        pbId: userId,
        pwszName: user.name,
        pwszIcon: null,
        pwszDisplayName: user.displayName,
      },
      {
        cCredentialParameters: 2,
        pCredentialParameters: [
          { dwVersion: 1, pwszCredentialType: "public-key", lAlg: COSE_ES256 },
          { dwVersion: 1, pwszCredentialType: "public-key", lAlg: COSE_RS256 },
        ],
      },
      {
        dwVersion: 1,
        cbClientDataJSON: data.length,
        pbClientDataJSON: data,
        pwszHashAlgId: "SHA-256",
      },
      {
        dwVersion: 1,
        dwTimeoutMilliseconds: PROMPT_TIMEOUT_MS,
        CredentialList: { cCredentials: 0, pCredentials: null },
        Extensions: { cExtensions: 0, pExtensions: null },
        dwAuthenticatorAttachment: ATTACHMENT_PLATFORM,
        bRequireResidentKey: 0,
        dwUserVerificationRequirement: UV_REQUIRED,
        dwAttestationConveyancePreference: ATTESTATION_NONE,
        dwFlags: 0,
      },
      out,
    );
    if (hresult !== S_OK || !out[0]) throw failure(api, "registration", hresult);
    let attestationObject: Uint8Array;
    try {
      const attestation = api.koffi.decode(out[0], api.ATTESTATION);
      attestationObject = bytes(
        api,
        attestation.pbAttestationObject,
        attestation.cbAttestationObject,
      );
    } finally {
      api.fn.FreeCredentialAttestation(out[0]);
    }
    const credential = await parsePresenceAttestation(attestationObject);
    if (credential === undefined) {
      throw new Error("Windows Hello returned a credential agentplugged cannot use");
    }
    return credential;
  }

  async assert(credentialId: string, challenge: Uint8Array): Promise<WebAuthnSignature> {
    const api = await this.#load();
    const id = fromBase64url(credentialId);
    if (id === undefined) throw new Error("invalid credential id");
    const data = clientData("webauthn.get", challenge);
    const dataBuffer = asBuffer(data);
    const idBuffer = asBuffer(id);
    const out = [null];
    const hresult = api.fn.GetAssertion(
      parentWindow(api),
      RP_ID,
      {
        dwVersion: 1,
        cbClientDataJSON: dataBuffer.length,
        pbClientDataJSON: dataBuffer,
        pwszHashAlgId: "SHA-256",
      },
      {
        dwVersion: 1,
        dwTimeoutMilliseconds: PROMPT_TIMEOUT_MS,
        CredentialList: {
          cCredentials: 1,
          pCredentials: [
            {
              dwVersion: 1,
              cbId: idBuffer.length,
              pbId: idBuffer,
              pwszCredentialType: "public-key",
            },
          ],
        },
        Extensions: { cExtensions: 0, pExtensions: null },
        dwAuthenticatorAttachment: ATTACHMENT_PLATFORM,
        dwUserVerificationRequirement: UV_REQUIRED,
        dwFlags: 0,
      },
      out,
    );
    if (hresult !== S_OK || !out[0]) throw failure(api, "verification", hresult);
    try {
      const assertion = api.koffi.decode(out[0], api.ASSERTION);
      return {
        authenticatorData: toBase64url(
          bytes(api, assertion.pbAuthenticatorData, assertion.cbAuthenticatorData),
        ),
        clientDataJSON: toBase64url(data),
        signature: toBase64url(bytes(api, assertion.pbSignature, assertion.cbSignature)),
      };
    } finally {
      api.fn.FreeAssertion(out[0]);
    }
  }
}

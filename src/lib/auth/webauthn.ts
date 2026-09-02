type Base64urlString = string;
// Views are pinned to ArrayBuffer-backed (rather than the ArrayBufferLike
// default, which also admits SharedArrayBuffer) because the WebAuthn and
// WebCrypto signatures take BufferSource = ArrayBuffer | ArrayBufferView<ArrayBuffer>.
type BinaryLike =
  | Base64urlString
  | ArrayBuffer
  | Uint8Array<ArrayBuffer>
  | ArrayBufferView<ArrayBuffer>;

function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * Whether `value` is a well-formed unpadded base64url string.
 *
 * This is checked explicitly rather than left to `atob` throwing, because
 * `atob` is lenient in ways that differ between runtimes (it tolerates
 * whitespace, and the Node polyfill used by the test suite tolerates a great
 * deal more). A silent disagreement about whether a field is base64url or raw
 * text is the classic way a WebAuthn transport breaks: the ceremony still
 * "succeeds" locally and the relying party rejects the signature with no clue
 * why. Deciding here, on the string itself, keeps that decision deterministic.
 *
 * A length of `n % 4 === 1` cannot be produced by any byte string, so it is
 * rejected rather than padded into something `atob` may or may not accept.
 */
export function isBase64url(value: string): boolean {
  return BASE64URL_ALPHABET.test(value) && value.length % 4 !== 1;
}

export function base64urlToUint8Array(
  data: Base64urlString,
): Uint8Array<ArrayBuffer> {
  if (!isBase64url(data)) {
    throw new TypeError("Value is not a base64url string");
  }
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return base64ToUint8Array(padded);
}

export function bufferToBase64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

type RegistrationOptions = PublicKeyCredentialCreationOptions & {
  challenge: BinaryLike;
  user: { id: BinaryLike };
  excludeCredentials?: { id: BinaryLike; type: PublicKeyCredentialType }[];
};

type AuthenticationOptions = PublicKeyCredentialRequestOptions & {
  challenge: BinaryLike;
  allowCredentials?: { id: BinaryLike; type: PublicKeyCredentialType }[];
};

function normalizeBinary(data: BinaryLike): BufferSource {
  if (typeof data === "string") {
    // `webauthn-rs` 0.5 serialises every binary field as an unpadded base64url
    // string, which is the only branch the desktop backend ever takes. The
    // text fallback exists for a hosted server that sends a raw challenge
    // string, and is reached only when the value could not have been base64url
    // in the first place.
    return isBase64url(data)
      ? base64urlToUint8Array(data)
      : new TextEncoder().encode(data);
  }
  return data;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the `PublicKeyCredential*Options` object out of whatever envelope the
 * relying party wrapped it in.
 *
 * `webauthn-rs` serialises both `CreationChallengeResponse` and
 * `RequestChallengeResponse` as `{"publicKey": { ... }}` — the shape a browser
 * hands straight to `navigator.credentials`. Before this, only `{options: ...}`
 * and a bare options object were unwrapped, so a `publicKey`-wrapped payload
 * reached `toCredentialCreationOptions` with no `challenge` at all and the
 * ceremony failed with an opaque error. That is a functional bug, not a
 * cosmetic one.
 *
 * A `publicKey` or `options` wrapper is unwrapped in that order; anything else
 * is already the options object. When the wrapper carries no `challenge` the
 * previous behaviour is kept — merge the envelope's own `challenge` onto it —
 * so a relying party that sends the two side by side still works.
 */
export function unwrapCeremonyOptions(
  payload: unknown,
): Record<string, unknown> {
  const envelope = asRecord(payload);
  if (!envelope) return {};

  const nested = asRecord(envelope.publicKey) ?? asRecord(envelope.options);
  if (!nested) return envelope;

  return "challenge" in nested
    ? nested
    : { ...nested, challenge: envelope.challenge };
}

export function toCredentialCreationOptions(
  opts: RegistrationOptions,
): PublicKeyCredentialCreationOptions {
  return {
    ...opts,
    challenge: normalizeBinary(opts.challenge),
    user: {
      ...opts.user,
      id: normalizeBinary(opts.user.id),
    },
    excludeCredentials: opts.excludeCredentials?.map((cred) => ({
      ...cred,
      id: normalizeBinary(cred.id),
    })),
  };
}

export function toCredentialRequestOptions(
  opts: AuthenticationOptions,
): PublicKeyCredentialRequestOptions {
  return {
    ...opts,
    challenge: normalizeBinary(opts.challenge),
    allowCredentials: opts.allowCredentials?.map((cred) => ({
      ...cred,
      id: normalizeBinary(cred.id),
    })),
  };
}

export function serializeRegistrationCredential(
  credential: PublicKeyCredential,
) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      // `AuthenticatorAttestationResponseRaw.transports` is `#[serde(default)]`
      // and its enum has a `#[serde(other)]` catch-all, so an unrecognised
      // transport is ignored rather than failing the whole registration.
      // Sending it gives the relying party better `allowCredentials` hints.
      transports: response.getTransports?.() ?? undefined,
    },
    // `RegisterPublicKeyCredential.extensions` carries
    // `alias = "clientExtensionResults"`, so this key is the one the browser
    // produces and the one the relying party accepts.
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

export function serializeAuthenticationCredential(
  credential: PublicKeyCredential,
) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle
        ? bufferToBase64url(response.userHandle)
        : null,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

// ─── Client capability probe ────────────────────────────────────────────────

/**
 * What the *client* half of WebAuthn can do in this webview, right now.
 *
 * The relying party's own `get_passkey_status` reports what the backend can
 * do; it cannot know whether the surrounding webview has a usable WebAuthn
 * client. These are genuinely different failures and deserve different
 * messages:
 *
 * - `"unsupported"` — no WebAuthn client here at all. This is the honest end
 *   state on macOS and Linux, where Tauri serves an opaque `tauri://localhost`
 *   origin that `navigator.credentials.create()` rejects outright.
 * - `"no-authenticator"` — the API is present and working, but the machine has
 *   no user-verifying platform authenticator enrolled (no Windows Hello, no
 *   device passcode). Enrolling one fixes it.
 * - `"available"` — a ceremony can be attempted.
 */
export type WebauthnClientCapability =
  "available" | "no-authenticator" | "unsupported";

export async function probeWebauthnClient(): Promise<WebauthnClientCapability> {
  try {
    if (typeof window === "undefined") return "unsupported";

    const publicKeyCredential = (
      window as Window & { PublicKeyCredential?: unknown }
    ).PublicKeyCredential;
    if (typeof publicKeyCredential !== "function") return "unsupported";

    const credentials =
      typeof navigator === "undefined" ? undefined : navigator.credentials;
    if (typeof credentials?.create !== "function") return "unsupported";
    if (typeof credentials?.get !== "function") return "unsupported";

    const isPlatformAuthenticatorAvailable = (
      publicKeyCredential as typeof PublicKeyCredential
    ).isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof isPlatformAuthenticatorAvailable !== "function") {
      return "unsupported";
    }

    const enrolled =
      await isPlatformAuthenticatorAvailable.call(publicKeyCredential);
    return enrolled ? "available" : "no-authenticator";
  } catch {
    // A probe that throws tells us nothing good about this webview. Fail
    // closed: an honestly disabled button beats one that always errors.
    return "unsupported";
  }
}

/** Plan §8.3's boolean form of {@link probeWebauthnClient}. */
export async function webauthnClientAvailable(): Promise<boolean> {
  return (await probeWebauthnClient()) === "available";
}

// ─── Ceremony calls, on our own timer ───────────────────────────────────────

/**
 * How long a ceremony may run before we abort it ourselves.
 *
 * Long enough for a human to find a security key and touch it; short enough
 * that a hung call does not leave the UI spinning forever.
 */
export const WEBAUTHN_CEREMONY_TIMEOUT_MS = 60_000;

/**
 * Raised when our own timer, not the browser, ended the ceremony.
 *
 * `navigator.credentials.create()` with `authenticatorAttachment: "platform"`
 * hangs indefinitely on Chromium 146 and **ignores its own `timeout` field** —
 * measured in production WebView2 and reproduced in stock Edge, so it is a
 * Chromium behaviour and not something this app can configure away. Every
 * `create()` / `get()` call therefore runs under an `AbortSignal` we drive, and
 * the WebAuthn `timeout` field is treated as advisory only.
 */
export class WebauthnCeremonyTimeoutError extends Error {
  readonly ceremony: "create" | "get";
  readonly timeoutMs: number;

  constructor(ceremony: "create" | "get", timeoutMs: number) {
    super(
      `The passkey ${
        ceremony === "create" ? "registration" : "sign-in"
      } request timed out after ${Math.round(
        timeoutMs / 1000,
      )}s with no response from your device.`,
    );
    this.name = "WebauthnCeremonyTimeoutError";
    this.ceremony = ceremony;
    this.timeoutMs = timeoutMs;
  }
}

async function runCeremony(
  ceremony: "create" | "get",
  call: (signal: AbortSignal) => Promise<Credential | null>,
  timeoutMs: number,
): Promise<PublicKeyCredential | null> {
  const budget =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : WEBAUTHN_CEREMONY_TIMEOUT_MS;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // The deadline both aborts the ceremony and settles this call. Aborting alone
  // would be enough for a platform that honours the signal — but a client that
  // can hang past its own `timeout` field has already shown it may not, and a
  // login screen that spins forever is the one outcome with no way out.
  // `Promise.race` subscribes to the ceremony too, so a later rejection from it
  // is handled rather than surfacing as an unhandled rejection.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new WebauthnCeremonyTimeoutError(ceremony, budget));
    }, budget);
  });

  // The browser reports our abort as a generic `AbortError`, which is
  // indistinguishable from the user dismissing the prompt. Replace it so the
  // UI can say which of the two actually happened.
  const request = call(controller.signal).catch((error: unknown) => {
    if (timedOut) throw new WebauthnCeremonyTimeoutError(ceremony, budget);
    throw error;
  });

  try {
    return (await Promise.race([
      request,
      deadline,
    ])) as PublicKeyCredential | null;
  } finally {
    clearTimeout(timer);
  }
}

export function createPasskeyCredential(
  publicKey: PublicKeyCredentialCreationOptions,
  timeoutMs: number = WEBAUTHN_CEREMONY_TIMEOUT_MS,
): Promise<PublicKeyCredential | null> {
  return runCeremony(
    "create",
    (signal) => navigator.credentials.create({ publicKey, signal }),
    timeoutMs,
  );
}

export function getPasskeyCredential(
  publicKey: PublicKeyCredentialRequestOptions,
  timeoutMs: number = WEBAUTHN_CEREMONY_TIMEOUT_MS,
): Promise<PublicKeyCredential | null> {
  return runCeremony(
    "get",
    (signal) => navigator.credentials.get({ publicKey, signal }),
    timeoutMs,
  );
}

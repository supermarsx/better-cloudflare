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
 * Every signal this webview's WebAuthn client will give up about itself.
 *
 * Each is reported separately rather than folded into one boolean, because a
 * single boolean is precisely what made this probe wrong.
 * `isUserVerifyingPlatformAuthenticatorAvailable()` answers one narrow
 * question — *is there a built-in user-verifying authenticator* — and a `false`
 * from it was being read as "no passkey is possible here". Three things that
 * work are invisible to that call: a USB security key, an NFC key, and a
 * passkey on the user's own phone over hybrid transport. None of them are
 * platform authenticators, and the relying party accepts all three —
 * `start_passkey_registration` sets no `authenticatorAttachment` at all.
 *
 * `null` means the client offered no way to ask, which is not `false`.
 */
export interface WebauthnClientSignals {
  /** `window.isSecureContext`. WebAuthn does not exist outside one. */
  secureContext: boolean | null;
  /** The `PublicKeyCredential` constructor is present. */
  publicKeyCredential: boolean;
  credentialsCreate: boolean;
  credentialsGet: boolean;
  /** Built in and user-verifying: Windows Hello, Touch ID, a device passcode. */
  platformAuthenticator: boolean | null;
  /** A passkey on a nearby phone, reached over QR and Bluetooth. */
  hybridTransport: boolean | null;
  /** The client's own answer to "can this user make a passkey": platform or hybrid. */
  passkeyPlatformAuthenticator: boolean | null;
  /** Autofill-driven sign-in. Recorded for the diagnostic; never a gate. */
  conditionalGet: boolean | null;
  /** Which API answered the authenticator questions. */
  source: "client-capabilities" | "legacy-probe" | "none";
  /** The message from a probe call that threw, for the diagnostic line. */
  probeError: string | null;
}

/**
 * What the *client* half of WebAuthn can do in this webview, right now.
 *
 * The relying party's own `get_passkey_status` reports what the backend can
 * do; it cannot know whether the surrounding webview has a usable WebAuthn
 * client. These are genuinely different situations and deserve different
 * messages:
 *
 * - `"unsupported"` — no WebAuthn client here at all.
 * - `"insecure-origin"` — the API is absent *and* this is not a secure
 *   context, which is the cause far more often than a webview that genuinely
 *   lacks WebAuthn. The expected outcome on macOS and Linux, where Tauri
 *   serves an opaque `tauri://localhost` origin.
 * - `"no-platform-authenticator"` — the client works and reports no built-in
 *   authenticator and no hybrid transport. **This is not a refusal.** A
 *   roaming security key is invisible to every probe the platform exposes, so
 *   the ceremony is still offered and this is shown as advice.
 * - `"available"` — the client named an authenticator it can reach.
 */
export type WebauthnClientCapability =
  "available" | "no-platform-authenticator" | "insecure-origin" | "unsupported";

export interface WebauthnClientProbe {
  capability: WebauthnClientCapability;
  signals: WebauthnClientSignals;
}

function probeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "the capability call threw a non-error value";
}

/**
 * `PublicKeyCredential.getClientCapabilities()` — WebAuthn Level 3, and the
 * only API that reports hybrid transport, so it is asked first.
 *
 * The specification returns a map-like of `boolean`; implementations have
 * shipped it as a plain object. Both are accepted, and any non-boolean entry
 * is dropped rather than coerced — a truthy string here would silently become
 * a capability claim.
 */
async function readClientCapabilities(
  constructor: typeof PublicKeyCredential,
): Promise<Record<string, boolean> | null> {
  const getClientCapabilities = (
    constructor as unknown as { getClientCapabilities?: () => Promise<unknown> }
  ).getClientCapabilities;
  if (typeof getClientCapabilities !== "function") return null;

  const raw: unknown = await getClientCapabilities.call(constructor);
  const entries =
    raw instanceof Map
      ? [...raw.entries()]
      : typeof raw === "object" && raw !== null
        ? Object.entries(raw as Record<string, unknown>)
        : null;
  if (!entries) return null;

  return Object.fromEntries(
    entries.filter(
      (entry): entry is [string, boolean] =>
        typeof entry[0] === "string" && typeof entry[1] === "boolean",
    ),
  );
}

/** Resolve `call()`, recording rather than propagating a rejection. */
async function probeSignal(
  signals: WebauthnClientSignals,
  call: () => Promise<unknown>,
): Promise<boolean | null> {
  try {
    const value = await call();
    return typeof value === "boolean" ? value : null;
  } catch (error) {
    signals.probeError ??= probeErrorMessage(error);
    return null;
  }
}

/**
 * Ask this webview everything it will answer about its WebAuthn client.
 *
 * The probe never rejects, and — unlike the version it replaces — it never
 * fails closed into `"unsupported"` on a throw. Failing closed was the wrong
 * trade: it disabled a working ceremony on the strength of one advisory call,
 * which is how a machine with Windows Hello enrolled ended up being told it
 * had no authenticator. A capability call that throws or lies now costs a
 * warning banner; it no longer costs the user their passkey.
 */
export async function probeWebauthnClient(): Promise<WebauthnClientProbe> {
  const signals: WebauthnClientSignals = {
    secureContext: null,
    publicKeyCredential: false,
    credentialsCreate: false,
    credentialsGet: false,
    platformAuthenticator: null,
    hybridTransport: null,
    passkeyPlatformAuthenticator: null,
    conditionalGet: null,
    source: "none",
    probeError: null,
  };

  if (typeof window === "undefined") {
    return { capability: "unsupported", signals };
  }

  if (typeof window.isSecureContext === "boolean") {
    signals.secureContext = window.isSecureContext;
  }

  const constructor = (window as Window & { PublicKeyCredential?: unknown })
    .PublicKeyCredential;
  signals.publicKeyCredential = typeof constructor === "function";

  const credentials =
    typeof navigator === "undefined" ? undefined : navigator.credentials;
  signals.credentialsCreate = typeof credentials?.create === "function";
  signals.credentialsGet = typeof credentials?.get === "function";

  if (
    !signals.publicKeyCredential ||
    !signals.credentialsCreate ||
    !signals.credentialsGet
  ) {
    return {
      capability:
        signals.secureContext === false ? "insecure-origin" : "unsupported",
      signals,
    };
  }

  const publicKeyCredential = constructor as typeof PublicKeyCredential;

  try {
    const capabilities = await readClientCapabilities(publicKeyCredential);
    if (capabilities) {
      signals.source = "client-capabilities";
      signals.platformAuthenticator =
        capabilities.userVerifyingPlatformAuthenticator ?? null;
      signals.hybridTransport = capabilities.hybridTransport ?? null;
      signals.passkeyPlatformAuthenticator =
        capabilities.passkeyPlatformAuthenticator ?? null;
      signals.conditionalGet = capabilities.conditionalGet ?? null;
    }
  } catch (error) {
    signals.probeError = probeErrorMessage(error);
  }

  // Older clients — and any client whose capability map omitted the key — still
  // answer the two standalone calls.
  const isPlatformAuthenticatorAvailable =
    publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  if (
    signals.platformAuthenticator === null &&
    typeof isPlatformAuthenticatorAvailable === "function"
  ) {
    signals.platformAuthenticator = await probeSignal(signals, () =>
      isPlatformAuthenticatorAvailable.call(publicKeyCredential),
    );
    if (signals.source === "none") signals.source = "legacy-probe";
  }

  const isConditionalMediationAvailable = (
    publicKeyCredential as unknown as {
      isConditionalMediationAvailable?: () => Promise<unknown>;
    }
  ).isConditionalMediationAvailable;
  if (
    signals.conditionalGet === null &&
    typeof isConditionalMediationAvailable === "function"
  ) {
    signals.conditionalGet = await probeSignal(signals, () =>
      isConditionalMediationAvailable.call(publicKeyCredential),
    );
    if (signals.source === "none") signals.source = "legacy-probe";
  }

  // Any one of the three is enough. `passkeyPlatformAuthenticator` is the
  // client's own union of the other two, so a client that reports only that
  // one still resolves to "available".
  const reachable =
    signals.platformAuthenticator === true ||
    signals.hybridTransport === true ||
    signals.passkeyPlatformAuthenticator === true;

  return {
    capability: reachable ? "available" : "no-platform-authenticator",
    signals,
  };
}

/**
 * Whether an authenticator was actually detected.
 *
 * Note what this is *not*: a precondition for offering a ceremony. Nothing
 * gates a ceremony on it — see {@link WebauthnClientCapability}.
 */
export async function webauthnClientAvailable(): Promise<boolean> {
  return (await probeWebauthnClient()).capability === "available";
}

/**
 * A one-line account of what the probe found, for the diagnostic shown under
 * the advisory notice.
 *
 * Without it the user is told "no authenticator detected" and has nothing to
 * check. With it they can see whether the client was asked at all, which API
 * answered, and whether the call failed — which is the difference between
 * "enrol Windows Hello" and "this webview is not answering honestly".
 */
export function describeWebauthnSignals(
  signals: WebauthnClientSignals,
): string {
  const yesNo = (value: boolean | null) =>
    value === null ? "not reported" : value ? "yes" : "no";

  const parts = [
    `secure context: ${yesNo(signals.secureContext)}`,
    `built-in authenticator: ${yesNo(signals.platformAuthenticator)}`,
    `phone over hybrid: ${yesNo(signals.hybridTransport)}`,
  ];
  if (signals.passkeyPlatformAuthenticator !== null) {
    parts.push(
      `platform passkey support: ${yesNo(
        signals.passkeyPlatformAuthenticator,
      )}`,
    );
  }
  parts.push(
    `source: ${
      signals.source === "client-capabilities"
        ? "getClientCapabilities()"
        : signals.source === "legacy-probe"
          ? "isUserVerifyingPlatformAuthenticatorAvailable()"
          : "none — the client answered nothing"
    }`,
  );
  if (signals.probeError) parts.push(`probe error: ${signals.probeError}`);

  return parts.join("; ");
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

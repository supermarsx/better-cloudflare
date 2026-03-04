type Base64urlString = string;
type BinaryLike = Base64urlString | ArrayBuffer | Uint8Array | ArrayBufferView;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64urlToUint8Array(data: Base64urlString): Uint8Array {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return base64ToUint8Array(padded);
}

export function bufferToBase64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
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

function normalizeBinary(
  data: BinaryLike,
): Uint8Array | ArrayBuffer | ArrayBufferView {
  if (typeof data === "string") {
    try {
      return base64urlToUint8Array(data);
    } catch {
      return new TextEncoder().encode(data);
    }
  }
  return data;
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
    },
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

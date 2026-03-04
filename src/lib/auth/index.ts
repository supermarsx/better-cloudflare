export { CryptoManager, cryptoManager } from "./crypto";
export { benchmark, MAX_BENCHMARK_ITERATIONS } from "./crypto-benchmark";
export {
  createCredentialStore,
  SqliteCredentialStore,
} from "./credential-store";
export type { PasskeyCredential, CredentialStore } from "./credential-store";
export { vaultManager } from "./vault-manager";
export {
  base64urlToUint8Array,
  bufferToBase64url,
  toCredentialCreationOptions,
  toCredentialRequestOptions,
  serializeRegistrationCredential,
  serializeAuthenticationCredential,
} from "./webauthn";

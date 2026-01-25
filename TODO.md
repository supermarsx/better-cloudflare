# TODO

## Missing implementations / gaps
- Passkey WebAuthn options: use server-returned `options` for both registration and auth, and serialize/submit the full `PublicKeyCredential` response in the format expected by `@simplewebauthn/server`. ✅
- Passkey verification module loading: enable `@simplewebauthn/server` in ESM (dynamic import or `createRequire`) so server-side verification runs outside CommonJS. ✅
- SPF record builder: implement the dropdown-driven SPF mechanism builder in the inline editor. ✅
- User management for non-sqlite stores: implement or disable `/api/users` endpoints when the credential store is not sqlite-backed. ✅
- Admin CORS support: allow `X-Admin-Token` in CORS headers if admin endpoints are meant to be called from the browser. ✅
- Runtime alignment: decide between Vite vs Next for dev/build scripts and update docs/configs to match. ✅

// Ambient declarations retained from the pre-Next.js build. The `VITE_*` names
// below are still read at runtime as legacy fallbacks (see `src/lib/env.ts`),
// so the interfaces stay even though Vite itself is no longer a dependency.

declare module "*.css";

interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
  readonly VITE_CLOUDFLARE_API_BASE?: string;
  readonly VITE_SERVER_API_BASE?: string;
  readonly VITE_DEBUG_CF_API?: string;
  readonly VITE_DEBUG_SERVER?: string;
  readonly VITE_DEBUG_SERVER_API?: string;
  readonly VITE_PORT?: string;
  readonly VITE_ALLOWED_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

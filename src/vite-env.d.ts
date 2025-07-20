/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_CLOUDFLARE_API_BASE?: string;
  readonly VITE_SERVER_API_BASE?: string;
  readonly VITE_DEBUG_CF_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

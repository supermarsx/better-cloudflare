/// <reference types="vite/client" />

declare module '*.css';

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

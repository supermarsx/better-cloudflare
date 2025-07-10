/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_CLOUDFLARE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

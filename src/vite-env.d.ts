/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEDIA_BACKEND?: 'mesh' | 'livekit';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

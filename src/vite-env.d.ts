/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVEKIT_URL?: string;
  readonly VITE_LIVEKIT_TOKEN_ENDPOINT?: string;
  readonly VITE_LIVEKIT_DEVELOPMENT_TOKEN_SERVER_ID?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SOCIAL_API_ENDPOINT?: string;
}

interface ImportMeta { readonly env: ImportMetaEnv; }

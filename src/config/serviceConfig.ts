const DEFAULT_SERVICE_BASE_URL = "https://mhtalk-token-service.mhlkotalk.workers.dev";
const DEFAULT_LIVEKIT_URL = "wss://mhtalkremake-utuei6i7.livekit.cloud";
const DEFAULT_SUPABASE_URL = "https://fcadjrqrrzcvbyqrgnnm.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_3Azp3R7eFE8YI81Eg_Bekw_D353_Efc";

function serviceOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return DEFAULT_SERVICE_BASE_URL;
  }
}

const configuredServiceUrl =
  import.meta.env.VITE_SOCIAL_API_ENDPOINT ||
  import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT ||
  DEFAULT_SERVICE_BASE_URL;

export const serviceBaseUrl = serviceOrigin(configuredServiceUrl);
export const liveKitTokenEndpoint =
  import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT || `${serviceBaseUrl}/livekit/token`;
export const liveKitUrl = import.meta.env.VITE_LIVEKIT_URL || DEFAULT_LIVEKIT_URL;
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
export const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_PUBLISHABLE_KEY;

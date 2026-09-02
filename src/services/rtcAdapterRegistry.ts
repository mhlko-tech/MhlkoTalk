import type { RtcProviderId } from "../core/rtcProviders";
import type { RoomServiceRouting } from "../core/serviceRouting";

export type RoomConnectionCredentials = {
  token: string;
  /** Short-lived HMAC capability used only for private room attachments. */
  attachmentAccessToken?: string;
  /** Signed capability used for idempotent participant-minute heartbeats. */
  usageAccessToken?: string;
  /** Provider-scoped participant identity. Never infer it from opaque tokens. */
  identity?: string;
  /** Optional second identity/token used by providers that publish screen share separately. */
  screenToken?: string;
  screenIdentity?: string;
  roomName: string;
  routing: RoomServiceRouting;
};

export type RtcMediaCapabilities = {
  nativeMhtalkControls: boolean;
  independentScreenAudio: boolean;
  stableAudioOutputRoute: boolean;
  crossPlatformParity: boolean;
};

export interface RtcProviderAdapter {
  readonly provider: RtcProviderId;
  readonly mediaCapabilities: RtcMediaCapabilities;
  connect(credentials: RoomConnectionCredentials): Promise<void>;
}

/**
 * Holds only adapters that are actually shipped in this client build.
 * The server receives this exact capability list and therefore cannot route a
 * room to a provider whose SDK is missing from the installed application.
 */
export class RtcAdapterRegistry {
  private readonly adapters = new Map<RtcProviderId, RtcProviderAdapter>();

  constructor(adapters: readonly RtcProviderAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider)) {
        throw new Error(`Duplicate RTC adapter: ${adapter.provider}`);
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  supportedProviders(): RtcProviderId[] {
    return [...this.adapters.keys()];
  }

  routableProviders(): RtcProviderId[] {
    return [...this.adapters.values()]
      .filter((adapter) => {
        const media = adapter.mediaCapabilities;
        return media.nativeMhtalkControls &&
          media.independentScreenAudio &&
          media.stableAudioOutputRoute &&
          media.crossPlatformParity;
      })
      .map((adapter) => adapter.provider);
  }

  async connect(credentials: RoomConnectionCredentials) {
    const provider = credentials.routing.rtc.provider;
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        "This app version cannot open the selected room connection",
      );
    }
    const media = adapter.mediaCapabilities;
    if (!media.nativeMhtalkControls || !media.independentScreenAudio || !media.stableAudioOutputRoute || !media.crossPlatformParity) {
      throw new Error(
        "This room connection cannot provide the full MHTalk media experience on every device",
      );
    }
    await adapter.connect(credentials);
  }
}

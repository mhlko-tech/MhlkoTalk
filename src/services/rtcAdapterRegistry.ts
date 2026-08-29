import type { RtcProviderId } from "../core/rtcProviders";
import type { RoomServiceRouting } from "../core/serviceRouting";

export type RoomConnectionCredentials = {
  token: string;
  /** Provider-scoped participant identity. Never infer it from opaque tokens. */
  identity?: string;
  /** Optional second identity/token used by providers that publish screen share separately. */
  screenToken?: string;
  screenIdentity?: string;
  roomName: string;
  routing: RoomServiceRouting;
};

export interface RtcProviderAdapter {
  readonly provider: RtcProviderId;
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

  async connect(credentials: RoomConnectionCredentials) {
    const provider = credentials.routing.rtc.provider;
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `The selected call provider (${provider}) is not supported by this app version`,
      );
    }
    await adapter.connect(credentials);
  }
}

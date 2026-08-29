import { RealtimeRoom } from '../realtime';
import type { ProfileAssetAccess } from '../profileAssets';
import type { RoomSessionOptions } from '../roomSession';
import { LiveKitMediaSession } from './livekitMediaSession';

/**
 * Transitional voice-first SFU adapter.
 *
 * Membership, moderation, durable control, screen sharing, and file compatibility
 * remain on RealtimeRoom while voice is moved to one SFU connection per client.
 */
export class LiveKitVoiceRoomSession extends RealtimeRoom {
  private readonly media: LiveKitMediaSession;
  private mediaReady: Promise<void> | null = null;

  constructor(options: RoomSessionOptions) {
    let handleAccess: ((access: ProfileAssetAccess | null) => void) | undefined;
    const callbacks = options.callbacks;
    super({
      ...options,
      callbacks: {
        ...callbacks,
        onProfileAssetAccess: (access) => {
          handleAccess?.(access);
          callbacks.onProfileAssetAccess?.(access);
        }
      }
    });
    this.media = new LiveKitMediaSession({
      onState: (state) => callbacks.onLog?.(`SFU voice state: ${state}`, state === 'failed' ? 'error' : 'info'),
      onError: (error) => callbacks.onError(error.message)
    });
    handleAccess = (access) => {
      if (!access) {
        this.mediaReady = null;
        this.media.disconnect().catch(() => undefined);
        return;
      }
      this.mediaReady = this.media.connect(access);
      this.mediaReady.catch((error) => callbacks.onError(String((error as Error)?.message || error)));
    };
  }

  override async startVoice(inputDeviceId?: string, outputDeviceId?: string): Promise<void> {
    if (!this.mediaReady) throw new Error('SFU voice authorization is not ready');
    await this.mediaReady;
    await this.media.setOutputDevice(outputDeviceId);
    await this.media.setMicrophoneEnabled(true, inputDeviceId);
    this.setExternalMicEnabled(true);
  }

  override async stopVoice(send = true): Promise<void> {
    if (this.media.getState() === 'connected') await this.media.setMicrophoneEnabled(false).catch(() => undefined);
    if (send) this.setExternalMicEnabled(false);
  }

  override setMicEnabled(enabled: boolean): void {
    this.setExternalMicEnabled(enabled);
    this.media.setMicrophoneEnabled(enabled).catch((error) => {
      this.setExternalMicEnabled(false);
      console.error('Could not update SFU microphone state', error);
    });
  }

  override async setVoiceEnhanceEnabled(_enabled: boolean): Promise<void> {
    // WebRTC audio processing is owned by the SFU client in this backend.
  }

  override async setVoiceOutputDevice(outputDeviceId?: string): Promise<void> {
    await this.media.setOutputDevice(outputDeviceId);
  }

  override async setPeerVoiceVolume(peerId: string, volume: number, muted: boolean): Promise<void> {
    this.media.setPeerVolume(peerId, volume, muted);
  }

  override close(): void {
    super.close();
    this.media.disconnect().catch(() => undefined);
  }
}

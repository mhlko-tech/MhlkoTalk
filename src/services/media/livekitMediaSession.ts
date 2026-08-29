import {
  ConnectionQuality,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client';
import type { ProfileAssetAccess } from '../profileAssets';
import { fetchLiveKitConnectionDetails } from './livekitTokenSource';

export type LiveKitMediaKind = 'microphone' | 'camera' | 'screen' | 'screen-audio';
export type LiveKitMediaState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type LiveKitMediaCallbacks = {
  onState?: (state: LiveKitMediaState) => void;
  onParticipantConnected?: (identity: string, name: string) => void;
  onParticipantDisconnected?: (identity: string) => void;
  onRemoteTrack?: (identity: string, kind: LiveKitMediaKind, stream: MediaStream) => void;
  onRemoteTrackRemoved?: (identity: string, kind: LiveKitMediaKind) => void;
  onConnectionQuality?: (identity: string, quality: ConnectionQuality) => void;
  onSpeakingChanged?: (identities: string[]) => void;
  onError?: (error: Error) => void;
};

function mediaKind(publication: RemoteTrackPublication): LiveKitMediaKind | null {
  if (publication.source === Track.Source.Microphone) return 'microphone';
  if (publication.source === Track.Source.Camera) return 'camera';
  if (publication.source === Track.Source.ScreenShare) return 'screen';
  if (publication.source === Track.Source.ScreenShareAudio) return 'screen-audio';
  return null;
}

/**
 * Isolated SFU media adapter. It deliberately owns media only; durable chat,
 * moderation, and membership remain on the authoritative control plane.
 */
export class LiveKitMediaSession {
  private readonly room: Room;
  private readonly callbacks: LiveKitMediaCallbacks;
  private state: LiveKitMediaState = 'idle';
  private connectAbort?: AbortController;
  private readonly audioElements = new Map<string, Set<HTMLMediaElement>>();
  private readonly peerVolumes = new Map<string, { volume: number; muted: boolean }>();
  private outputDeviceId = '';

  constructor(callbacks: LiveKitMediaCallbacks = {}) {
    this.callbacks = callbacks;
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: false
    });
    this.bindEvents();
  }

  getState(): LiveKitMediaState {
    return this.state;
  }

  async connect(access: ProfileAssetAccess): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected' || this.state === 'reconnecting') return;
    this.connectAbort?.abort();
    const controller = new AbortController();
    this.connectAbort = controller;
    this.setState('connecting');
    try {
      const details = await fetchLiveKitConnectionDetails(access, controller.signal);
      if (controller.signal.aborted) return;
      await this.room.connect(details.serverUrl, details.participantToken, { autoSubscribe: true });
      await this.room.startAudio().catch(() => undefined);
      this.setState('connected');
    } catch (error) {
      if (controller.signal.aborted) return;
      const safeError = error instanceof Error ? error : new Error(String(error));
      this.setState('failed');
      this.callbacks.onError?.(safeError);
      throw safeError;
    } finally {
      if (this.connectAbort === controller) this.connectAbort = undefined;
    }
  }

  async setMicrophoneEnabled(enabled: boolean, deviceId?: string): Promise<void> {
    await this.requireConnected();
    await this.room.localParticipant.setMicrophoneEnabled(
      enabled,
      enabled && deviceId ? { deviceId } : undefined
    );
  }

  async setCameraEnabled(enabled: boolean, deviceId?: string): Promise<void> {
    await this.requireConnected();
    await this.room.localParticipant.setCameraEnabled(
      enabled,
      enabled && deviceId ? { deviceId } : undefined
    );
  }

  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    await this.requireConnected();
    await this.room.localParticipant.setScreenShareEnabled(enabled);
  }

  async setOutputDevice(deviceId?: string): Promise<void> {
    this.outputDeviceId = deviceId || '';
    await Promise.all([...this.audioElements.values()].flatMap((elements) =>
      [...elements].map((element) => {
        const sink = element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
        return typeof sink.setSinkId === 'function' ? sink.setSinkId(this.outputDeviceId).catch(() => undefined) : Promise.resolve();
      })
    ));
  }

  setPeerVolume(identity: string, volume: number, muted: boolean): void {
    const safeVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    this.peerVolumes.set(identity, { volume: safeVolume, muted });
    for (const element of this.audioElements.get(identity) || []) {
      element.volume = safeVolume;
      element.muted = muted;
    }
  }

  async disconnect(): Promise<void> {
    this.connectAbort?.abort();
    this.connectAbort = undefined;
    await this.room.disconnect(true);
    for (const elements of this.audioElements.values()) {
      for (const element of elements) element.remove();
    }
    this.audioElements.clear();
    this.setState('disconnected');
  }

  private async requireConnected(): Promise<void> {
    if (this.state !== 'connected') throw new Error('SFU media is not connected');
  }

  private setState(state: LiveKitMediaState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState?.(state);
  }

  private bindEvents(): void {
    this.room
      .on(RoomEvent.Reconnecting, () => this.setState('reconnecting'))
      .on(RoomEvent.SignalReconnecting, () => this.setState('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.setState('connected'))
      .on(RoomEvent.Disconnected, () => {
        if (this.state !== 'failed') this.setState('disconnected');
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        this.callbacks.onParticipantConnected?.(participant.identity, participant.name || participant.identity);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
        this.callbacks.onParticipantDisconnected?.(participant.identity);
      })
      .on(RoomEvent.TrackSubscribed, (
        track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        const kind = mediaKind(publication);
        const mediaTrack = track.mediaStreamTrack;
        if (!kind || !mediaTrack) return;
        if (kind === 'microphone' || kind === 'screen-audio') {
          const element = track.attach();
          if (element instanceof HTMLMediaElement) {
            element.autoplay = true;
            element.style.display = 'none';
            const preference = this.peerVolumes.get(participant.identity) || { volume: 1, muted: false };
            element.volume = preference.volume;
            element.muted = preference.muted;
            document.body.appendChild(element);
            const elements = this.audioElements.get(participant.identity) || new Set<HTMLMediaElement>();
            elements.add(element);
            this.audioElements.set(participant.identity, elements);
            if (this.outputDeviceId) this.setOutputDevice(this.outputDeviceId).catch(() => undefined);
          }
        }
        this.callbacks.onRemoteTrack?.(participant.identity, kind, new MediaStream([mediaTrack]));
      })
      .on(RoomEvent.TrackUnsubscribed, (
        _track: RemoteTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        const kind = mediaKind(publication);
        for (const element of this.audioElements.get(participant.identity) || []) {
          const media = element as HTMLMediaElement & { srcObject?: MediaProvider | null };
          const stream = media.srcObject;
          if (stream instanceof MediaStream && stream.getTracks().some((candidate) => candidate.id === _track.mediaStreamTrack.id)) {
            _track.detach(element);
            element.remove();
            this.audioElements.get(participant.identity)?.delete(element);
          }
        }
        if (kind) this.callbacks.onRemoteTrackRemoved?.(participant.identity, kind);
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant) => {
        this.callbacks.onConnectionQuality?.(participant.identity, quality);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
        this.callbacks.onSpeakingChanged?.(participants.map((participant) => participant.identity));
      })
      .on(RoomEvent.MediaDevicesError, (error) => {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }
}

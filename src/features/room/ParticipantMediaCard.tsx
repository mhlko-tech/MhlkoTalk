import { useEffect, useState } from "react";
import { Avatar } from "../../components/Avatar";
import {
  availableQualities,
  mediaQualityLabels,
} from "../../core/mediaQuality";
import type { MediaQuality, UserProfile } from "../../core/types";
import { roomSession } from "../../services/roomSession";

export function ParticipantMediaCard({
  identity,
  name,
  avatar,
  bio,
  speaking,
  microphoneEnabled,
  cameraEnabled,
  screenShareEnabled,
  cameraQuality,
  screenShareQuality,
  local = false,
  onProfile,
}: {
  identity: string;
  name: string;
  avatar: string;
  bio: string;
  speaking: boolean;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  cameraQuality: MediaQuality;
  screenShareQuality: MediaQuality;
  local?: boolean;
  onProfile: (profile: UserProfile) => void;
}) {
  const hostIdentity = encodeURIComponent(identity);
  const [watchingCamera, setWatchingCamera] = useState(false);
  const [watchingScreen, setWatchingScreen] = useState(false);
  const [selectedCameraQuality, setSelectedCameraQuality] = useState<MediaQuality>(
    cameraQuality === "low" ? "low" : "medium",
  );
  const [selectedScreenQuality, setSelectedScreenQuality] = useState<MediaQuality>(
    screenShareQuality === "low" ? "low" : "medium",
  );

  useEffect(() => {
    if (!cameraEnabled && watchingCamera) {
      roomSession.stopWatchingParticipantMedia(identity, "camera");
      setWatchingCamera(false);
    }
  }, [cameraEnabled, identity, watchingCamera]);
  useEffect(() => {
    if (!screenShareEnabled && watchingScreen) {
      roomSession.stopWatchingParticipantMedia(identity, "screen");
      setWatchingScreen(false);
    }
  }, [identity, screenShareEnabled, watchingScreen]);
  useEffect(() => {
    if (!availableQualities(cameraQuality).includes(selectedCameraQuality))
      setSelectedCameraQuality(cameraQuality);
  }, [cameraQuality, selectedCameraQuality]);
  useEffect(() => {
    if (!availableQualities(screenShareQuality).includes(selectedScreenQuality))
      setSelectedScreenQuality(screenShareQuality);
  }, [screenShareQuality, selectedScreenQuality]);
  useEffect(
    () => () => {
      if (!local) {
        roomSession.stopWatchingParticipantMedia(identity, "camera");
        roomSession.stopWatchingParticipantMedia(identity, "screen");
      }
    },
    [identity, local],
  );

  const toggleMedia = async (source: "camera" | "screen") => {
    const watching = source === "camera" ? watchingCamera : watchingScreen;
    const quality =
      source === "camera" ? selectedCameraQuality : selectedScreenQuality;
    if (watching) {
      roomSession.stopWatchingParticipantMedia(identity, source);
      if (source === "camera") setWatchingCamera(false);
      else setWatchingScreen(false);
      return;
    }
    const opened = await roomSession.watchParticipantMedia(
      identity,
      source,
      quality,
    );
    if (opened) {
      if (source === "camera") setWatchingCamera(true);
      else setWatchingScreen(true);
    }
  };
  return (
    <article className="participant-card">
      <button
        className={`participant-card-header ${speaking ? "speaking" : ""}`}
        onClick={() => onProfile({ name, avatar, bio })}
      >
        <Avatar value={avatar} remote={!local} />
        <span>
          <strong>{name}</strong>
          <small>
            {microphoneEnabled ? (speaking ? "Speaking" : "Mic on") : "Mic off"}
          </small>
        </span>
        <i aria-label={microphoneEnabled ? "Microphone on" : "Microphone off"}>
          {microphoneEnabled ? "🎙️" : "🔇"}
        </i>
      </button>
      {!local && (cameraEnabled || screenShareEnabled) && (
        <div className="participant-media-controls">
          {cameraEnabled && (
            <div>
              <button onClick={() => void toggleMedia("camera")}>
                {watchingCamera ? "Hide camera" : "Watch camera"}
              </button>
              {watchingCamera && (
                <select
                  aria-label="Camera quality"
                  value={selectedCameraQuality}
                  onChange={(event) => {
                    const quality = event.target.value as MediaQuality;
                    setSelectedCameraQuality(quality);
                    roomSession.setParticipantVideoQuality(
                      identity,
                      "camera",
                      quality,
                    );
                  }}
                >
                  {availableQualities(cameraQuality).map((quality) => (
                    <option key={quality} value={quality}>
                      {mediaQualityLabels[quality]}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {screenShareEnabled && (
            <div>
              <button onClick={() => void toggleMedia("screen")}>
                {watchingScreen ? "Stop watching" : "Watch stream"}
              </button>
              {watchingScreen && (
                <select
                  aria-label="Stream quality"
                  value={selectedScreenQuality}
                  onChange={(event) => {
                    const quality = event.target.value as MediaQuality;
                    setSelectedScreenQuality(quality);
                    roomSession.setParticipantVideoQuality(
                      identity,
                      "screen",
                      quality,
                    );
                  }}
                >
                  {availableQualities(screenShareQuality).map((quality) => (
                    <option key={quality} value={quality}>
                      {mediaQualityLabels[quality]}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      )}
      <div
        id={`media-host-${hostIdentity}-camera`}
        className="participant-media-host"
      />
      <div
        id={`media-host-${hostIdentity}-screen`}
        className="participant-media-host"
      />
    </article>
  );
}


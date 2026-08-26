import { useRef, useState } from "react";
import type { ChatMessage, ChatSnapshot } from "../../core/types";

export function Attachment({
  attachment,
  onOpenImage,
}: {
  attachment: ChatSnapshot["messages"][number]["attachment"];
  onOpenImage: (url: string, name: string) => void;
}) {
  if (!attachment) return null;
  if (attachment.kind === "image")
    return (
      <button
        type="button"
        className="attachment image"
        onClick={() => onOpenImage(attachment.url, attachment.name)}
        aria-label={`Open ${attachment.name}`}
      >
        <img src={attachment.url} alt={attachment.name} />
      </button>
    );
  if (attachment.kind === "video")
    return <video className="attachment video" src={attachment.url} controls />;
  if (attachment.kind === "audio")
    return <VoiceAttachment url={attachment.url} />;
  return (
    <a
      className="attachment file"
      href={attachment.url}
      download={attachment.name}
    >
      📎 {attachment.name} <small>{Math.ceil(attachment.size / 1024)} KB</small>
    </a>
  );
}

export function messagePreview(message: ChatMessage) {
  if (message.body) return message.body;
  if (message.attachment?.kind === "audio") return "Voice message";
  if (message.attachment?.kind === "image") return "Image";
  if (message.attachment?.kind === "video") return "Video";
  return message.attachment?.name || "Attachment";
}

function VoiceAttachment({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const format = (value: number) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  const updateDuration = () => {
    const value = audio.current?.duration ?? 0;
    if (Number.isFinite(value) && value > 0) setDuration(value);
  };
  return (
    <div className="attachment audio">
      <span>Voice message</span>
      <audio
        ref={audio}
        src={url}
        onLoadedMetadata={() => {
          updateDuration();
          const element = audio.current;
          if (element && !Number.isFinite(element.duration)) {
            element.currentTime = 1e6;
          }
        }}
        onDurationChange={updateDuration}
        onTimeUpdate={() => setProgress(audio.current?.currentTime || 0)}
        onEnded={() => setPlaying(false)}
      />
      <div className="voice-ui">
        <button
          onClick={() => {
            if (!audio.current) return;
            if (audio.current.paused) {
              void audio.current.play();
              setPlaying(true);
            } else {
              audio.current.pause();
              setPlaying(false);
            }
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          disabled={!safeDuration}
          type="range"
          min="0"
          max={safeDuration || 1}
          step="0.01"
          value={Math.min(progress, safeDuration || 1)}
          onChange={(event) => {
            if (audio.current)
              audio.current.currentTime = Number(event.target.value);
            setProgress(Number(event.target.value));
          }}
        />
        <time>
          {format(progress)} / {safeDuration ? format(safeDuration) : "--:--"}
        </time>
      </div>
      <div className="audio-wave">
        {Array.from({ length: 30 }, (_, index) => (
          <i
            key={index}
            style={{
              height: `${20 + ((index * 19) % 70)}%`,
              opacity:
                index / 30 <= (safeDuration ? progress / safeDuration : 0)
                  ? 1
                  : 0.35,
            }}
          />
        ))}
      </div>
    </div>
  );
}


export function mimeFromName(name: string) {
  const ext = name.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        mp4: "video/mp4",
        webm: "video/webm",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        pdf: "application/pdf",
      } as Record<string, string>
    )[ext || ""] || "application/octet-stream"
  );
}


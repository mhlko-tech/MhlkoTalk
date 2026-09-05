export type InfoPage = "help" | "terms" | "privacy";

const infoPages: Record<InfoPage, { title: string; paragraphs: readonly string[] }> = {
  help: {
    title: "Help Center",
    paragraphs: [
      "MHTalk is a desktop voice, video, screen-sharing and room-chat application. Use Main for public conversation and private-room invitations only with people you trust.",
      "Before sharing a screen, camera, microphone, file or recording, confirm that everyone affected has consented. Never expose passwords, payment details, private messages or other sensitive information.",
      "If audio becomes unstable, keep MHTalk open while it reconnects automatically. Check the selected microphone and speaker under Settings if sound does not return.",
      "MHTalk must not be used for harassment, threats, impersonation, piracy, sexual exploitation, malware distribution or any activity forbidden by local law. You are responsible for what you publish and record.",
    ],
  },
  terms: {
    title: "Terms of Service",
    paragraphs: [
      "By using MHTalk you agree to use it lawfully, respect other people and obtain any permission required before recording or redistributing their voice, image, screen or files.",
      "You must not bypass room protections, disrupt the service, distribute harmful files, infringe intellectual-property rights, or use MHTalk to abuse, exploit or endanger another person.",
      "Public-room moderation reduces obvious harmful text but cannot guarantee that every language, spelling or attachment is safe. Users remain responsible for their conduct and for deciding what they open or download.",
      "The software is provided as available. Network providers, devices and third-party infrastructure can affect quality. These terms do not remove any non-waivable rights granted by applicable law.",
    ],
  },
  privacy: {
    title: "Privacy Policy",
    paragraphs: [
      "Your account identifier, username, email address, profile, friend relationships, blocks and notification tokens are hosted by Supabase. Passwords are processed and hashed by Supabase Auth and are never stored by MHTalk. Google supplies basic account information only when you choose Google sign-in.",
      "MHTalk does not sell personal data. Live room media and messages are transmitted through the active realtime provider, currently Daily or LiveKit. Files, recordings and recovered recording pieces remain on the device paths selected by you unless you deliberately send them.",
      "People in a room may capture or redistribute what they receive. Share only what you are comfortable revealing and use private invitations carefully.",
      "You can sign out, remove your profile photo, leave a room, delete local recordings and stop camera, microphone or screen sharing at any time. Contact MHTalk to request account deletion.",
    ],
  },
};

export function InfoDialog({ page, onClose }: { page: InfoPage; onClose: () => void }) {
  const content = infoPages[page];
  return (
    <div className="modal-backdrop">
      <section className="private-modal info-modal" role="dialog" aria-modal="true" aria-label={content.title}>
        <button className="modal-close" onClick={onClose}>×</button>
        <h2>{content.title}</h2>
        <div className="info-content">
          {content.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </div>
      </section>
    </div>
  );
}

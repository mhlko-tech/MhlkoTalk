import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasMembershipBadge, subscriptionLabels } from "../../core/subscription";
import {
  disconnectMembership,
  linkExistingLavaMembership,
  startLavaMembership,
  startPatreonMembership,
  syncLavaMembership,
  type MembershipPlanId,
  type MembershipSync,
} from "../../services/membershipService";

const patreonMembershipUrl = "https://www.patreon.com/cw/MhlkoVD/membership";
const mvDownloaderUrl = "https://github.com/mhlko-tech/MVDownloader/releases/latest";
const mhtalkShareText = "Try MHTalk Beta for voice, video, rooms and chat: https://github.com/mhlko-tech/MhlkoTalk/releases/latest";

type PlanCard = {
  id: MembershipPlanId;
  name: string;
  price: number;
  description: string;
  benefits: readonly string[];
};

const membershipPlans: readonly PlanCard[] = [
  {
    id: "plus",
    name: "Plus",
    price: 5,
    description: "HD media essentials for MHTalk, plus higher MVDownloader limits.",
    benefits: [
      "MHTalk Plus badge, 1080p camera/screen sharing and source-quality recording up to 120 FPS",
      "MVDownloader: unlimited audio and 720p, plus 10 Full HD downloads every 24 hours",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: 7,
    description: "The complete MHTalk experience with unlimited Full HD downloads.",
    benefits: [
      "Everything in Plus, plus 100 MB files, 7-day retention, profiles, themes, frames, emojis, soundboard and custom invites",
      "MVDownloader: unlimited 1080p, 720p and high-quality audio",
    ],
  },
  {
    id: "ultimate",
    name: "Ultimate",
    price: 10,
    description: "Maximum MVDownloader quality with the complete MHTalk experience.",
    benefits: [
      "MVDownloader: unlimited 2K, 4K and higher source-quality video",
      "Every MHTalk Pro feature with the exclusive Ultimate badge",
    ],
  },
  {
    id: "max_supporter",
    name: "Max Supporter",
    price: 15,
    description: "All Ultimate MVDownloader benefits plus extra support for the project.",
    benefits: [
      "MVDownloader: everything included with Ultimate",
      "Every MHTalk Pro feature with the exclusive Max Supporter badge",
    ],
  },
];

function activeMessage(result: MembershipSync | null) {
  if (!result) return "Start or link a membership first.";
  if (hasMembershipBadge(result.tier)) return `MHTalk ${subscriptionLabels[result.tier]} is active on this account.`;
  return result.pending ? "Membership confirmation is still pending." : "No active membership was found.";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function MembershipDialog({
  open,
  onClose,
  onAppMessage,
}: {
  open: boolean;
  onClose: () => void;
  onAppMessage: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<MembershipPlanId>("plus");
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<MembershipSync | null>(null);
  const [activationCode, setActivationCode] = useState("");

  useEffect(() => {
    void syncLavaMembership()
      .then((result) => { if (result) setDetails(result); })
      .catch(() => undefined);
  }, []);

  if (!open) return null;
  const selectedPlan = membershipPlans.find((item) => item.id === plan) ?? membershipPlans[0];

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="private-modal support-modal" role="dialog" aria-modal="true" aria-label="MHTalk Beta and support">
        <button className="modal-close" onClick={onClose}>×</button>
        <div className="support-heading"><span>M</span><div><h2>One membership. Two apps.</h2><small>Choose a plan, then pay with LAVA or Patreon</small></div></div>
        <p className="support-membership">Your verified membership works with MHTalk on Windows and Android and with MVDownloader. Calling, messaging and safety features remain free.</p>
        <div className="membership-plans" role="radiogroup" aria-label="Monthly membership plan">
          {membershipPlans.map((item) => (
            <button
              type="button"
              className={`membership-plan-card ${plan === item.id ? "selected" : ""}`}
              aria-pressed={plan === item.id}
              onClick={() => setPlan(item.id)}
              key={item.id}
            >
              <span className="membership-plan-top"><strong>{item.name}</strong><b>${item.price} <small>/ month</small></b></span>
              <span className="membership-plan-copy">{item.description}</span>
              {item.benefits.map((benefit) => <span className="membership-plan-benefits" key={benefit}>✓ {benefit}</span>)}
            </button>
          ))}
        </div>
        <p className="support-tier-note">Plus focuses on HD sharing and recording. Pro unlocks the rest of MHTalk. Ultimate and Max Supporter include every Pro feature with their own exclusive badge.</p>
        {details && (
          <div className="support-membership-status">
            Plan: {subscriptionLabels[details.tier]} · Source: {(details.provider || "lava").toUpperCase()} · Status: {details.status === "gifted" ? "Gifted" : details.status === "active" || details.status === "owner" ? "Active" : details.status}
          </div>
        )}
        {message && <div className="support-membership-status">{message}</div>}
        <div className="support-membership-link">
          <label htmlFor="membership-activation-code">Already have a shared membership?</label>
          <p>In MVDownloader open Settings → Membership details, copy the MHTalk activation code and paste it here.</p>
          <div>
            <input
              id="membership-activation-code"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={activationCode}
              placeholder="Paste activation code"
              onChange={(event) => setActivationCode(event.target.value)}
            />
            <button className="control" disabled={busy || !activationCode.trim()} onClick={() => void run(async () => {
              try {
                const result = await linkExistingLavaMembership(activationCode);
                setActivationCode("");
                setDetails(result);
                setMessage(activeMessage(result));
              } catch (error) {
                setMessage(errorMessage(error, "Could not link this membership"));
              }
            })}>Link membership</button>
          </div>
        </div>
        <div className="support-actions">
          <button className="primary" disabled={busy} onClick={() => void run(async () => {
            try {
              await startLavaMembership(plan);
              setMessage("Complete payment in your browser, then return here and choose Check now.");
            } catch (error) {
              onAppMessage(errorMessage(error, "Could not open LAVA membership"));
            }
          })}>{busy ? "Opening LAVA…" : `Continue with LAVA · $${selectedPlan.price}`}</button>
          <button className="control" disabled={busy} onClick={() => void run(async () => {
            try {
              const result = await syncLavaMembership(true);
              setDetails(result);
              setMessage(activeMessage(result));
            } catch (error) {
              setMessage(errorMessage(error, "Could not verify membership"));
            }
          })}>Check now</button>
          <button className="control" onClick={() => void openUrl(patreonMembershipUrl)}>View Patreon plans</button>
          <button className="control" disabled={busy} onClick={() => void run(async () => {
            try {
              const result = await startPatreonMembership();
              if (result) {
                setDetails(result);
                setMessage(`MHTalk ${subscriptionLabels[result.tier]} is active from Patreon.`);
              } else {
                setMessage("Finish linking in Patreon, then return here and choose Check now.");
              }
            } catch (error) {
              setMessage(errorMessage(error, "Could not link Patreon membership"));
            }
          })}>Link Patreon membership</button>
          {details?.provider === "patreon" && !details.pending && hasMembershipBadge(details.tier) && (
            <button className="control" disabled={busy} onClick={() => void run(async () => {
              try {
                await disconnectMembership();
                setDetails(null);
                setMessage("This MHTalk device was disconnected. Your MVDownloader session was not changed.");
              } catch (error) {
                setMessage(errorMessage(error, "Could not disconnect this MHTalk membership"));
              }
            })}>Disconnect this MHTalk device</button>
          )}
          <button className="control" onClick={() => void openUrl(mvDownloaderUrl)}>Download MVDownloader</button>
          <button className="control" onClick={() => {
            void navigator.clipboard.writeText(mhtalkShareText)
              .then(() => onAppMessage("MHTalk link copied — thank you for sharing."));
          }}>Share MHTalk</button>
        </div>
      </section>
    </div>
  );
}

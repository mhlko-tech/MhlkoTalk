import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasMembershipBadge, subscriptionLabels } from "../../core/subscription";
import "./membership.css";
import {
  cancelPatreonConnection,
  openPatreonCheckout,
  disconnectMembership,
  linkExistingLavaMembership,
  startLavaMembership,
  startPatreonMembership,
  syncLavaMembership,
  type MembershipPlanId,
  type MembershipSync,
} from "../../services/membershipService";

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
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
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
  const [patreonBusy, setPatreonBusy] = useState(false);
  const [plan, setPlan] = useState<MembershipPlanId>("plus");
  const [provider, setProvider] = useState<"lava" | "patreon">("lava");
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<MembershipSync | null>(null);
  const [activationCode, setActivationCode] = useState("");

  useEffect(() => {
    void syncLavaMembership()
      .then((result) => { if (result) setDetails(result); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{phase: string; message: string}>("patreon-connection-progress", (event) => setMessage(event.payload.message))
      .then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => undefined);
    return () => { disposed = true; stop?.(); void cancelPatreonConnection().catch(() => undefined); };
  }, [open]);

  if (!open) return null;
  const selectedPlan = membershipPlans.find((item) => item.id === plan) ?? membershipPlans[0];

  const run = async (operation: () => Promise<void>, usesPatreon = false) => {
    if (busy) return;
    setBusy(true);
    setPatreonBusy(usesPatreon);
    try {
      await operation();
    } finally {
      setBusy(false);
      setPatreonBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="private-modal support-modal membership-checkout" role="dialog" aria-modal="true" aria-label="MHTalk membership">
        <button className="modal-close" onClick={onClose}>×</button>
        <div className="support-heading"><span>M</span><div><h2>Membership</h2><small>Choose how to pay, then choose your tier.</small></div></div>
        <p className="support-membership">Your verified membership works with MHTalk on Windows and Android and with MVDownloader. Calling, messaging and safety features remain free.</p>
        <fieldset className="membership-payment-methods" disabled={busy}>
          <legend>Payment method</legend>
          {(["lava", "patreon"] as const).map((method) => (
            <label className={`membership-payment-method ${provider === method ? "selected" : ""}`} key={method}>
              <input type="radio" name="membership-provider" value={method} checked={provider === method} onChange={() => setProvider(method)} />
              <span><strong>Pay with {method === "lava" ? "LAVA" : "Patreon"}</strong><small>{method === "lava" ? "Choose a tier and continue to checkout" : "Subscribe or link an existing membership"}</small></span>
            </label>
          ))}
        </fieldset>
        <h3 className="membership-tier-heading">Choose your tier</h3>
        <div className="membership-plans" role="group" aria-label="Monthly membership plan">
          {membershipPlans.map((item) => (
            <button
              type="button"
              className={`membership-plan-card ${plan === item.id ? "selected" : ""}`}
              aria-pressed={plan === item.id}
              disabled={busy}
              onClick={() => setPlan(item.id)}
              key={item.id}
            >
              <span className="membership-plan-top"><strong>{item.name}</strong><b>${item.price} <small>/ month</small></b></span>
            </button>
          ))}
        </div>
        <div className="membership-selected-benefits"><strong>{selectedPlan.name}</strong><p>{selectedPlan.description}</p><ul>{selectedPlan.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}</ul></div>
        <button className="primary membership-pay" disabled={busy} onClick={() => void run(async () => {
          try {
            if (provider === "lava") {
              await startLavaMembership(plan);
              setMessage("Complete payment in your browser, then return here and choose Check now.");
            } else {
              await openPatreonCheckout();
              setMessage(`Choose ${selectedPlan.name} on Patreon and review its final price. After subscribing, return here and choose Link Patreon membership.`);
            }
          } catch (error) {
            setMessage(errorMessage(error, "Could not open membership checkout"));
          }
        }, provider === "patreon")}>{busy ? "Please wait…" : provider === "lava" ? `Continue with LAVA · $${selectedPlan.price}` : "Continue with Patreon"}</button>
        {provider === "patreon" && <p className="support-tier-note">Patreon confirms the final price and tier at checkout. Already subscribed or received a gift? Link your membership below; no new payment is needed.</p>}
        {details && (
          <div className="support-membership-status">
            Plan: {subscriptionLabels[details.tier]} · Source: {(details.provider || "lava").toUpperCase()} · Status: {details.status === "gifted" ? "Gifted" : details.status === "active" || details.status === "owner" ? "Active" : details.status}
          </div>
        )}
        {patreonBusy && <button className="control" onClick={() => void cancelPatreonConnection().catch(() => undefined)}>Close Patreon connection</button>}
        {message && <div className="support-membership-status" role="status">{message}</div>}
        <details className="membership-existing">
        <summary>Already have an activation code?</summary>
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
        </details>
        <div className="support-actions">
          <button className="control" disabled={busy} onClick={() => void run(async () => {
            try {
              const result = await syncLavaMembership(true);
              setDetails(result);
              setMessage(activeMessage(result));
            } catch (error) {
              setMessage(errorMessage(error, "Could not verify membership"));
            }
          })}>Check now</button>
          <button className="control" disabled={busy} onClick={() => void run(async () => {
            try {
              const result = await startPatreonMembership();
              if (result) {
                setDetails(result);
                setMessage(activeMessage(result));
              } else {
                setMessage("Finish linking in Patreon, then return here and choose Check now.");
              }
            } catch (error) {
              setMessage(errorMessage(error, "Could not link Patreon membership"));
            }
          }, true)}>Link Patreon membership</button>
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

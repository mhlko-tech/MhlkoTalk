import { subscriptionLabels, type SubscriptionTier } from "../core/subscription";

export function MembershipBadge({ tier }: { tier?: SubscriptionTier }) {
  if (!tier || tier === "free") return null;
  return <small className={`member-tier-badge ${tier}`} aria-label={`${subscriptionLabels[tier]} member`}>{subscriptionLabels[tier]}</small>;
}

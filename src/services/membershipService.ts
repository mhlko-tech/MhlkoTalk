import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { serviceBaseUrl } from "../config/serviceConfig";
import { accountSession } from "./accountSession";

const membershipTokenKey = "mhtalk.membership.lava-token";
const lastSyncKey = "mhtalk.membership.last-sync";
const runningInTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

type MembershipSync = {
  status: string;
  tier: "free" | "plus";
  pending?: boolean;
  expiresAt?: string | null;
};

async function loadToken() {
  if (!runningInTauri()) return localStorage.getItem(membershipTokenKey);
  return invoke<string | null>("auth_secret_get", { key: membershipTokenKey });
}

async function saveToken(value: string) {
  if (!runningInTauri()) localStorage.setItem(membershipTokenKey, value);
  else await invoke("auth_secret_set", { key: membershipTokenKey, value });
}

export async function startLavaMembership(planId = "plus") {
  const accountToken = accountSession.getAccessToken();
  if (!accountToken || !serviceBaseUrl) throw new Error("Sign in before starting a membership");
  const response = await fetch(new URL("/subscription/lava/start", serviceBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accountToken}` },
    body: JSON.stringify({ planId }),
  });
  const payload = await response.json() as { subscriptionUrl?: string; desktopToken?: string; error?: string };
  if (!response.ok || !payload.subscriptionUrl || !payload.desktopToken) {
    throw new Error(payload.error || "LAVA membership is temporarily unavailable");
  }
  await saveToken(payload.desktopToken);
  localStorage.removeItem(lastSyncKey);
  await openUrl(payload.subscriptionUrl);
}

export async function syncLavaMembership(force = false): Promise<MembershipSync | null> {
  const token = await loadToken();
  const accountToken = accountSession.getAccessToken();
  if (!token || !accountToken || !serviceBaseUrl) return null;
  const lastSync = Number(localStorage.getItem(lastSyncKey) || 0);
  if (!force && Date.now() - lastSync < 5 * 60_000) return null;
  const response = await fetch(new URL("/subscription/lava/sync", serviceBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accountToken}`,
    },
    body: JSON.stringify({ membershipToken: token }),
  });
  const payload = await response.json().catch(() => ({})) as MembershipSync & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Could not verify the LAVA membership");
  localStorage.setItem(lastSyncKey, String(Date.now()));
  if (!payload.pending) await accountSession.refreshAccount();
  return payload;
}

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  serviceBaseUrl,
  supabasePublishableKey,
  supabaseUrl,
} from "../config/serviceConfig";
import { isTerminalSessionFailure, sessionRetryDelay } from "./sessionResilience";
import {
  resolveSubscriptionPlan,
  type SubscriptionPlan,
} from "../core/subscription";

export type MHTalkAccount = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  usernameVisible: boolean;
  usernameChangedAt?: string;
  subscription: SubscriptionPlan;
};
export type FriendProfile = MHTalkAccount & { online: boolean; friendSince?: string };
export type FriendRequest = MHTalkAccount & { requestId: string; createdAt: string };
export type SearchProfile = MHTalkAccount & { isFriend: boolean };
export type RoomInvite = {
  id: string;
  senderId: string;
  targetId: string;
  roomName: string;
  inviteCode?: string;
  createdAt: string;
};
export type AccountState =
  | { status: "unavailable" }
  | { status: "checking" }
  | { status: "signed-out" }
  | { status: "authenticating" }
  | { status: "awaiting-oauth" }
  | { status: "awaiting-verification"; email: string }
  | { status: "account-exists"; email: string; googleLinked: boolean; passwordEnabled: boolean; message: string }
  | { status: "onboarding"; email: string; username: string; displayName: string; avatarUrl?: string; creationVerified: boolean }
  | { status: "password-recovery" }
  | { status: "signed-in"; account: MHTalkAccount }
  | { status: "failed"; message: string };
export type SocialState = {
  friends: FriendProfile[];
  requests: FriendRequest[];
  incomingInvite: RoomInvite | null;
  loading: boolean;
  error: string;
};

type ApiProfile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
  username_visible?: boolean;
  username_changed_at?: string | null;
  subscription_tier?: "free" | "plus";
  subscription_expires_at?: string | null;
  friend_since?: string;
  request_id?: string;
  created_at?: string;
};
type ApiOnboarding = {
  required: boolean;
  email: string;
  googleLinked: boolean;
  passwordEnabled: boolean;
  creationVerified: boolean;
  profile: ApiProfile;
};

const initialSocial: SocialState = { friends: [], requests: [], incomingInvite: null, loading: false, error: "" };
const apiEndpoint = serviceBaseUrl;
const runningInTauri = () => Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
const secureStorage = {
  async getItem(key: string) {
    if (!runningInTauri()) return localStorage.getItem(key);
    return invoke<string | null>("auth_secret_get", { key });
  },
  async setItem(key: string, value: string) {
    if (!runningInTauri()) localStorage.setItem(key, value);
    else await invoke("auth_secret_set", { key, value });
  },
  async removeItem(key: string) {
    if (!runningInTauri()) localStorage.removeItem(key);
    else await invoke("auth_secret_delete", { key });
  },
};

class AccountSession {
  private readonly client: SupabaseClient | null = supabaseUrl && supabasePublishableKey
      ? createClient(supabaseUrl, supabasePublishableKey, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: secureStorage },
      })
    : null;
  private session: Session | null = null;
  private state: AccountState = this.client && apiEndpoint ? { status: "checking" } : { status: "unavailable" };
  private social: SocialState = initialSocial;
  private listeners = new Set<(state: AccountState) => void>();
  private socialListeners = new Set<(state: SocialState) => void>();
  private presence: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private hydrationRetryTimer: number | undefined;
  private authRecoveryTimer: number | undefined;
  private oauthTimer: number | undefined;
  private initialized = false;
  private handlingPasswordRecovery = false;
  private intentionalSignOut = false;
  private recoveringUnexpectedSignOut = false;
  private lastAuthenticatedSession: Session | null = null;
  private hydrationRetryAttempt = 0;
  private hydrationRevision = 0;
  private processedAuthCallbacks = new Set<string>();

  subscribe(listener: (state: AccountState) => void) {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  subscribeSocial(listener: (state: SocialState) => void) {
    this.socialListeners.add(listener); listener(this.social);
    return () => { this.socialListeners.delete(listener); };
  }
  getState() { return this.state; }
  getSocialState() { return this.social; }
  getAccessToken() { return this.session?.access_token || null; }
  async refreshAccount() {
    if (this.session) await this.applySession(this.session);
  }

  async initialize() {
    if (this.initialized || !this.client) return;
    this.initialized = true;
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || this.handlingPasswordRecovery) {
        this.session = session;
        if (session) this.lastAuthenticatedSession = session;
        if (session) this.setState({ status: "password-recovery" });
        return;
      }
      if (event === "TOKEN_REFRESHED" && session) {
        if (this.intentionalSignOut) return;
        this.session = session;
        this.lastAuthenticatedSession = session;
        this.finishSessionRecovery();
        return;
      }
      if (event === "SIGNED_OUT" && this.lastAuthenticatedSession && this.state.status === "signed-in") {
        if (!this.recoveringUnexpectedSignOut) {
          const recoverableSession = this.lastAuthenticatedSession;
          this.recoveringUnexpectedSignOut = true;
          window.setTimeout(() => void this.recoverUnexpectedSignOut(recoverableSession), 0);
        }
        return;
      }
      if (session) this.lastAuthenticatedSession = session;
      window.setTimeout(() => void this.applySession(session), 0);
    });
    await this.retry();
    try {
      (await getCurrent())?.forEach((url) => void this.handleDeepLink(url));
      await onOpenUrl((urls) => urls.forEach((url) => void this.handleDeepLink(url)));
    } catch {
      // Browser preview has no registered desktop deep-link handler.
    }
  }

  async retry() {
    if (!this.client || !apiEndpoint) {
      this.setState({ status: "unavailable" });
      return;
    }
    this.setState({ status: "checking" });
    const { data, error } = await this.client.auth.getSession();
    if (error) {
      this.setState({ status: "failed", message: error.message });
      return;
    }
    await this.applySession(data.session);
  }

  async login(identifier: string, password: string) {
    if (!this.client || !apiEndpoint) throw new Error("Account service is unavailable");
    this.setState({ status: "authenticating" });
    try {
      const response = await fetch(new URL("/auth/login", apiEndpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      });
      const value = (await response.json().catch(() => null)) as {
        access_token?: string; refresh_token?: string; error?: string;
      } | null;
      if (!response.ok || !value?.access_token || !value.refresh_token)
        throw new Error(value?.error || "Username/email or password is incorrect");
      const { data, error } = await this.client.auth.setSession({
        access_token: value.access_token,
        refresh_token: value.refresh_token,
      });
      if (error || !data.session) throw error || new Error("Sign-in failed");
      await this.applySession(data.session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-in failed";
      this.setState({ status: "failed", message });
      throw new Error(message);
    }
  }

  async usernameAvailable(username: string) {
    if (!apiEndpoint) return false;
    const endpoint = new URL("/auth/username-available", apiEndpoint);
    endpoint.searchParams.set("username", username.trim());
    const response = await fetch(endpoint);
    const value = (await response.json().catch(() => null)) as { available?: boolean; error?: string } | null;
    if (!response.ok) throw new Error(value?.error || "Could not check username");
    return value?.available === true;
  }

  async register(username: string, displayName: string, email: string, password: string) {
    if (!apiEndpoint) throw new Error("Account service is unavailable");
    this.setState({ status: "authenticating" });
    try {
      const response = await fetch(new URL("/auth/register", apiEndpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), displayName: displayName.trim(), email: email.trim(), password }),
      });
      const value = (await response.json().catch(() => null)) as {
        error?: string; code?: string; email?: string; googleLinked?: boolean; passwordEnabled?: boolean;
      } | null;
      if (!response.ok && value?.code === "ACCOUNT_EXISTS") {
        this.setState({
          status: "account-exists", email: value.email || email.trim(), googleLinked: value.googleLinked === true,
          passwordEnabled: value.passwordEnabled === true, message: value.error || "This email is already used by an MHTalk account.",
        });
        return;
      }
      if (!response.ok) throw new Error(value?.error || "Could not create account");
      this.setState({ status: "awaiting-verification", email: email.trim() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create account";
      this.setState({ status: "failed", message });
      throw new Error(message);
    }
  }

  async requestPasswordReset(identifier: string) {
    if (!apiEndpoint) throw new Error("Account service is unavailable");
    const response = await fetch(new URL("/auth/forgot-password", apiEndpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: identifier.trim() }),
    });
    const value = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new Error(value?.error || "Could not request password reset");
  }

  async resendVerification(email: string) {
    if (!this.client) throw new Error("Account service is unavailable");
    const { error } = await this.client.auth.resend({
      type: "signup", email: email.trim(), options: { emailRedirectTo: "mhtalk://auth/callback" },
    });
    if (error) throw error;
  }

  async verifyEmailCode(email: string, token: string, displayName?: string, avatar?: string) {
    if (!this.client) throw new Error("Account service is unavailable");
    const { data, error } = await this.client.auth.verifyOtp({
      email: email.trim(), token: token.trim(), type: "signup",
    });
    if (error || !data.session) throw error || new Error("The verification code is invalid or expired");
    await this.applySession(data.session);
    if (avatar?.startsWith("data:image/") && this.state.status === "signed-in")
      await this.updateProfile(displayName || this.state.account.displayName, "", avatar);
  }

  async verifyPasswordRecoveryCode(email: string, token: string) {
    if (!this.client || !apiEndpoint) throw new Error("Account service is unavailable");
    this.handlingPasswordRecovery = true;
    const response = await fetch(new URL("/auth/verify-recovery", apiEndpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: email.trim(), code: token.trim() }),
    });
    const value = (await response.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
    } | null;
    if (!response.ok || !value?.access_token || !value.refresh_token) {
      this.handlingPasswordRecovery = false;
      throw new Error(value?.error || "The recovery code is invalid or expired");
    }
    const { data, error } = await this.client.auth.setSession({
      access_token: value.access_token,
      refresh_token: value.refresh_token,
    });
    if (error || !data.session) {
      this.handlingPasswordRecovery = false;
      throw error || new Error("The recovery code is invalid or expired");
    }
    this.session = data.session;
    this.setState({ status: "password-recovery" });
  }

  clearAuthError() {
    if (this.state.status === "failed") this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
  }

  dismissAccountNotice() {
    if (this.state.status === "account-exists") this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
  }

  async startGoogleOnboarding() {
    await this.api("/auth/onboarding/start", { method: "POST", body: "{}" });
  }

  async completeGoogleOnboarding(username: string, displayName: string, avatar: string | undefined, token: string) {
    if (!this.client || this.state.status !== "onboarding") throw new Error("Google onboarding is unavailable");
    const email = this.state.email;
    const { data, error } = await this.client.auth.verifyOtp({ email, token: token.trim(), type: "email" });
    if (error || !data.session) throw error || new Error("The account creation code is invalid or expired");
    this.session = data.session;
    await this.api("/auth/onboarding/complete", {
      method: "POST",
      body: JSON.stringify({ username: username.trim(), displayName: displayName.trim(), avatarUrl: avatar?.startsWith("data:") ? null : avatar || null }),
    });
    await this.applySession(data.session);
    const completedState = this.getState();
    if (avatar?.startsWith("data:image/") && completedState.status === "signed-in")
      await this.updateProfile(displayName, "", avatar);
  }

  async completePasswordRecovery(password: string) {
    if (!this.client || !this.session) throw new Error("The recovery link is invalid or expired");
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw error;
    await this.api("/auth/password-enabled", { method: "POST", body: "{}" });
    this.handlingPasswordRecovery = false;
    await this.applySession(this.session);
  }

  async cancelPasswordRecovery() {
    this.handlingPasswordRecovery = false;
    await this.signOut();
  }

  async signIn(provider: "google" | "facebook") {
    if (!this.client) throw new Error("Supabase sign-in is not configured");
    this.setState({ status: "authenticating" });
    const redirectTo = apiEndpoint
      ? new URL("/auth/complete", apiEndpoint).toString()
      : "mhtalk://auth/callback";
    const { data, error } = await this.client.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      const message = error?.message || "Could not open sign-in";
      this.setState({ status: "failed", message });
      throw new Error(message);
    }
    try {
      this.setState({ status: "awaiting-oauth" });
      window.clearTimeout(this.oauthTimer);
      this.oauthTimer = window.setTimeout(() => {
        if (this.state.status === "awaiting-oauth") {
          this.setState({ status: "failed", message: "Google sign-in timed out. Try again and finish the steps in your browser." });
        }
      }, 5 * 60 * 1000);
      if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) await openUrl(data.url);
      else window.location.assign(data.url);
    } catch (cause) {
      window.clearTimeout(this.oauthTimer);
      const message = cause instanceof Error ? cause.message : "Could not open Google sign-in";
      this.setState({ status: "failed", message });
      throw new Error(message);
    }
  }

  cancelOAuthSignIn() {
    window.clearTimeout(this.oauthTimer);
    this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
  }

  async signOut() {
    this.intentionalSignOut = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.hydrationRetryTimer);
    window.clearTimeout(this.authRecoveryTimer);
    window.clearTimeout(this.oauthTimer);
    this.presence?.close(); this.presence = null;
    this.lastAuthenticatedSession = null;
    this.recoveringUnexpectedSignOut = false;
    this.hydrationRetryAttempt = 0;
    try {
      await this.client?.auth.signOut();
    } finally {
      this.session = null;
      this.setSocial(initialSocial);
      this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
      this.intentionalSignOut = false;
    }
  }

  async refreshSocial() {
    if (!this.session) return;
    this.setSocial({ ...this.social, loading: true, error: "" });
    try {
      const [friends, requests] = await Promise.all([
        this.api<ApiProfile[]>("/social/friends"),
        this.api<ApiProfile[]>("/social/requests"),
      ]);
      const online = new Set(this.social.friends.filter((friend) => friend.online).map((friend) => friend.id));
      this.setSocial({
        ...this.social,
        loading: false,
        friends: friends.map((item) => ({ ...this.mapProfile(item), online: online.has(item.id), friendSince: item.friend_since })),
        requests: requests.map((item) => ({ ...this.mapProfile(item), requestId: item.request_id!, createdAt: item.created_at! })),
        error: "",
      });
      void this.connectPresence().catch(() => this.schedulePresenceReconnect());
    } catch (error) {
      this.setSocial({ ...this.social, loading: false, error: error instanceof Error ? error.message : "Could not load friends" });
    }
  }

  async searchProfiles(query: string) {
    const items = await this.api<(ApiProfile & { is_friend?: boolean })[]>(`/social/search?q=${encodeURIComponent(query)}`);
    return items.map((item) => ({ ...this.mapProfile(item), isFriend: item.is_friend === true })) as SearchProfile[];
  }
  async sendFriendRequest(targetId: string) {
    await this.api("/social/friend-request", { method: "POST", body: JSON.stringify({ targetId }) });
  }
  async respondFriendRequest(requestId: string, accept: boolean) {
    await this.api("/social/friend-response", { method: "POST", body: JSON.stringify({ requestId, accept }) });
    await this.refreshSocial();
  }
  async removeFriend(friendId: string) {
    await this.api("/social/friend-remove", { method: "POST", body: JSON.stringify({ friendId }) });
    await this.refreshSocial();
  }
  async updateProfile(displayName: string, bio: string, avatar?: string, usernameVisible?: boolean) {
    if (!this.client || !this.session || this.state.status !== "signed-in") throw new Error("Sign in is required");
    let avatarUrl: string | undefined;
    if (avatar?.startsWith("data:image/")) {
      const blob = await (await fetch(avatar)).blob();
      if (blob.size > 5 * 1024 * 1024) throw new Error("Profile image must be 5 MB or smaller");
      if (blob.type === "image/gif" && !this.state.account.subscription.entitlements.animatedProfile)
        throw new Error("Animated profile images are included with MHTalk Plus");
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : blob.type === "image/gif" ? "gif" : "jpg";
      const path = `${this.state.account.id}/avatar.${extension}`;
      const { error } = await this.client.storage.from("profile-avatars").upload(path, blob, { upsert: true, contentType: blob.type });
      if (error) throw error;
      avatarUrl = `${this.client.storage.from("profile-avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
    } else if (avatar !== undefined) avatarUrl = avatar;
    await this.api("/social/profile", {
      method: "PATCH",
      body: JSON.stringify({
        display_name: displayName,
        bio,
        ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {}),
        ...(usernameVisible !== undefined ? { username_visible: usernameVisible } : {}),
      }),
    });
    await this.applySession(this.session);
  }
  async changeUsername(username: string) {
    if (!this.session || this.state.status !== "signed-in") throw new Error("Sign in is required");
    await this.api("/social/profile", {
      method: "PATCH",
      body: JSON.stringify({ username: username.trim() }),
    });
    await this.applySession(this.session);
  }
  async inviteFriend(targetId: string, privateRoom = true, roomName = "Main") {
    return this.api<RoomInvite>("/social/invite", { method: "POST", body: JSON.stringify({ targetId, private: privateRoom, roomName }) });
  }
  clearInvite() { this.setSocial({ ...this.social, incomingInvite: null }); }

  private async handleDeepLink(value: string) {
    try {
      const url = new URL(value);
      if (url.hostname === "auth" && (url.pathname === "/callback" || url.pathname === "/reset")) {
        window.clearTimeout(this.oauthTimer);
        const recovery = url.pathname === "/reset";
        this.handlingPasswordRecovery = recovery;
        const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        const accessToken = fragment.get("access_token");
        const refreshToken = fragment.get("refresh_token");
        const code = url.searchParams.get("code");
        const callbackKey = `${url.pathname}:${code || accessToken || url.search}`;
        if (this.processedAuthCallbacks.has(callbackKey)) return;
        this.processedAuthCallbacks.add(callbackKey);
        if (this.processedAuthCallbacks.size > 12) {
          const oldest = this.processedAuthCallbacks.values().next().value;
          if (oldest) this.processedAuthCallbacks.delete(oldest);
        }
        if (!this.client) return;
        const result = accessToken && refreshToken
          ? await this.client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          : code
            ? await this.client.auth.exchangeCodeForSession(code)
            : { data: { session: null }, error: new Error(url.searchParams.get("error_description") || "The sign-in link is invalid or expired") };
        if (result.error || !result.data.session) {
          this.handlingPasswordRecovery = false;
          this.setState({ status: "failed", message: result.error?.message || "The sign-in link is invalid or expired" });
        } else if (recovery) {
          this.session = result.data.session;
          this.setState({ status: "password-recovery" });
        } else {
          this.handlingPasswordRecovery = false;
          await this.applySession(result.data.session);
        }
        return;
      }
      if (url.hostname === "invite" && url.pathname.length > 1 && this.session) {
        try {
          const invite = await this.api<RoomInvite>(`/social/invite/${encodeURIComponent(url.pathname.slice(1))}`);
          this.setSocial({ ...this.social, incomingInvite: invite });
        } catch { /* Expired invitations are intentionally ignored. */ }
      }
    } catch (error) {
      if (value.startsWith("mhtalk://auth/")) {
        this.handlingPasswordRecovery = false;
        window.clearTimeout(this.oauthTimer);
        this.setState({
          status: "failed",
          message: error instanceof Error ? error.message : "Could not securely save the sign-in session",
        });
      }
    }
  }

  private async applySession(session: Session | null) {
    const revision = ++this.hydrationRevision;
    const stableState = this.state.status === "signed-in" ? this.state : null;
    if (session) window.clearTimeout(this.oauthTimer);
    this.session = session;
    if (!session) {
      window.clearTimeout(this.hydrationRetryTimer);
      this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
      return;
    }
    try {
      const onboarding = await this.apiWithSession<ApiOnboarding>(session, "/auth/onboarding");
      if (revision !== this.hydrationRevision) return;
      if (onboarding.required) {
        this.setState({
          status: "onboarding", email: onboarding.email, username: onboarding.profile.username,
          displayName: onboarding.profile.display_name, avatarUrl: onboarding.profile.avatar_url || undefined,
          creationVerified: onboarding.creationVerified,
        });
        return;
      }
      const profile = await this.apiWithSession<ApiProfile>(session, "/social/me");
      if (revision !== this.hydrationRevision) return;
      this.lastAuthenticatedSession = session;
      window.clearTimeout(this.hydrationRetryTimer);
      this.hydrationRetryAttempt = 0;
      this.setState({ status: "signed-in", account: this.mapProfile(profile) });
      await this.refreshSocial();
    } catch (error) {
      if (revision !== this.hydrationRevision) return;
      if (stableState && this.session) {
        this.setState(stableState);
        this.setSocial({
          ...this.social,
          loading: false,
          error: "Connection interrupted. MHTalk will reconnect automatically.",
        });
        window.clearTimeout(this.hydrationRetryTimer);
        this.hydrationRetryTimer = window.setTimeout(
          () => { if (this.session) void this.applySession(this.session); },
          sessionRetryDelay(this.hydrationRetryAttempt++),
        );
        return;
      }
      this.setState({ status: "failed", message: error instanceof Error ? error.message : "Profile could not be loaded" });
    }
  }

  private async recoverUnexpectedSignOut(previousSession: Session, attempt = 0) {
    if (!this.client || this.lastAuthenticatedSession !== previousSession) {
      this.recoveringUnexpectedSignOut = false;
      return;
    }
    const { data, error } = await this.client.auth.refreshSession({ refresh_token: previousSession.refresh_token });
    if (data.session) {
      this.session = data.session;
      this.lastAuthenticatedSession = data.session;
      this.finishSessionRecovery();
      return;
    }
    if (isTerminalSessionFailure(error) || !error) {
      console.warn("[auth] Supabase rejected the stored session; interactive sign-in is required.");
      window.clearTimeout(this.hydrationRetryTimer);
      window.clearTimeout(this.authRecoveryTimer);
      this.session = null;
      this.lastAuthenticatedSession = null;
      this.recoveringUnexpectedSignOut = false;
      this.setSocial(initialSocial);
      this.setState({ status: "signed-out" });
      return;
    }
    console.warn(`[auth] Session refresh was interrupted; retrying in ${sessionRetryDelay(attempt)}ms.`);
    this.session = previousSession;
    this.recoveringUnexpectedSignOut = false;
    this.setSocial({
      ...this.social,
      loading: false,
      error: "Connection interrupted. Your session is being restored.",
    });
    window.clearTimeout(this.authRecoveryTimer);
    this.authRecoveryTimer = window.setTimeout(() => {
      if (!this.lastAuthenticatedSession || this.state.status !== "signed-in") return;
      this.recoveringUnexpectedSignOut = true;
      void this.recoverUnexpectedSignOut(this.lastAuthenticatedSession, attempt + 1);
    }, sessionRetryDelay(attempt));
  }

  private finishSessionRecovery() {
    window.clearTimeout(this.authRecoveryTimer);
    this.recoveringUnexpectedSignOut = false;
    if (this.social.error.startsWith("Connection interrupted.")) this.setSocial({ ...this.social, error: "" });
  }

  private async connectPresence() {
    if (
      !this.session ||
      !apiEndpoint ||
      this.presence?.readyState === WebSocket.OPEN ||
      this.presence?.readyState === WebSocket.CONNECTING
    ) {
      this.watchFriends(); return;
    }
    window.clearTimeout(this.reconnectTimer);
    this.presence?.close();
    const { ticket } = await this.api<{ ticket: string }>("/presence/ticket", { method: "POST" });
    const endpoint = new URL("/presence", apiEndpoint);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    endpoint.searchParams.set("ticket", ticket);
    const socket = new WebSocket(endpoint);
    this.presence = socket;
    socket.addEventListener("open", () => this.watchFriends());
    socket.addEventListener("message", (event) => this.handlePresenceMessage(String(event.data)));
    socket.addEventListener("close", () => {
      if (this.presence === socket) this.presence = null;
      this.schedulePresenceReconnect();
    });
  }
  private schedulePresenceReconnect() {
    window.clearTimeout(this.reconnectTimer);
    if (!this.session) return;
    this.reconnectTimer = window.setTimeout(() => {
      void this.connectPresence().catch(() => this.schedulePresenceReconnect());
    }, 3000);
  }
  private watchFriends() {
    if (this.presence?.readyState === WebSocket.OPEN)
      this.presence.send(JSON.stringify({ type: "watch", friendIds: this.social.friends.map((friend) => friend.id) }));
  }
  private handlePresenceMessage(raw: string) {
    try {
      const event = JSON.parse(raw) as { type: string; userId?: string; online?: boolean | string[]; invite?: RoomInvite };
      if (event.type === "invite" && event.invite) {
        this.setSocial({ ...this.social, incomingInvite: event.invite }); return;
      }
      if (event.type === "friend_request") {
        void this.refreshSocial();
        return;
      }
      const online = event.type === "presence_snapshot" && Array.isArray(event.online)
        ? new Set(event.online)
        : null;
      this.setSocial({ ...this.social, friends: this.social.friends.map((friend) => ({
        ...friend,
        online: online ? online.has(friend.id) : event.type === "presence" && event.userId === friend.id ? event.online === true : friend.online,
      })) });
    } catch { /* Ignore malformed presence events. */ }
  }
  private mapProfile(profile: ApiProfile): MHTalkAccount {
    return {
      id: profile.id,
      username: profile.username,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url || undefined,
      bio: profile.bio || undefined,
      usernameVisible: profile.username_visible !== false,
      usernameChangedAt: profile.username_changed_at || undefined,
      subscription: resolveSubscriptionPlan({
        tier: profile.subscription_tier,
        expiresAt: profile.subscription_expires_at,
      }),
    };
  }
  private async api<T = unknown>(path: string, init: RequestInit = {}) {
    if (!apiEndpoint || !this.client) throw new Error("Account service is unavailable");
    let session = this.session;
    if (!session) {
      const current = await this.client.auth.getSession();
      session = current.data.session;
      this.session = session;
    }
    if (!session) throw new Error("Your session expired. Please sign in again.");
    return this.apiWithSession<T>(session, path, init);
  }

  private async apiWithSession<T = unknown>(session: Session, path: string, init: RequestInit = {}) {
    if (!apiEndpoint) throw new Error("Account service is unavailable");
    const send = async (activeSession: Session) => {
      const requestHeaders = new Headers(init.headers);
      requestHeaders.set("authorization", `Bearer ${activeSession.access_token}`);
      if (!requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
      const useNativeSocialTransport = isTauri() &&
        (path.startsWith("/social/") || path === "/presence/ticket");
      if (useNativeSocialTransport) {
        if (init.body !== undefined && typeof init.body !== "string") {
          throw new Error("The desktop account request format is unsupported");
        }
        const native = await invoke<{ status: number; body: string }>("fetch_service_api", {
          path,
          method: init.method || "GET",
          body: typeof init.body === "string" ? init.body : null,
          accessToken: activeSession.access_token,
        });
        return new Response(native.body, {
          status: native.status,
          headers: { "content-type": "application/json" },
        });
      }
      return fetch(new URL(path, apiEndpoint), {
        ...init,
        headers: requestHeaders,
      });
    };
    const method = (init.method || "GET").toUpperCase();
    const retryable = method === "GET" || path === "/presence/ticket";
    const sendWithRetry = async (activeSession: Session) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < (retryable ? 3 : 1); attempt += 1) {
        if (attempt > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, attempt * 350));
        try {
          const response = await send(activeSession);
          if (!retryable || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
            return response;
          }
        } catch (error) {
          lastError = error;
          if (!retryable || attempt === 2) break;
        }
      }
      throw new Error(
        lastError instanceof Error && !/^Failed to fetch$/i.test(lastError.message)
          ? lastError.message
          : "MHTalk service could not be reached. Please try again.",
      );
    };
    let response = await sendWithRetry(session);
    if (response.status === 401 && this.client) {
      // Let Supabase refresh its current persisted session under its own lock.
      // Passing the request's older refresh token here can race token rotation.
      const refreshed = await this.client.auth.refreshSession();
      if (refreshed.data.session) {
        session = refreshed.data.session;
        this.session = session;
        response = await sendWithRetry(session);
      }
    }
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
      throw new Error(value?.error || value?.message || "Social service request failed");
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  private setState(state: AccountState) { this.state = state; this.listeners.forEach((listener) => listener(state)); }
  private setSocial(state: SocialState) { this.social = state; this.socialListeners.forEach((listener) => listener(state)); }
}

export const accountSession = new AccountSession();

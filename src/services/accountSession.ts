import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";

export type MHTalkAccount = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
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
  | { status: "awaiting-verification"; email: string }
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
  friend_since?: string;
  request_id?: string;
  created_at?: string;
};

const initialSocial: SocialState = { friends: [], requests: [], incomingInvite: null, loading: false, error: "" };
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://fcadjrqrrzcvbyqrgnnm.supabase.co";
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_3Azp3R7eFE8YI81Eg_Bekw_D353_Efc";
const apiEndpoint = import.meta.env.VITE_SOCIAL_API_ENDPOINT || import.meta.env.VITE_LIVEKIT_TOKEN_ENDPOINT;
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
  private readonly client: SupabaseClient | null = supabaseUrl && supabaseKey
      ? createClient(supabaseUrl, supabaseKey, {
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
  private initialized = false;
  private handlingPasswordRecovery = false;

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

  async initialize() {
    if (this.initialized || !this.client) return;
    this.initialized = true;
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || this.handlingPasswordRecovery) {
        this.session = session;
        if (session) this.setState({ status: "password-recovery" });
        return;
      }
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
      const value = (await response.json().catch(() => null)) as { error?: string } | null;
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

  async completePasswordRecovery(password: string) {
    if (!this.client || !this.session) throw new Error("The recovery link is invalid or expired");
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw error;
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
    const { data, error } = await this.client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: "mhtalk://auth/callback", skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      const message = error?.message || "Could not open sign-in";
      this.setState({ status: "failed", message });
      throw new Error(message);
    }
    if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) await openUrl(data.url);
    else window.location.assign(data.url);
  }

  async signOut() {
    window.clearTimeout(this.reconnectTimer);
    this.presence?.close(); this.presence = null;
    await this.client?.auth.signOut();
    this.session = null;
    this.setSocial(initialSocial);
    this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
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
      await this.connectPresence();
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
  async updateProfile(displayName: string, bio: string, avatar?: string) {
    if (!this.client || !this.session || this.state.status !== "signed-in") throw new Error("Sign in is required");
    let avatarUrl: string | undefined;
    if (avatar?.startsWith("data:image/")) {
      const blob = await (await fetch(avatar)).blob();
      if (blob.size > 5 * 1024 * 1024) throw new Error("Profile image must be 5 MB or smaller");
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : blob.type === "image/gif" ? "gif" : "jpg";
      const path = `${this.state.account.id}/avatar.${extension}`;
      const { error } = await this.client.storage.from("profile-avatars").upload(path, blob, { upsert: true, contentType: blob.type });
      if (error) throw error;
      avatarUrl = `${this.client.storage.from("profile-avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
    } else if (avatar !== undefined) avatarUrl = avatar;
    await this.api("/social/profile", {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName, bio, ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {}) }),
    });
    await this.applySession(this.session);
  }
  async inviteFriend(targetId: string, privateRoom = true, roomName = "Main") {
    return this.api<RoomInvite>("/social/invite", { method: "POST", body: JSON.stringify({ targetId, private: privateRoom, roomName }) });
  }
  clearInvite() { this.setSocial({ ...this.social, incomingInvite: null }); }

  private async handleDeepLink(value: string) {
    const url = new URL(value);
    if (url.hostname === "auth" && (url.pathname === "/callback" || url.pathname === "/reset")) {
      const recovery = url.pathname === "/reset";
      this.handlingPasswordRecovery = recovery;
      const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
      const accessToken = fragment.get("access_token");
      const refreshToken = fragment.get("refresh_token");
      const code = url.searchParams.get("code");
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
  }

  private async applySession(session: Session | null) {
    this.session = session;
    if (!session) {
      this.setState(this.client ? { status: "signed-out" } : { status: "unavailable" });
      return;
    }
    try {
      const profile = await this.api<ApiProfile>("/social/me");
      this.setState({ status: "signed-in", account: this.mapProfile(profile) });
      await this.refreshSocial();
    } catch (error) {
      this.setState({ status: "failed", message: error instanceof Error ? error.message : "Profile could not be loaded" });
    }
  }

  private async connectPresence() {
    if (!this.session || !apiEndpoint || this.presence?.readyState === WebSocket.OPEN) {
      this.watchFriends(); return;
    }
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
      if (this.session) this.reconnectTimer = window.setTimeout(() => void this.connectPresence(), 3000);
    });
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
    return { id: profile.id, username: profile.username, displayName: profile.display_name,
      avatarUrl: profile.avatar_url || undefined, bio: profile.bio || undefined };
  }
  private async api<T = unknown>(path: string, init: RequestInit = {}) {
    if (!apiEndpoint || !this.session) throw new Error("Sign in is required");
    const response = await fetch(new URL(path, apiEndpoint), {
      ...init,
      headers: { authorization: `Bearer ${this.session.access_token}`, "content-type": "application/json", ...(init.headers || {}) },
    });
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

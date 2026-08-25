import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";

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
  | { status: "signed-out" }
  | { status: "authenticating" }
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

class AccountSession {
  private readonly client: SupabaseClient | null = supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;
  private session: Session | null = null;
  private state: AccountState = this.client && apiEndpoint ? { status: "signed-out" } : { status: "unavailable" };
  private social: SocialState = initialSocial;
  private listeners = new Set<(state: AccountState) => void>();
  private socialListeners = new Set<(state: SocialState) => void>();
  private presence: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private initialized = false;

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
    this.client.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => void this.applySession(session), 0);
    });
    const { data } = await this.client.auth.getSession();
    await this.applySession(data.session);
    try {
      (await getCurrent())?.forEach((url) => void this.handleDeepLink(url));
      await onOpenUrl((urls) => urls.forEach((url) => void this.handleDeepLink(url)));
    } catch {
      // Browser preview has no registered desktop deep-link handler.
    }
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
    if (url.hostname === "auth" && url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code || !this.client) return;
      const { data, error } = await this.client.auth.exchangeCodeForSession(code);
      if (error) this.setState({ status: "failed", message: error.message });
      else await this.applySession(data.session);
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

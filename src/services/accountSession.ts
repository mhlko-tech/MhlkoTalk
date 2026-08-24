export type MHTalkAccount = {
  id: string;
  displayName: string;
  avatarUrl?: string;
};

export type AccountState =
  | { status: "unavailable" }
  | { status: "signed-out" }
  | { status: "authenticating" }
  | { status: "signed-in"; account: MHTalkAccount }
  | { status: "failed"; message: string };

type ExchangeResponse = {
  accessToken?: string;
  expiresIn?: number;
  account?: MHTalkAccount;
};

/**
 * Authentication boundary for the future Mangatak identity service.
 * Tokens deliberately remain in memory until an audited secure-store backend exists.
 */
class AccountSession {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private state: AccountState = import.meta.env.VITE_MANGATAK_AUTH_ENDPOINT
    ? { status: "signed-out" }
    : { status: "unavailable" };
  private listeners = new Set<(state: AccountState) => void>();

  subscribe(listener: (state: AccountState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState() {
    return this.state;
  }

  getAccessToken() {
    if (!this.accessToken || Date.now() >= this.expiresAt) return null;
    return this.accessToken;
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string) {
    const endpoint = import.meta.env.VITE_MANGATAK_AUTH_ENDPOINT;
    if (!endpoint) throw new Error("Mangatak sign-in is not available yet");
    this.setState({ status: "authenticating" });
    try {
      const response = await fetch(new URL("/oauth/token", endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grantType: "authorization_code",
          code,
          redirectUri,
          clientId: "mhtalk-desktop",
        }),
      });
      const payload = (await response.json()) as ExchangeResponse;
      if (!response.ok || !payload.accessToken || !payload.account)
        throw new Error("Mangatak did not return a valid account session");
      this.accessToken = payload.accessToken;
      this.expiresAt = Date.now() + Math.max(60, payload.expiresIn || 600) * 1000;
      this.setState({ status: "signed-in", account: payload.account });
      return payload.account;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-in failed";
      this.setState({ status: "failed", message });
      throw error;
    }
  }

  signOut() {
    this.accessToken = null;
    this.expiresAt = 0;
    this.setState(
      import.meta.env.VITE_MANGATAK_AUTH_ENDPOINT
        ? { status: "signed-out" }
        : { status: "unavailable" },
    );
  }

  private setState(state: AccountState) {
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }
}

export const accountSession = new AccountSession();

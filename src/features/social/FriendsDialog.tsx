import { useState } from "react";
import { Avatar } from "../../components/Avatar";
import { MembershipBadge } from "../../components/MembershipBadge";
import {
  accountSession,
  type MHTalkAccount,
  type SearchProfile,
  type SocialState,
} from "../../services/accountSession";

export function FriendsDialog({
  open,
  account,
  social,
  onClose,
  onInvite,
  onError,
}: {
  open: boolean;
  account: MHTalkAccount;
  social: SocialState;
  onClose: () => void;
  onInvite: (friendId: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchProfile[]>([]);
  const [busy, setBusy] = useState("");

  if (!open) return null;

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await operation();
    } catch (error) {
      onError(error instanceof Error ? error.message : "The friends service could not complete this request");
    } finally {
      setBusy("");
    }
  };

  const search = () => run("search", async () => {
    const value = query.trim();
    if (value.length < 2) return;
    setResults(await accountSession.searchProfiles(value));
  });

  return (
    <div className="modal-backdrop">
      <section className="private-modal friends-modal" role="dialog" aria-modal="true" aria-label="Friends">
        <button className="modal-close" onClick={onClose}>×</button>
        <h2>Friends</h2>
        <div className="social-content">
          <div className="social-account-card">
            <Avatar value={account.avatarUrl || account.displayName.slice(0, 1)} />
            <span><strong>{account.displayName} <MembershipBadge tier={account.subscription.tier} /></strong><small>@{account.username}</small></span>
            <button className="control social-action" onClick={() => void accountSession.refreshSocial()}>Refresh</button>
          </div>
          {social.requests.length > 0 && (
            <div className="social-section">
              <h3>Friend requests</h3>
              {social.requests.map((request) => (
                <div className="social-person" key={request.requestId}>
                  <Avatar value={request.avatarUrl || request.displayName.slice(0, 1)} remote />
                  <span><strong>{request.displayName} <MembershipBadge tier={request.subscription.tier} /></strong><small>@{request.username}</small></span>
                  <div className="social-row-actions">
                    <button className="social-accept social-action" disabled={Boolean(busy)} onClick={() => void run(request.requestId, () => accountSession.respondFriendRequest(request.requestId, true))}>Accept</button>
                    <button className="social-icon-button social-action" disabled={Boolean(busy)} title="Decline" aria-label={`Decline ${request.displayName}'s friend request`} onClick={() => void run(request.requestId, () => accountSession.respondFriendRequest(request.requestId, false))}>×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="social-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="Search name or @username" />
            <button className="control social-action" disabled={busy === "search" || query.trim().length < 2} onClick={() => void search()}>Search</button>
          </div>
          {results.length > 0 && (
            <div className="social-results">
              {results.map((result) => (
                <div className="social-person" key={result.id}>
                  <Avatar value={result.avatarUrl || result.displayName.slice(0, 1)} remote />
                  <span><strong>{result.displayName} <MembershipBadge tier={result.subscription.tier} /></strong><small>@{result.username}</small></span>
                  <button className="control social-action" disabled={result.isFriend || Boolean(busy)} onClick={() => void run(result.id, async () => {
                    await accountSession.sendFriendRequest(result.id);
                    setResults((items) => items.filter((item) => item.id !== result.id));
                  })}>{result.isFriend ? "Friends" : "Add"}</button>
                </div>
              ))}
            </div>
          )}
          <div className="social-section social-friend-list">
            <h3>Your friends</h3>
            {social.loading && <p>Loading friends…</p>}
            {!social.loading && social.friends.length === 0 && <p>No friends yet. Search by name or username.</p>}
            {social.friends.map((friend) => (
              <div className="social-person" key={friend.id}>
                <div className="social-avatar"><Avatar value={friend.avatarUrl || friend.displayName.slice(0, 1)} remote /><i className={friend.online ? "online" : "offline"} /></div>
                <span><strong>{friend.displayName} <MembershipBadge tier={friend.subscription.tier} /></strong><small>{friend.online ? "Online" : "Offline"} · @{friend.username}</small></span>
                <button className="primary social-action" disabled={Boolean(busy)} onClick={() => void run(friend.id, () => onInvite(friend.id))}>Invite</button>
              </div>
            ))}
            {social.error && <small className="social-error">{social.error}</small>}
          </div>
        </div>
      </section>
    </div>
  );
}

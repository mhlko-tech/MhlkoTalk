import ipaddr from 'ipaddr.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const token = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function matches(secret, digest) {
  return typeof secret === 'string' && secret.length <= 512 && /^[a-f0-9]{64}$/.test(digest || '')
    && timingSafeEqual(Buffer.from(hash(secret), 'hex'), Buffer.from(digest, 'hex'));
}
export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
// HTTPS CONNECT cannot inspect paths inside end-to-end TLS. Keep the host list narrow.
export const defaultHosts = [
  'patreon.com', 'www.patreon.com', 'api.patreon.com', 'c5.patreon.com',
  // The login page's Next.js JavaScript and CSS are served from this exact CDN.
  'c13.patreon.com',
  'cdn.patreon.com', 'static.patreon.com', 'assets.patreon.com',
  'js.stripe.com', 'api.stripe.com', 'm.stripe.com', 'm.stripe.network',
  'q.stripe.com', 'checkout.stripe.com', 'hooks.stripe.com',
  'challenges.cloudflare.com', 'hcaptcha.com', 'www.hcaptcha.com',
  'newassets.hcaptcha.com', 'imgs.hcaptcha.com',
  'www.google.com', 'www.gstatic.com', 'www.recaptcha.net',
];
export function allowedHost(host, hosts = defaultHosts) {
  if (typeof host !== 'string' || host.length > 253 || host !== host.toLowerCase()
      || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(host)) return false;
  return hosts.includes(host) || host.endsWith('.patreonusercontent.com');
}
export class RateLimit {
  entries = new Map();
  take(key, count, windowMs, now = Date.now()) {
    const old = this.entries.get(key);
    if (!old || old.until <= now) {
      if (this.entries.size >= 10000) {
        for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
        if (this.entries.size >= 10000) return false;
      }
      this.entries.set(key, { used: 1, until: now + windowMs });
      return true;
    }
    if (old.used >= count) return false;
    old.used++;
    return true;
  }
}

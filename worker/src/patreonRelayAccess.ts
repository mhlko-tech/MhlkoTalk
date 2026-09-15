export async function patreonRelayAccess(secret: string, userId: string, audience: string, now = Date.now()) {
  if (secret.length < 32 || !userId) throw new Error("Patreon connection is not configured");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  const sign = async (value: string) => new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, "0")).join("");
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const subject = hex(await sign(`mhtalk:${userId}`));
  const payload = base64(encoder.encode(JSON.stringify({v:1, aud:audience, sub:subject, exp:now+5*60_000, jti:hex(crypto.getRandomValues(new Uint8Array(24)))})));
  return `${payload}.${base64(await sign(payload))}`;
}

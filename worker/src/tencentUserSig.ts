/** Generates Tencent TRTC UserSig with Web APIs supported by Cloudflare Workers. */
export async function generateTencentUserSig(
  sdkAppId: number,
  identity: string,
  secretKey: string,
  expiresInSeconds = 24 * 60 * 60,
  issuedAt = Math.floor(Date.now() / 1000),
) {
  const encoder = new TextEncoder();
  const contentToSign =
    `TLS.identifier:${identity}\n` +
    `TLS.sdkappid:${sdkAppId}\n` +
    `TLS.time:${issuedAt}\n` +
    `TLS.expire:${expiresInSeconds}\n`;
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(contentToSign));
  const ticket = {
    "TLS.ver": "2.0",
    "TLS.identifier": identity,
    "TLS.sdkappid": sdkAppId,
    "TLS.time": issuedAt,
    "TLS.expire": expiresInSeconds,
    "TLS.sig": bytesToBase64(new Uint8Array(signed)),
  };
  const compressed = await new Response(
    new Blob([encoder.encode(JSON.stringify(ticket))])
      .stream()
      .pipeThrough(new CompressionStream("deflate")),
  ).arrayBuffer();
  return bytesToBase64(new Uint8Array(compressed))
    .replaceAll("+", "*")
    .replaceAll("/", "-")
    .replaceAll("=", "_");
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

import {createHmac, timingSafeEqual} from 'node:crypto';

export function verifyAccess(value, secret, audience, now=Date.now()) {
  if(typeof value!=='string' || value.length>2048 || typeof secret!=='string' || secret.length<32) return null;
  const parts=value.split('.');
  if(parts.length!==2 || !parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected=createHmac('sha256',secret).update(parts[0]).digest();
  const supplied=Buffer.from(parts[1],'base64url');
  if(supplied.length!==expected.length || !timingSafeEqual(expected,supplied)) return null;
  try {
    const claim=JSON.parse(Buffer.from(parts[0],'base64url'));
    if(claim.v!==1 || claim.aud!==audience || !/^[a-f0-9]{64}$/.test(claim.sub)
      || !/^[a-f0-9]{48}$/.test(claim.jti) || !Number.isSafeInteger(claim.exp)
      || claim.exp<=now || claim.exp>now+5*60_000) return null;
    return claim;
  } catch {return null;}
}

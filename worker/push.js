const encoder = new TextEncoder();
const encode = (value) => encoder.encode(value);

export function fromBase64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (byte) => byte.charCodeAt(0));
}

function toBase64(value) {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function join(...parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function hkdf(secret, salt, info, bits) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bits));
}

async function encrypt(subscription, notice) {
  const recipient = fromBase64(subscription.keys.p256dh);
  const peer = await crypto.subtle.importKey('raw', recipient, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sender = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256);
  const keyInfo = join(encode('WebPush: info\0'), recipient, sender);
  const ikm = await hkdf(shared, fromBase64(subscription.keys.auth), keyInfo, 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const [material, iv] = await Promise.all([
    hkdf(ikm, salt, encode('Content-Encoding: aes128gcm\0'), 128),
    hkdf(ikm, salt, encode('Content-Encoding: nonce\0'), 96),
  ]);
  const key = await crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, join(encode(JSON.stringify(notice)), Uint8Array.of(2)));
  return join(salt, Uint8Array.of(0, 0, 16, 0, sender.length), sender, new Uint8Array(ciphertext));
}

export async function signAuthorization(origin, expires, env) {
  const headers = toBase64(encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64(encode(JSON.stringify({
    aud: origin,
    exp: expires,
    sub: env.SITE_URL,
  })));
  const unsigned = headers + '.' + claims;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encode(unsigned));
  return `vapid t=${unsigned}.${toBase64(new Uint8Array(signature))}, k=${env.VAPID_PUBLIC_KEY}`;
}

export async function sendPush(subscription, notice, authorization) {
  const body = await encrypt(subscription, notice);
  const response = await fetch(subscription.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000), body,
    headers: {
      Authorization: authorization, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '45', Urgency: 'high', Topic: notice.tag,
    },
  });
  await response.body?.cancel();
  return response.status;
}

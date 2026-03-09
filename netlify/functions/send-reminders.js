// Netlify Scheduled Function — fires every minute
// Reads push subscriptions + reminders from Firestore, sends Web Push

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = 'mailto:relay.your.problem@gmail.com';
const FB_PROJECT    = process.env.FIREBASE_PROJECT_ID || 'flow-note-dc460';
const FB_KEY        = process.env.FIREBASE_API_KEY;

// ── Minimal Web Push sender (no npm needed) ──────────────────────
// Uses Node 18+ built-in crypto + fetch
const { createSign } = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

async function makeVapidJwt(audience) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: now + 3600,
    sub: VAPID_EMAIL
  }));

  const unsigned = `${header}.${payload}`;

  // Use Node crypto with ES256 (P-256)
  const keyBuf = b64urlDecode(VAPID_PRIVATE);
  const sign = createSign('SHA256');
  sign.update(unsigned);

  // We need to import the raw private key as EC key
  const { subtle } = globalThis.crypto || require('crypto').webcrypto;
  const key = await subtle.importKey(
    'raw', keyBuf,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

async function sendPush(subscription, payload) {
  try {
    const url = new URL(subscription.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await makeVapidJwt(audience);

    const { subtle } = globalThis.crypto || require('crypto').webcrypto;

    // ECDH key exchange
    const serverKey = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const clientKey = await subtle.importKey('raw', b64urlDecode(subscription.keys.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKey.privateKey, 256);

    // Auth secret
    const auth = b64urlDecode(subscription.keys.auth);

    // HKDF for content encryption key + nonce
    const encoder = new TextEncoder();
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));

    const ikm = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
    const prk = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: auth, info: encoder.encode('Content-Encoding: auth\0') }, ikm, 256);

    // Export server public key
    const serverPub = await subtle.exportKey('raw', serverKey.publicKey);

    const cekInfo = concat(encoder.encode('Content-Encoding: aesgcm\0'), new Uint8Array(1), b64urlDecode(subscription.keys.p256dh), new Uint8Array(serverPub));
    const nonceInfo = concat(encoder.encode('Content-Encoding: nonce\0'), new Uint8Array(1), b64urlDecode(subscription.keys.p256dh), new Uint8Array(serverPub));

    const prkKey = await subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
    const cekBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prkKey, 128);
    const nonceBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96);

    // Encrypt
    const encKey = await subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
    const msgBuf = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
    // Pad
    const padded = new Uint8Array(msgBuf.length + 2);
    padded.set(msgBuf, 2);
    const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv: nonceBits }, encKey, padded);

    const body = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array(serverPub), new Uint8Array(encrypted));

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC}`,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aesgcm',
        'Encryption': `salt=${b64url(salt)}`,
        'Crypto-Key': `dh=${b64url(serverPub)};p256ecdsa=${VAPID_PUBLIC}`,
        'TTL': '86400'
      },
      body
    });
    return res.status;
  } catch(e) {
    console.error('Push send error:', e.message);
    return 0;
  }
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── Firestore REST ───────────────────────────────────────────────
async function firestoreList(collection) {
  const url = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/${collection}?key=${FB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.documents || []).map(doc => {
    const fields = doc.fields || {};
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v.stringValue !== undefined) out[k] = v.stringValue;
      else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
      else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
      else if (v.arrayValue) out[k] = (v.arrayValue.values || []).map(i => i.stringValue || i.mapValue || i);
      else if (v.mapValue) out[k] = v.mapValue; // raw
    }
    out._id = doc.name.split('/').pop();
    return out;
  });
}

// ── Time helpers ─────────────────────────────────────────────────
function nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function todayStr() {
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function timeTo24(raw) {
  if (!raw) return null;
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;
  const m = raw.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]), mn = parseInt(m[2]), ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return String(h).padStart(2,'0') + ':' + String(mn).padStart(2,'0');
}

// ── Main handler ─────────────────────────────────────────────────
exports.handler = async () => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error('Missing VAPID keys');
    return { statusCode: 200, body: 'no keys' };
  }

  const now = nowHHMM();
  const today = todayStr();

  let docs;
  try { docs = await firestoreList('pushData'); }
  catch(e) { console.error('Firestore error:', e.message); return { statusCode: 200, body: 'fs error' }; }

  let sent = 0;
  for (const doc of docs) {
    if (!doc.subscription) continue;

    let sub, reminders;
    try { sub = JSON.parse(doc.subscription); } catch(e) { continue; }
    try { reminders = JSON.parse(doc.reminders || '[]'); } catch(e) { continue; }

    const fired = {};
    try { Object.assign(fired, JSON.parse(doc.fired || '{}')); } catch(e) {}
    const firedToday = fired[today] || {};

    for (const r of reminders) {
      if (r.done) continue;
      const t24 = timeTo24(r.time || r.startTime || '');
      if (!t24 || t24 !== now) continue;
      if (r.date !== today && r.date !== 'everyday' && r.date !== 'everyweek') continue;
      const key = 'r' + r.id;
      if (firedToday[key]) continue;

      const title = (r.emoji || '🔔') + ' ' + r.text;
      const body = r.date === 'everyday' ? 'Daily reminder' : 'Tap to view';
      const status = await sendPush(sub, JSON.stringify({ title, body, tag: key }));
      console.log(`Push to ${doc._id}: ${status} — ${title}`);
      if (status >= 200 && status < 300) sent++;
    }
  }

  return { statusCode: 200, body: `ok:${sent}` };
};

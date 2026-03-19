// netlify/functions/send-reminders.js
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = 'mailto:relay.your.problem@gmail.com';
const BREVO_KEY     = process.env.BREVO_API_KEY;
const SENDER_EMAIL  = 'relay.your.problem@gmail.com';

// ── Firebase Admin SDK ──────────────────────────────────────────
let _adminDb = null;
function getAdminDb() {
  if (_adminDb) return _adminDb;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    _adminDb = admin.firestore();
    return _adminDb;
  } catch(e) {
    console.error('Admin SDK init failed:', e.message);
    return null;
  }
}

async function firestoreList(collection) {
  const db = getAdminDb();
  if (!db) return [];
  const snap = await db.collection(collection).get();
  return snap.docs.map(doc => ({ ...doc.data(), _id: doc.id }));
}

async function firestorePatch(collection, docId, fields) {
  const db = getAdminDb();
  if (!db) return;
  await db.collection(collection).doc(docId).set(fields, { merge: true });
}

// ── Web Push ────────────────────────────────────────────────────
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
  const payload = b64url(JSON.stringify({ aud: audience, exp: now + 3600, sub: VAPID_EMAIL }));
  const unsigned = `${header}.${payload}`;
  const keyBuf = b64urlDecode(VAPID_PRIVATE);
  const { subtle } = globalThis.crypto || require('crypto').webcrypto;
  const key = await subtle.importKey('raw', keyBuf, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}
function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
async function sendPush(subscription, payload) {
  try {
    const url = new URL(subscription.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const jwt = await makeVapidJwt(audience);
    const { subtle } = globalThis.crypto || require('crypto').webcrypto;
    const serverKey = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const clientKey = await subtle.importKey('raw', b64urlDecode(subscription.keys.p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKey.privateKey, 256);
    const auth = b64urlDecode(subscription.keys.auth);
    const encoder = new TextEncoder();
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const ikm = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
    const prk = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: auth, info: encoder.encode('Content-Encoding: auth\0') }, ikm, 256);
    const serverPub = await subtle.exportKey('raw', serverKey.publicKey);
    const cekInfo = concat(encoder.encode('Content-Encoding: aesgcm\0'), new Uint8Array(1), b64urlDecode(subscription.keys.p256dh), new Uint8Array(serverPub));
    const nonceInfo = concat(encoder.encode('Content-Encoding: nonce\0'), new Uint8Array(1), b64urlDecode(subscription.keys.p256dh), new Uint8Array(serverPub));
    const prkKey = await subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
    const cekBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prkKey, 128);
    const nonceBits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prkKey, 96);
    const encKey = await subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
    const msgBuf = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
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

// ── Email via Brevo ─────────────────────────────────────────────
async function sendEmail(to, subject, reminderText, emoji) {
  if (!BREVO_KEY || !to) return;
  const html =
    "<div style='font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#faf9f6;border-radius:16px;overflow:hidden;border:1px solid #e2dfd8'>" +
    "<div style='background:#1a6b3c;padding:20px 24px;text-align:center'>" +
    "<span style='font-size:2rem'>" + (emoji || '🔔') + "</span>" +
    "<h1 style='color:#fff;margin:8px 0 0;font-size:1.1rem;font-weight:700'>Reminder</h1>" +
    "</div>" +
    "<div style='padding:20px 24px;color:#0f0f0f;font-size:1rem;line-height:1.6'>" +
    "<p>" + reminderText + "</p>" +
    "<a href='https://menmory.netlify.app' style='display:inline-block;margin-top:12px;background:#1a6b3c;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:.9rem'>Open Menmory →</a>" +
    "</div>" +
    "<div style='padding:12px 24px;background:#f2f0eb;text-align:center;font-size:.75rem;color:#9e9b93'>Menmory — Your personal study OS</div>" +
    "</div>";
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Menmory', email: SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });
  } catch(e) {
    console.warn('Email error:', e.message);
  }
}

// ── Time helpers ────────────────────────────────────────────────
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
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
function t24ToMinutes(t24) {
  if (!t24) return -1;
  const [h, m] = t24.split(':').map(Number);
  return h * 60 + m;
}

// ── Main ────────────────────────────────────────────────────────
exports.handler = async () => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error('Missing VAPID keys');
    return { statusCode: 200, body: 'no keys' };
  }

  const nowMin = nowMinutes();
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
    let firedChanged = false;

    const userEmail = doc.notifEmail || null;

    for (const r of reminders) {
      if (r.done) continue;
      const t24 = timeTo24(r.time || r.startTime || '');
      if (!t24) continue;
      const rMin = t24ToMinutes(t24);
      const diff = nowMin - rMin;
      if (diff < 0 || diff > 3) continue;
      if (r.date !== today && r.date !== 'everyday' && r.date !== 'everyweek') continue;
      const key = 'r' + r.id;
      if (firedToday[key]) continue;

      const title = (r.emoji || '🔔') + ' ' + r.text;
      const status = await sendPush(sub, JSON.stringify({ title, body: 'Tap to view', tag: key }));
      console.log(`Push to ${doc._id}: ${status} — ${title}`);
      if (status >= 200 && status < 300) sent++;

      if (userEmail) {
        await sendEmail(userEmail, title, r.text, r.emoji || '🔔');
      }

      firedToday[key] = true;
      firedChanged = true;
    }

    if (firedChanged) {
      fired[today] = firedToday;
      const keys = Object.keys(fired).sort();
      if (keys.length > 3) keys.slice(0, keys.length - 3).forEach(k => delete fired[k]);
      try {
        await firestorePatch('pushData', doc._id, { fired: JSON.stringify(fired) });
      } catch(e) {
        console.warn('Failed to save fired state:', e.message);
      }
    }
  }

  return { statusCode: 200, body: `ok:${sent}` };
};

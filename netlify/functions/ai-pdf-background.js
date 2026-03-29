// netlify/functions/ai-pdf-background.js
// Background function — NO return statement = runs up to 15 min

let _adminDb = null;
function getAdminDb() {
  if (_adminDb) return _adminDb;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  _adminDb = admin.firestore();
  return _adminDb;
}

exports.handler = async (event) => {
  let jobId = null;
  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    if (!jobId) return;

    const db = getAdminDb();
    const ref = db.collection('pdfJobs').doc(jobId);

    if (!process.env.ANTHROPIC_API_KEY) {
      await ref.set({ status: 'error', error: 'API key not configured', t: Date.now() });
      return;
    }

    await ref.set({ status: 'processing', t: Date.now() });

    const { jobId: _x, ...aiPayload } = body;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(aiPayload)
    });

    const text = await res.text();
    await ref.set({ status: 'done', statusCode: res.status, body: text, t: Date.now() });

  } catch (err) {
    console.error('[pdf-bg]', err.message);
    if (jobId) {
      try {
        const db = getAdminDb();
        await db.collection('pdfJobs').doc(jobId).set({ status: 'error', error: err.message, t: Date.now() });
      } catch(e) {}
    }
  }
  // NO return
};

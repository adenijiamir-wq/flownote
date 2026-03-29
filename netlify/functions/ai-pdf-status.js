// netlify/functions/ai-pdf-status.js
// Regular function — polls Firestore for job result

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'content-type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing jobId' }) };

  try {
    const db = getAdminDb();
    const doc = await db.collection('pdfJobs').doc(jobId).get();

    if (!doc.exists) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
    }

    const job = doc.data();

    // Clean up terminal states
    if (job.status === 'done' || job.status === 'error') {
      doc.ref.delete().catch(() => {});
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(job) };
  } catch (err) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
  }
};

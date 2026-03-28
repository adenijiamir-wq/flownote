// netlify/functions/ai-pdf-status.js
//
// Polling endpoint. Client calls this every 3 seconds with ?jobId=xxx
// Returns: { status: 'pending' | 'processing' | 'done' | 'error', body?, error? }
// Cleans up the stored job once client has received the result.

const { getStore } = require('@netlify/blobs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'content-type': 'application/json'
};

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const jobId = event.queryStringParameters && event.queryStringParameters.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing jobId parameter' })
    };
  }

  const store = getStore('pdf-jobs');

  try {
    const raw = await store.get(jobId);

    // Job not found yet — background function hasn't started writing yet
    if (raw === null || raw === undefined) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ status: 'pending' })
      };
    }

    const job = JSON.parse(raw);

    // If terminal state, clean up so we don't leak storage
    if (job.status === 'done' || job.status === 'error') {
      try { await store.delete(jobId); } catch (e) { /* non-fatal */ }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(job)
    };

  } catch (err) {
    // Blob read error — treat as still pending so client keeps polling
    console.error('Status check error:', err.message);
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ status: 'pending' })
    };
  }
};

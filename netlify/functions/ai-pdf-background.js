// netlify/functions/ai-pdf-background.js
//
// Netlify Background Function — auto-returns 202 immediately.
// Runs up to 15 minutes. Calls Claude with PDF, stores result in Netlify Blobs.
// Client polls ai-pdf-status.js to get the result.

const { getStore } = require('@netlify/blobs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'content-type': 'application/json'
};

// TTL for stored results — 10 minutes is plenty (client polls for max 2 min)
const JOB_TTL_SECONDS = 600;

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'API key not configured on server.' })
    };
  }

  // Parse body — extract jobId and the rest of the Claude payload
  let jobId, aiPayload;
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;
    if (!jobId) throw new Error('Missing jobId');
    // Everything except jobId goes to Claude
    const { jobId: _removed, ...rest } = body;
    aiPayload = rest;
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid request body: ' + err.message })
    };
  }

  const store = getStore('pdf-jobs');

  // Mark job as processing immediately so the status endpoint knows it started
  try {
    await store.set(
      jobId,
      JSON.stringify({ status: 'processing' }),
      { ttl: JOB_TTL_SECONDS }
    );
  } catch (err) {
    // Non-fatal — continue anyway
    console.error('Failed to set processing state:', err.message);
  }

  // Call Claude API
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(aiPayload)
    });

    const responseText = await res.text();

    // Store result — whether success or API error
    await store.set(
      jobId,
      JSON.stringify({
        status: 'done',
        statusCode: res.status,
        body: responseText
      }),
      { ttl: JOB_TTL_SECONDS }
    );
  } catch (err) {
    // Network or other error calling Claude
    console.error('Claude API call failed:', err.message);
    try {
      await store.set(
        jobId,
        JSON.stringify({
          status: 'error',
          error: 'Failed to reach AI: ' + err.message
        }),
        { ttl: JOB_TTL_SECONDS }
      );
    } catch (storeErr) {
      console.error('Failed to store error state:', storeErr.message);
    }
  }
};

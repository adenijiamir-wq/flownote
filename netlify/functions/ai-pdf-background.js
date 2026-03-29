// netlify/functions/ai-pdf-background.js
//
// Netlify Background Function.
// CRITICAL: The handler must NOT return anything.
// Netlify automatically responds with 202 and keeps the function alive up to 15 min.
// We call Claude, then store the result in Netlify Blobs for the client to poll.

const { getStore } = require('@netlify/blobs');

const JOB_TTL_SECONDS = 600; // 10 minutes

exports.handler = async (event) => {
  // For background functions: do NOT return anything.
  // Any return causes Netlify to treat this as a regular function (10s limit).
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  let jobId = null;
  let store;

  try {
    store = getStore('pdf-jobs');
  } catch (e) {
    console.error('[pdf-bg] Failed to get blob store:', e.message);
    return;
  }

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;

    if (!jobId) {
      console.error('[pdf-bg] No jobId in request');
      return;
    }

    if (!apiKey) {
      await store.set(jobId, JSON.stringify({
        status: 'error',
        error: 'API key not configured on server'
      }), { ttl: JOB_TTL_SECONDS });
      return;
    }

    // Strip jobId before forwarding to Claude
    const { jobId: _strip, ...aiPayload } = body;

    // Mark as processing
    await store.set(jobId, JSON.stringify({
      status: 'processing'
    }), { ttl: JOB_TTL_SECONDS });

    // Call Claude — this is the slow part (15-30s for PDFs)
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

    // Store result for client to pick up
    await store.set(jobId, JSON.stringify({
      status: 'done',
      statusCode: res.status,
      body: responseText
    }), { ttl: JOB_TTL_SECONDS });

    console.log('[pdf-bg] Job', jobId, 'done, claude status:', res.status);

  } catch (err) {
    console.error('[pdf-bg] Error for job', jobId, ':', err.message);
    if (jobId && store) {
      try {
        await store.set(jobId, JSON.stringify({
          status: 'error',
          error: err.message || 'Unknown error'
        }), { ttl: JOB_TTL_SECONDS });
      } catch (e2) {
        console.error('[pdf-bg] Failed to store error:', e2.message);
      }
    }
  }
  // NO return — keeps it as background function
};

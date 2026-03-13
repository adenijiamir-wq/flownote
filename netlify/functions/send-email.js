// netlify/functions/send-email.js
// Sends transactional emails via Brevo (brevo.com)
// Works for ANY email address — no custom domain needed.

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { to_email, subject, message_html } = body;

  if (!to_email || !subject || !message_html) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to_email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address' }) };
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'Menmory', email: 'relay.your.problem@gmail.com' },
        to: [{ email: to_email }],
        subject: subject,
        htmlContent: message_html
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Brevo error:', data);
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.message || 'Send failed' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: data.messageId }) };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

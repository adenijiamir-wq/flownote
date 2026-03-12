// netlify/functions/reminder-check.js
// Runs every minute via Netlify Scheduled Functions.
// Reads all users from Firestore, checks for due reminders, sends emails via Resend.

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// ── Init Firebase Admin (only once across warm invocations) ──
function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

// ── Email via Resend ──
async function sendEmail(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Menmory <onboarding@resend.dev>",
      to: [to],
      subject,
      html
    })
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Resend error ${r.status}: ${err}`);
  }
  return await r.json();
}

// ── HTML email wrapper (matches the app's style) ──
function emailWrap(title, emoji, body) {
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#faf9f6;border-radius:16px;overflow:hidden;border:1px solid #e2dfd8">
    <div style="background:#1a6b3c;padding:24px 28px;text-align:center">
      <span style="font-size:2rem">${emoji}</span>
      <h1 style="color:#fff;margin:8px 0 0;font-size:1.2rem;font-weight:700">${title}</h1>
    </div>
    <div style="padding:24px 28px;color:#0f0f0f;line-height:1.6">${body}</div>
    <div style="padding:14px 28px;background:#f2f0eb;text-align:center;font-size:.75rem;color:#9e9b93">Menmory — Your personal study OS</div>
  </div>`;
}

// ── Time helpers ──
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Convert "2:45 PM" / "14:45" → total minutes since midnight
function timeToMinutes(raw) {
  if (!raw) return -1;
  raw = raw.trim();
  const ampm = raw.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1]), m = parseInt(ampm[2]);
    const period = ampm[3].toUpperCase();
    if (period === "AM" && h === 12) h = 0;
    if (period === "PM" && h !== 12) h += 12;
    return h * 60 + m;
  }
  const h24 = raw.match(/^(\d+):(\d+)$/);
  if (h24) return parseInt(h24[1]) * 60 + parseInt(h24[2]);
  return -1;
}

// ── Main handler ──
exports.handler = async function() {
  const APP_URL = "https://menmory.netlify.app";

  try {
    const db = getDb();
    const now = new Date();
    const today = todayStr();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    // Get all users who have a notifEmail set
    const usersSnap = await db.collection("users").where("notifEmail", "!=", "").get();

    let sent = 0, checked = 0;

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const data = userDoc.data();
      const email = data.notifEmail;
      const prefs = data.notifPrefs || {};
      const userName = data.displayName || "there";

      if (!email) continue;

      // Parse appData (stored as JSON string)
      let appData = {};
      try { appData = typeof data.appData === "string" ? JSON.parse(data.appData) : (data.appData || {}); }
      catch { continue; }

      const reminders = appData.reminders || [];
      const name = appData.userName || userName;
      checked++;

      // ── Reminder emails ──
      if (prefs.studyReminder !== false) {
        // Track which reminders we've emailed today — stored in Firestore
        const firedRef = db.collection("emailFired").doc(uid);
        const firedSnap = await firedRef.get();
        const firedToday = (firedSnap.exists && firedSnap.data()[today]) ? firedSnap.data()[today] : {};
        let firedChanged = false;

        for (const r of reminders) {
          if (r.done) continue;
          const raw = r.time || r.startTime || "";
          if (!raw) continue;

          // Only fire for today / everyday / everyweek tasks
          const isToday = r.date === today || r.date === "everyday" || r.date === "everyweek";
          if (!isToday) continue;

          const rMin = timeToMinutes(raw);
          if (rMin < 0) continue;

          // Fire if within the current minute (±1 min tolerance)
          const diff = nowMin - rMin;
          if (diff < 0 || diff > 1) continue;

          const key = "r" + r.id;
          if (firedToday[key]) continue; // already sent today

          firedToday[key] = true;
          firedChanged = true;

          const reminderHtml = emailWrap(
            "Reminder",
            r.emoji || "🔔",
            `<p>Hey <strong>${name}</strong>!</p>
             <p>Your reminder just went off:</p>
             <div style="background:#e8f4ed;border-radius:12px;padding:16px 20px;margin:16px 0;border-left:4px solid #1a6b3c">
               <div style="font-size:1.3rem;margin-bottom:6px">${r.emoji || "🔔"}</div>
               <strong style="font-size:1rem">${r.text}</strong><br>
               <span style="color:#1a6b3c;font-weight:600;font-size:.85rem">${raw}</span>
             </div>
             <p style="margin-top:20px">
               <a href="${APP_URL}" style="background:#1a6b3c;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block">Open Menmory</a>
             </p>`
          );

          try {
            await sendEmail(email, `${r.emoji || "🔔"} Reminder: ${r.text}`, reminderHtml);
            sent++;
            console.log(`Sent reminder email to ${uid} for "${r.text}"`);
          } catch (e) {
            console.error(`Failed to send reminder to ${uid}:`, e.message);
          }
        }

        if (firedChanged) {
          await firedRef.set({ [today]: firedToday }, { merge: true });
        }
      }

      // ── Morning digest at exactly 8:00am ──
      if (prefs.digest !== false && nowMin >= 480 && nowMin <= 481) {
        const digestRef = db.collection("emailFired").doc(uid);
        const digestSnap = await digestRef.get();
        const digestFired = digestSnap.exists ? (digestSnap.data()["digest_" + today] || false) : false;

        if (!digestFired) {
          const todayTasks = reminders.filter(r =>
            !r.done && (r.date === today || r.date === "everyday" || r.date === "everyweek")
          );

          if (todayTasks.length > 0) {
            const rows = todayTasks.map(r =>
              `<tr>
                <td style="padding:8px 12px;font-size:.9rem">${r.emoji || "🔔"} ${r.text}</td>
                <td style="padding:8px 12px;font-size:.85rem;color:#1a6b3c;font-weight:600;white-space:nowrap">${r.time || r.startTime || ""}</td>
              </tr>`
            ).join("");

            const digestHtml = emailWrap(
              "Today's Tasks",
              "☀️",
              `<p>Hey <strong>${name}</strong>! Here's what's on your plate today:</p>
               <table style="width:100%;border-collapse:collapse;margin:12px 0;background:#f9f9f9;border-radius:10px;overflow:hidden">
                 <tr style="background:#1a6b3c;color:#fff">
                   <th style="padding:8px 12px;text-align:left;font-size:.8rem">TASK</th>
                   <th style="padding:8px 12px;text-align:left;font-size:.8rem">TIME</th>
                 </tr>
                 ${rows}
               </table>
               <p style="margin-top:20px">
                 <a href="${APP_URL}" style="background:#1a6b3c;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block">Open Menmory</a>
               </p>`
            );

            try {
              await sendEmail(email, "Menmory: Your tasks for today ☀️", digestHtml);
              sent++;
              await digestRef.set({ ["digest_" + today]: true }, { merge: true });
              console.log(`Sent morning digest to ${uid}`);
            } catch (e) {
              console.error(`Failed to send digest to ${uid}:`, e.message);
            }
          }
        }
      }
    }

    console.log(`reminder-check: checked=${checked} sent=${sent}`);
    return { statusCode: 200, body: JSON.stringify({ checked, sent }) };

  } catch (e) {
    console.error("reminder-check fatal:", e);
    return { statusCode: 500, body: e.message };
  }
};

const { schedule } = require("@netlify/functions");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const APP_URL = "https://menmory.netlify.app";

function getDb() {
  if (!getApps().length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

async function sendEmail(to, subject, html) {
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { name: "Menmory", email: "relay.your.problem@gmail.com" },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
  return r.json();
}

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

function openBtn() {
  return `<p style="margin-top:20px"><a href="${APP_URL}" style="background:#1a6b3c;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block">Open Menmory</a></p>`;
}

function todayStr(d) { return (d || new Date()).toISOString().slice(0, 10); }

function timeToMinutes(raw) {
  if (!raw) return -1;
  raw = raw.trim();
  const ampm = raw.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1]), m = parseInt(ampm[2]);
    if (ampm[3].toUpperCase() === "AM" && h === 12) h = 0;
    if (ampm[3].toUpperCase() === "PM" && h !== 12) h += 12;
    return h * 60 + m;
  }
  const h24 = raw.match(/^(\d+):(\d+)$/);
  if (h24) return parseInt(h24[1]) * 60 + parseInt(h24[2]);
  return -1;
}

function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr + "T00:00:00") - today) / 86400000);
}

async function handler() {
  try {
    const db = getDb();
    const now = new Date();
    const today = todayStr(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();

    console.log(`reminder-check running at ${now.toISOString()} nowMin=${nowMin}`);

    const usersSnap = await db.collection("users").get();
    let sent = 0, checked = 0;

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      const data = userDoc.data();
      const email = data.notifEmail;
      if (!email || email.trim() === "") continue;

      const prefs = data.notifPrefs || {};
      let appData = {};
      try { appData = typeof data.appData === "string" ? JSON.parse(data.appData) : (data.appData || {}); }
      catch (e) { console.error(`[${uid}] appData parse fail:`, e.message); continue; }

      const reminders = appData.reminders || [];
      const name = appData.userName || data.displayName || "there";
      checked++;

      const firedRef = db.collection("emailFired").doc(uid);
      let firedAll = {};
      try { const s = await firedRef.get(); if (s.exists) firedAll = s.data(); } catch(e) {}
      const firedToday = firedAll[today] || {};
      let firedChanged = false;

      async function tryFire(key, subject, html) {
        if (firedToday[key]) return;
        firedToday[key] = true;
        firedChanged = true;
        try {
          await sendEmail(email, subject, html);
          sent++;
          console.log(`[${uid}] SENT: ${key}`);
        } catch (e) {
          console.error(`[${uid}] FAIL ${key}:`, e.message);
        }
      }

      // ── TASK REMINDERS ──
      if (prefs.taskReminder !== false) {
        for (const r of reminders) {
          if (r.done) continue;
          const raw = r.time || r.startTime || "";
          if (!raw) continue;
          const rMin = timeToMinutes(raw);
          if (rMin < 0) continue;
          const em = r.emoji || "🔔";
          const id = String(r.id);
          const isToday = r.date === today || r.date === "everyday" || r.date === "everyweek";
          const isFuture = !isToday && r.date > today;

          if (isToday) {
            // 1 hour before
            if ((rMin - 60 - nowMin) >= 0 && (rMin - 60 - nowMin) <= 3) {
              await tryFire(`r${id}_1h`, `⏰ In 1 hour: ${r.text}`,
                emailWrap("1 Hour Away", em,
                  `<p>Hey <strong>${name}</strong>! This reminder fires in <strong>1 hour</strong>:</p>
                   <div style="background:#e8f4ed;border-radius:12px;padding:16px 20px;margin:16px 0;border-left:4px solid #1a6b3c">
                     <div style="font-size:1.3rem">${em}</div><strong>${r.text}</strong><br>
                     <span style="color:#1a6b3c;font-weight:600">⏰ ${raw}</span>
                   </div>${openBtn()}`));
            }
            // 5 min before
            if ((rMin - 5 - nowMin) >= 0 && (rMin - 5 - nowMin) <= 3) {
              await tryFire(`r${id}_5m`, `🔔 In 5 minutes: ${r.text}`,
                emailWrap("5 Minutes Away", em,
                  `<p>Hey <strong>${name}</strong>! This reminder fires in <strong>5 minutes</strong>:</p>
                   <div style="background:#fff3cd;border-radius:12px;padding:16px 20px;margin:16px 0;border-left:4px solid #f59e0b">
                     <div style="font-size:1.3rem">${em}</div><strong>${r.text}</strong><br>
                     <span style="color:#b45309;font-weight:600">⏰ ${raw}</span>
                   </div>${openBtn()}`));
            }
            // At time
            if ((nowMin - rMin) >= 0 && (nowMin - rMin) <= 3) {
              await tryFire(`r${id}_at`, `${em} Reminder: ${r.text}`,
                emailWrap("Reminder", em,
                  `<p>Hey <strong>${name}</strong>! Your reminder just went off:</p>
                   <div style="background:#e8f4ed;border-radius:12px;padding:16px 20px;margin:16px 0;border-left:4px solid #1a6b3c">
                     <div style="font-size:1.3rem">${em}</div><strong>${r.text}</strong><br>
                     <span style="color:#1a6b3c;font-weight:600">⏰ ${raw}</span>
                   </div>${openBtn()}`));
            }
          }

          // Future: 1 day before at 8am
          if (isFuture && daysUntil(r.date) === 1 && nowMin >= 480 && nowMin <= 483) {
            await tryFire(`r${id}_1d`, `📅 Tomorrow: ${r.text}`,
              emailWrap("Due Tomorrow", "📅",
                `<p>Hey <strong>${name}</strong>! This task is due <strong>tomorrow</strong>:</p>
                 <div style="background:#e8f4ed;border-radius:12px;padding:16px 20px;margin:16px 0;border-left:4px solid #1a6b3c">
                   <div style="font-size:1.3rem">${em}</div><strong>${r.text}</strong><br>
                   <span style="color:#1a6b3c;font-weight:600">⏰ ${raw}</span>
                 </div>${openBtn()}`));
          }
        }
      }

      // ── COUNTDOWN ALERTS at 8am ──
      if (prefs.countdowns !== false && nowMin >= 480 && nowMin <= 483) {
        let countdowns = [];
        try {
          const raw = data.countdowns;
          if (raw) countdowns = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {}
        for (const cd of countdowns) {
          if (!cd.date || !cd.title) continue;
          const days = daysUntil(cd.date);
          if (![0, 1, 3, 7].includes(days)) continue;
          const urgency = days === 0 ? "TODAY 🚨" : days === 1 ? "tomorrow" : `in ${days} days`;
          const subj = days === 0 ? `🚨 Today: ${cd.title}` : days === 1 ? `📅 Tomorrow: ${cd.title}` : `⏳ ${cd.title} is in ${days} days`;
          await tryFire(`cd_${String(cd.id||cd.title).replace(/\W/g,"_")}_${days}d`, subj,
            emailWrap("Countdown Alert", "⏳",
              `<p>Hey <strong>${name}</strong>! Your countdown is <strong>${urgency}</strong>:</p>
               <div style="background:#e8f4ed;border-radius:12px;padding:20px;margin:16px 0;text-align:center;border-left:4px solid #1a6b3c">
                 <div style="font-size:2.5rem;font-weight:900;color:#1a6b3c">${days === 0 ? "🎯" : days}</div>
                 ${days !== 0 ? `<div style="font-size:.8rem;color:#666">days left</div>` : ""}
                 <div style="font-size:1.1rem;font-weight:700;margin-top:8px">${cd.title}</div>
               </div>
               <p>${days === 0 ? "This is it — you've got this! 💪" : "Make sure you're prepared!"}</p>${openBtn()}`));
        }
      }

      // ── MORNING DIGEST at 8am ──
      if (prefs.digest !== false && nowMin >= 480 && nowMin <= 483) {
        const digestKey = `digest_${today}`;
        if (!firedAll[digestKey]) {
          const todayTasks = reminders.filter(r =>
            !r.done && (r.date === today || r.date === "everyday" || r.date === "everyweek")
          );
          if (todayTasks.length > 0) {
            const rows = todayTasks.map(r =>
              `<tr><td style="padding:8px 12px;font-size:.9rem">${r.emoji||"🔔"} ${r.text}</td>
               <td style="padding:8px 12px;font-size:.85rem;color:#1a6b3c;font-weight:600">${r.time||r.startTime||"–"}</td></tr>`
            ).join("");
            await tryFire(digestKey, "Menmory: Your tasks for today ☀️",
              emailWrap("Today's Tasks", "☀️",
                `<p>Hey <strong>${name}</strong>! Here's what's on your plate today:</p>
                 <table style="width:100%;border-collapse:collapse;margin:12px 0;background:#f9f9f9;border-radius:10px;overflow:hidden">
                   <tr style="background:#1a6b3c;color:#fff">
                     <th style="padding:8px 12px;text-align:left;font-size:.8rem">TASK</th>
                     <th style="padding:8px 12px;text-align:left;font-size:.8rem">TIME</th>
                   </tr>${rows}
                 </table>${openBtn()}`));
          }
        }
      }

      if (firedChanged) {
        firedAll[today] = firedToday;
        try { await firedRef.set(firedAll, { merge: true }); } catch(e) {}
      }
    }

    console.log(`Done: checked=${checked} sent=${sent}`);
    return { statusCode: 200, body: JSON.stringify({ checked, sent }) };
  } catch (e) {
    console.error("FATAL:", e);
    return { statusCode: 500, body: e.message };
  }
}

// This is what actually makes Netlify schedule it
module.exports.handler = schedule("* * * * *", handler);

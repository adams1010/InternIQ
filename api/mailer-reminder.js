// InternIQ — MailerLite send-on-visit reminder backend.
// Called by the frontend when a user opens InternIQ and has a follow-up due.
// HONEST LIMITATION: this is NOT a true daily reminder. It only fires when the
// user opens the app. Vercel Hobby tier doesn't support cron jobs, so we can't
// schedule background sends. We tell the user this clearly in the UI.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ML_KEY = process.env.MAILERLITE_API_KEY;
  if (!ML_KEY) return res.status(500).json({ error: "MailerLite not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const email = (body.email || "").trim();
  const name = (body.name || "there").trim();
  const company = (body.company || "").trim();
  const role = (body.role || "this role").trim();
  const daysSinceApplied = parseInt(body.daysSinceApplied || 5, 10);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!company) return res.status(400).json({ error: "Missing company" });

  const subject = `Reminder: time to follow up with ${company}`;
  const htmlBody = `
<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#0A1628;max-width:520px">
  <p>Hi ${escapeHtml(name)},</p>
  <p>You applied to <strong>${escapeHtml(role)}</strong> at <strong>${escapeHtml(company)}</strong> about ${daysSinceApplied} days ago.</p>
  <p>That's around the sweet spot for a follow-up email. A short, professional check-in can meaningfully bump your odds of getting a response.</p>
  <p>Open InternIQ to draft a tailored follow-up email — we'll generate it for you and you send it from your own inbox:</p>
  <p style="margin:24px 0"><a href="https://intern-iq-psi.vercel.app/" style="background:#0d9488;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700">Draft my follow-up →</a></p>
  <p style="color:#9CA3AF;font-size:13px;margin-top:32px">— InternIQ</p>
  <p style="color:#9CA3AF;font-size:11px">You're getting this because you tracked an application on InternIQ. Reminders only send when you open the app.</p>
</div>`;

  try {
    // MailerLite v2 API: send a single email via the campaigns/transactional endpoint.
    // We use the simpler "subscribers + send transactional" pattern.
    // First, ensure subscriber exists.
    await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + ML_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ email, fields: { name } })
    });

    // Send a campaign-style email via MailerLite's email-sending endpoint.
    // Note: MailerLite's free transactional may require domain verification on a real domain.
    // Without that, this call may return a deliverability warning but still queue.
    const send = await fetch("https://connect.mailerlite.com/api/automations/trigger", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + ML_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        email,
        subject,
        html: htmlBody,
        from_name: "InternIQ"
      })
    });
    if (!send.ok) {
      const txt = await send.text();
      return res.status(send.status).json({ error: "MailerLite send failed", detail: txt.slice(0, 300) });
    }
    return res.status(200).json({ ok: true, email, company });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

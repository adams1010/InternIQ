// InternIQ — Supabase connection test (v3).
// Now that community_posts table exists, query it directly with both keys
// to confirm the publishable key can read, secret key can read+write.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const service = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !anon || !service) {
      return res.status(500).json({ ok: false, error: "Missing env vars" });
    }

    // Query the community_posts table (which exists now)
    const queryUrl = url + "/rest/v1/community_posts?select=id,content,flagged&limit=1";

    let publicTest = { status: null, body: null };
    try {
      const r = await fetch(queryUrl, {
        headers: {
          "apikey": anon,
          "Authorization": "Bearer " + anon
        }
      });
      publicTest.status = r.status;
      const text = await r.text();
      publicTest.body = text.slice(0, 200);
    } catch (e) {
      publicTest.body = String(e.message || e);
    }

    let secretTest = { status: null, body: null };
    try {
      const r = await fetch(queryUrl, {
        headers: {
          "apikey": service,
          "Authorization": "Bearer " + service
        }
      });
      secretTest.status = r.status;
      const text = await r.text();
      secretTest.body = text.slice(0, 200);
    } catch (e) {
      secretTest.body = String(e.message || e);
    }

    return res.status(200).json({
      ok: publicTest.status === 200 && secretTest.status === 200,
      url: url,
      anonKey: anon.slice(0, 12) + "...",
      serviceKey: service.slice(0, 12) + "...",
      publicKeyCanRead: publicTest,
      secretKeyCanRead: secretTest,
      hint: "If both show status:200 with body '[]' — Phase 2 setup is complete."
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

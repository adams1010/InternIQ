// InternIQ — Supabase connection test (v4).
// Adds Accept-Profile and Content-Profile headers to force the public schema,
// since Supabase's Data API was defaulting to graphql_public.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const service = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !anon || !service) {
      return res.status(500).json({ ok: false, error: "Missing env vars" });
    }

    const queryUrl = url + "/rest/v1/community_posts?select=id,content,flagged&limit=1";

    let publicTest = { status: null, body: null };
    try {
      const r = await fetch(queryUrl, {
        headers: {
          "apikey": anon,
          "Authorization": "Bearer " + anon,
          "Accept-Profile": "public",
          "Content-Profile": "public"
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
          "Authorization": "Bearer " + service,
          "Accept-Profile": "public",
          "Content-Profile": "public"
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

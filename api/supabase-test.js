// InternIQ — Supabase connection test endpoint (v2).
// Tests the Data API (PostgREST) root, which works correctly with the new
// publishable/secret key system. Hit:
//   https://intern-iq-psi.vercel.app/api/supabase-test

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const service = process.env.SUPABASE_SERVICE_KEY;

    const missing = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!anon) missing.push("SUPABASE_ANON_KEY");
    if (!service) missing.push("SUPABASE_SERVICE_KEY");
    if (missing.length > 0) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables: " + missing.join(", ")
      });
    }

    if (!url.startsWith("https://") || !url.includes(".supabase.co")) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL looks wrong"
      });
    }

    // Test 1: Hit the Data API root with the publishable (anon) key
    // 200 = key valid and works on the REST API (what we need for the community wall)
    const pingUrl = url + "/rest/v1/";
    let publicTest = { status: null, error: null };
    try {
      const r = await fetch(pingUrl, {
        headers: {
          "apikey": anon,
          "Authorization": "Bearer " + anon
        }
      });
      publicTest.status = r.status;
      if (!r.ok) {
        const body = await r.text();
        publicTest.error = body.slice(0, 200);
      }
    } catch (e) {
      publicTest.error = String(e.message || e);
    }

    // Test 2: Same endpoint with the secret key — should also work
    let secretTest = { status: null, error: null };
    try {
      const r = await fetch(pingUrl, {
        headers: {
          "apikey": service,
          "Authorization": "Bearer " + service
        }
      });
      secretTest.status = r.status;
      if (!r.ok) {
        const body = await r.text();
        secretTest.error = body.slice(0, 200);
      }
    } catch (e) {
      secretTest.error = String(e.message || e);
    }

    const bothWorking = publicTest.status === 200 && secretTest.status === 200;

    return res.status(200).json({
      ok: bothWorking,
      url: url,
      anonKey: anon.slice(0, 12) + "...",
      serviceKey: service.slice(0, 12) + "...",
      publicKeyTest: publicTest,
      secretKeyTest: secretTest
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

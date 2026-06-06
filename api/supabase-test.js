// InternIQ — Supabase connection test endpoint.
// GET this URL after deploying to confirm all three env vars are wired correctly:
//   https://intern-iq-psi.vercel.app/api/supabase-test
//
// Expected output on success:
//   {"ok":true,"url":"https://...supabase.co","anonKey":"sb_publish...","serviceKey":"sb_secret_..."}
//
// On failure: an "error" field with a clear description of what's missing or broken.
//
// SAFETY: This endpoint ONLY returns the first 12 chars of each key — never the full secret.
// You can delete this file once we've confirmed everything works in the next phase.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const service = process.env.SUPABASE_SERVICE_KEY;

    // Check that all three env vars exist
    const missing = [];
    if (!url) missing.push("SUPABASE_URL");
    if (!anon) missing.push("SUPABASE_ANON_KEY");
    if (!service) missing.push("SUPABASE_SERVICE_KEY");
    if (missing.length > 0) {
      return res.status(500).json({
        ok: false,
        error: "Missing environment variables: " + missing.join(", "),
        hint: "Check Vercel → Settings → Environment Variables. Redeploy after adding."
      });
    }

    // Check URL shape
    if (!url.startsWith("https://") || !url.includes(".supabase.co")) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL looks wrong",
        hint: "Should look like https://yourproject.supabase.co"
      });
    }

    // Try a real ping to Supabase using the anon key — hits the auth endpoint which exists by default
    const pingUrl = url + "/auth/v1/settings";
    let pingStatus = null;
    let pingError = null;
    try {
      const r = await fetch(pingUrl, {
        headers: {
          "apikey": anon,
          "Authorization": "Bearer " + anon
        }
      });
      pingStatus = r.status;
      if (!r.ok) {
        const body = await r.text();
        pingError = body.slice(0, 200);
      }
    } catch (e) {
      pingError = String(e.message || e);
    }

    // Return safe diagnostics — first 12 chars of each key only
    return res.status(200).json({
      ok: pingStatus === 200,
      url: url,
      anonKey: anon.slice(0, 12) + "...",
      serviceKey: service.slice(0, 12) + "...",
      ping: {
        endpoint: pingUrl,
        status: pingStatus,
        error: pingError
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

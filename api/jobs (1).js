// InternIQ backend — secure proxy to Adzuna jobs API.
// Tries progressively looser searches so we return SOMETHING real most of the time.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    return res.status(500).json({ error: "Missing ADZUNA_APP_ID or ADZUNA_APP_KEY in Vercel settings." });
  }

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const company = (body && body.company) || "";
    const role = (body && body.role) || "";
    const location = (body && body.location) || "";
    if (!company) return res.status(400).json({ error: "Missing company" });

    // Helper: hit the Adzuna search endpoint with a given set of params
    async function search(extra) {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: "10",
        "content-type": "application/json",
        ...extra
      });
      const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;
      const r = await fetch(url);
      if (!r.ok) return { results: [] };
      const d = await r.json();
      return { results: d.results || [] };
    }

    // Try progressively looser: company+intern+location → company+intern → company+location → company only
    const roleWord = (role && /intern/i.test(role)) ? role : (role ? role + " intern" : "intern");
    const attempts = [];
    if (location) attempts.push({ what: roleWord, company, where: location });
    attempts.push({ what: roleWord, company });
    if (location) attempts.push({ what: "intern", company, where: location });
    attempts.push({ what: "intern", company });
    if (location) attempts.push({ company, where: location });
    attempts.push({ company });

    let foundResults = [];
    let attemptUsed = -1;
    for (let i = 0; i < attempts.length; i++) {
      const { results } = await search(attempts[i]);
      if (results.length > 0) { foundResults = results; attemptUsed = i; break; }
    }

    if (foundResults.length === 0) {
      // Nothing on Adzuna at all — return a useful Adzuna search URL the app can use as fallback
      const browseUrl = `https://www.adzuna.com/search?q=${encodeURIComponent(company + " intern")}${location ? "&w=" + encodeURIComponent(location) : ""}`;
      return res.status(200).json({ found: false, applyUrl: null, browseUrl, attempts: attempts.length });
    }

    // Best match = first result of the tightest successful query
    const best = foundResults[0];
    return res.status(200).json({
      found: true,
      applyUrl: best.redirect_url,
      title: best.title,
      location: best.location && best.location.display_name,
      company: best.company && best.company.display_name,
      attemptUsed,
      jobs: foundResults.slice(0, 5).map(j => ({
        title: j.title,
        applyUrl: j.redirect_url,
        location: j.location && j.location.display_name,
        company: j.company && j.company.display_name
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err) });
  }
}

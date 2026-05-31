// InternIQ backend — Adzuna search proxy.
// Two modes:
//   1. mode="search" → broad search for "major + intern" near a ZIP (used for main results)
//   2. mode="company" (or default) → lookup a specific company's posting (used for "Apply" button)

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
    const mode = (body && body.mode) || "company";

    if (mode === "search") {
      // Broad search for "<major> intern" near a ZIP, used for main quiz results.
      const major = (body && body.major) || "";
      const zip = (body && body.zip) || "";
      const radius = (body && body.radius) || 25; // miles
      const what = `${major} intern`.trim();

      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: "50",
        what: what,
        "content-type": "application/json"
      });
      if (zip) {
        params.set("where", zip);
        params.set("distance", String(radius));
      }
      // Sort by relevance (default) — Adzuna's algorithm
      const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error", detail: data });

      const results = (data.results || []).map(j => ({
        title: j.title,
        company: j.company && j.company.display_name,
        location: j.location && j.location.display_name,
        description: j.description, // brief snippet
        applyUrl: j.redirect_url,
        category: j.category && j.category.label,
        created: j.created,
        salary_min: j.salary_min,
        salary_max: j.salary_max
      }));

      return res.status(200).json({
        count: results.length,
        total_available: data.count || results.length, // total matching results in Adzuna (may be > 50)
        jobs: results
      });
    }

    // Default: per-company lookup (for the apply button)
    const company = (body && body.company) || "";
    const role = (body && body.role) || "intern";
    const location = (body && body.location) || "";
    if (!company) return res.status(400).json({ error: "Missing company" });

    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: "10",
      what: `${role} intern`,
      company: company,
      "content-type": "application/json"
    });
    if (location) params.set("where", location);

    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error", detail: data });

    const results = (data.results || []);
    const best = results[0] || null;
    if (!best) return res.status(200).json({ found: false, applyUrl: null, jobs: [] });

    return res.status(200).json({
      found: true,
      applyUrl: best.redirect_url,
      title: best.title,
      location: best.location && best.location.display_name,
      company: best.company && best.company.display_name,
      jobs: results.slice(0, 5).map(j => ({
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

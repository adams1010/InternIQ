// InternIQ backend — Adzuna search proxy.
// Three modes:
//   1. mode="search"  → broad search for "major + intern" near a ZIP (main results)
//   2. mode="company" → lookup a specific company's posting (Apply button)
//   3. mode="batch"   → verify a list of AI-generated companies against Adzuna in parallel

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

    // ─── MODE: search ────────────────────────────────────────────────────────
    if (mode === "search") {
      const major = (body && body.major) || "";
      const zip = (body && body.zip) || "";
      const radius = (body && body.radius) || 25;
      const what = `${major} intern`.trim();

      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: "50",
        what,
        "content-type": "application/json"
      });
      if (zip) { params.set("where", zip); params.set("distance", String(radius)); }

      const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error", detail: data });

      return res.status(200).json({
        count: (data.results || []).length,
        total_available: data.count || 0,
        jobs: (data.results || []).map(j => ({
          title: j.title,
          company: j.company?.display_name,
          location: j.location?.display_name,
          description: j.description,
          applyUrl: j.redirect_url,
          category: j.category?.label,
          created: j.created,
          salary_min: j.salary_min,
          salary_max: j.salary_max
        }))
      });
    }

    // ─── MODE: batch ─────────────────────────────────────────────────────────
    // Takes an array of AI-generated companies and verifies each against Adzuna.
    // Returns a map of { companyName: { verified, applyUrl, realLocation, title } }
    if (mode === "batch") {
      const companies = (body && body.companies) || []; // [{ name, role, location }]
      const zip = (body && body.zip) || "";
      if (!companies.length) return res.status(400).json({ error: "Missing companies array" });

      // Cap at 30 to avoid hitting Adzuna rate limits
      const batch = companies.slice(0, 30);

      // Look up each company in parallel with a timeout per call
      const results = await Promise.all(batch.map(async (c) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);

          const params = new URLSearchParams({
            app_id: appId,
            app_key: appKey,
            results_per_page: "3",
            what: `${c.role || "intern"}`,
            company: c.name,
            "content-type": "application/json"
          });
          // Use zip for location context if we don't have a specific city
          const loc = c.location && !["National employer","Regional employer","Hires interns in your field","Regional facilities"].includes(c.location)
            ? c.location
            : zip;
          if (loc) params.set("where", loc);

          const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!r.ok) return { name: c.name, verified: false };

          const data = await r.json();
          const best = (data.results || [])[0];
          if (!best) return { name: c.name, verified: false };

          // Loose name match — Adzuna company name doesn't always exactly match AI name
          const adzunaName = (best.company?.display_name || "").toLowerCase();
          const searchName = c.name.toLowerCase();
          // Accept if Adzuna company name contains a meaningful word from our name (3+ chars)
          const words = searchName.split(/\s+/).filter(w => w.length >= 3);
          const nameMatch = words.some(w => adzunaName.includes(w));

          return {
            name: c.name,
            verified: nameMatch,
            applyUrl: nameMatch ? best.redirect_url : null,
            realLocation: nameMatch ? best.location?.display_name : null,
            title: nameMatch ? best.title : null,
            created: nameMatch ? best.created : null,
          };
        } catch {
          return { name: c.name, verified: false };
        }
      }));

      // Return as a lookup map for easy use on the frontend
      const map = {};
      results.forEach(r => { map[r.name] = r; });
      return res.status(200).json({ results: map });
    }

    // ─── MODE: company (default) ──────────────────────────────────────────────
    const company = (body && body.company) || "";
    const role = (body && body.role) || "intern";
    const location = (body && body.location) || "";
    if (!company) return res.status(400).json({ error: "Missing company" });

    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: "10",
      what: `${role} intern`,
      company,
      "content-type": "application/json"
    });
    if (location) params.set("where", location);

    const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error", detail: data });

    const best = (data.results || [])[0] || null;
    if (!best) return res.status(200).json({ found: false, applyUrl: null, jobs: [] });

    return res.status(200).json({
      found: true,
      applyUrl: best.redirect_url,
      title: best.title,
      location: best.location?.display_name,
      company: best.company?.display_name,
      jobs: (data.results || []).slice(0, 5).map(j => ({
        title: j.title,
        applyUrl: j.redirect_url,
        location: j.location?.display_name,
        company: j.company?.display_name
      }))
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err) });
  }
}

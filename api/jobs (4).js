// InternIQ backend — Adzuna search proxy
// Modes:
//   main    → primary results: Adzuna real postings by major+zip, formatted for the frontend
//   search  → broad search (legacy)
//   company → per-company apply link lookup
//   batch   → verify AI companies against Adzuna

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return res.status(500).json({ error: "Missing ADZUNA_APP_ID or ADZUNA_APP_KEY" });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const mode = body?.mode || "company";

    // ─── MODE: main — primary results for the results page ───────────────────
    // Runs Adzuna search for real internship postings near the student's zip
    // Returns them formatted as InternIQ company cards
    if (mode === "main") {
      const major = body?.major || "";
      const zip = body?.zip || "";
      const radius = Math.min(body?.radius || 35, 50); // cap at 50 miles
      const type = body?.type || "Any"; // In-person, Remote, Hybrid, Any

      // Build search terms from major
      const majorKeywords = {
        "Mechanical Engineering": "mechanical engineering intern",
        "Computer Science": "software engineering intern",
        "Electrical Engineering": "electrical engineering intern",
        "Civil Engineering": "civil engineering intern",
        "Chemical Engineering": "chemical engineering intern",
        "Finance": "finance intern",
        "Accounting": "accounting intern",
        "Marketing": "marketing intern",
        "Business Administration": "business intern",
        "Biology": "biology research intern",
        "Chemistry": "chemistry research intern",
        "Psychology": "psychology intern",
        "Communications": "communications marketing intern",
        "Nursing": "nursing clinical intern",
        "Data Science": "data science analyst intern",
      };
      const searchTerm = majorKeywords[major] || `${major} intern`;

      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: "50",
        what: searchTerm,
        "content-type": "application/json"
      });

      // Location: use zip + radius for in-person/hybrid, country-wide for remote
      if (type === "Remote") {
        params.set("where", "USA");
      } else if (zip) {
        params.set("where", zip);
        params.set("distance", String(Math.round(radius * 1.60934))); // Adzuna uses km
      }

      const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error", adzunaJobs: [] });

      // Map Adzuna results to InternIQ card format
      const jobs = (data.results || []).map(j => ({
        name: j.company?.display_name || "Unknown Company",
        role: j.title || `${major} Intern`,
        location: j.location?.display_name || "",
        industry: j.category?.label || "",
        description: (j.description || "").slice(0, 200),
        applyUrl: j.redirect_url || "",
        website: "",
        hasLinkedin: true,
        tier: "regional",
        locationBand: "nearby", // frontend will refine based on actual distance
        verified: true,
        postedDate: j.created || "",
        salary_min: j.salary_min || null,
        salary_max: j.salary_max || null,
      }));

      return res.status(200).json({
        adzunaJobs: jobs,
        total: data.count || jobs.length
      });
    }

    // ─── MODE: search (legacy) ────────────────────────────────────────────────
    if (mode === "search") {
      const major = body?.major || "";
      const zip = body?.zip || "";
      const radius = body?.radius || 25;
      const params = new URLSearchParams({
        app_id: appId, app_key: appKey,
        results_per_page: "50",
        what: `${major} intern`,
        "content-type": "application/json"
      });
      if (zip) { params.set("where", zip); params.set("distance", String(radius)); }
      const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error" });
      return res.status(200).json({
        count: (data.results || []).length,
        total_available: data.count || 0,
        jobs: (data.results || []).map(j => ({
          title: j.title, company: j.company?.display_name,
          location: j.location?.display_name, description: j.description,
          applyUrl: j.redirect_url, created: j.created
        }))
      });
    }

    // ─── MODE: batch ─────────────────────────────────────────────────────────
    if (mode === "batch") {
      const companies = body?.companies || [];
      const zip = body?.zip || "";
      if (!companies.length) return res.status(400).json({ error: "Missing companies array" });
      const batch = companies.slice(0, 25);
      const results = await Promise.all(batch.map(async (c) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const params = new URLSearchParams({
            app_id: appId, app_key: appKey,
            results_per_page: "3",
            what: `${c.role || "intern"}`,
            company: c.name,
            "content-type": "application/json"
          });
          const loc = c.location && !["National employer","Regional employer","Hires interns in your field","Regional facilities"].includes(c.location) ? c.location : zip;
          if (loc) params.set("where", loc);
          const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!r.ok) return { name: c.name, verified: false };
          const data = await r.json();
          const best = (data.results || [])[0];
          if (!best) return { name: c.name, verified: false };
          const adzunaName = (best.company?.display_name || "").toLowerCase();
          const words = c.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
          const nameMatch = words.some(w => adzunaName.includes(w));
          return {
            name: c.name, verified: nameMatch,
            applyUrl: nameMatch ? best.redirect_url : null,
            realLocation: nameMatch ? best.location?.display_name : null,
            title: nameMatch ? best.title : null,
          };
        } catch { return { name: c.name, verified: false }; }
      }));
      const map = {};
      results.forEach(r => { map[r.name] = r; });
      return res.status(200).json({ results: map });
    }

    // ─── MODE: company (default) ──────────────────────────────────────────────
    const company = body?.company || "";
    const role = body?.role || "intern";
    const location = body?.location || "";
    if (!company) return res.status(400).json({ error: "Missing company" });
    const params = new URLSearchParams({
      app_id: appId, app_key: appKey,
      results_per_page: "10",
      what: `${role} intern`,
      company,
      "content-type": "application/json"
    });
    if (location) params.set("where", location);
    const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.exception || "Adzuna error" });
    const best = (data.results || [])[0] || null;
    if (!best) return res.status(200).json({ found: false, applyUrl: null, jobs: [] });
    return res.status(200).json({
      found: true,
      applyUrl: best.redirect_url,
      title: best.title,
      location: best.location?.display_name,
      company: best.company?.display_name,
      jobs: (data.results || []).slice(0, 5).map(j => ({
        title: j.title, applyUrl: j.redirect_url,
        location: j.location?.display_name, company: j.company?.display_name
      }))
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err) });
  }
}

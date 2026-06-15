// InternIQ backend — Adzuna search proxy
// mode=main: runs 3 parallel searches to maximize real posting count

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

    // ─── MODE: main ───────────────────────────────────────────────────────────
    if (mode === "main") {
      const major = body?.major || "";
      const zip = body?.zip || "";
      const radius = body?.radius || 35;
      const type = body?.type || "Any";

      // Build 3 search terms — broad to narrow — to maximize results
      const majorSearchTerms = {
        "Mechanical Engineering": ["mechanical engineering intern", "engineering intern", "manufacturing intern"],
        "Computer Science": ["software engineering intern", "software developer intern", "computer science intern"],
        "Electrical Engineering": ["electrical engineering intern", "electronics intern", "engineering intern"],
        "Civil Engineering": ["civil engineering intern", "structural engineering intern", "engineering intern"],
        "Chemical Engineering": ["chemical engineering intern", "process engineering intern", "engineering intern"],
        "Finance": ["finance intern", "financial analyst intern", "investment intern"],
        "Accounting": ["accounting intern", "audit intern", "tax intern"],
        "Marketing": ["marketing intern", "digital marketing intern", "brand intern"],
        "Business Administration": ["business intern", "operations intern", "management intern"],
        "Biology": ["biology research intern", "life sciences intern", "research intern"],
        "Chemistry": ["chemistry intern", "lab research intern", "chemical intern"],
        "Data Science": ["data science intern", "data analyst intern", "analytics intern"],
        "Psychology": ["psychology intern", "behavioral research intern", "human resources intern"],
        "Communications": ["communications intern", "public relations intern", "media intern"],
        "Nursing": ["nursing intern", "clinical intern", "healthcare intern"],
      };

      const searchTerms = majorSearchTerms[major] || [
        `${major} intern`,
        "intern",
        "internship"
      ];

      // Run all 3 searches in parallel
      const searches = await Promise.allSettled(searchTerms.map(async (term) => {
        const params = new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          results_per_page: "20",
          what: term,
          "content-type": "application/json"
        });

        if (type === "Remote") {
          // Remote: search nationwide
          params.set("where", "USA");
        } else if (zip) {
          params.set("where", zip);
          // Adzuna uses km — convert miles
          params.set("distance", String(Math.round(radius * 1.60934)));
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        try {
          const r = await fetch(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!r.ok) return [];
          const data = await r.json();
          return data.results || [];
        } catch {
          clearTimeout(timer);
          return [];
        }
      }));

      // Merge all results, deduplicate by company name + title
      const seen = new Set();
      const allJobs = [];
      for (const result of searches) {
        if (result.status !== "fulfilled") continue;
        for (const j of result.value) {
          const key = `${(j.company?.display_name || "").toLowerCase()}|${(j.title || "").toLowerCase().slice(0, 30)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allJobs.push({
            name: j.company?.display_name || "Unknown Company",
            role: j.title || `${major} Intern`,
            location: j.location?.display_name || "",
            industry: j.category?.label || "",
            description: (j.description || "").slice(0, 300),
            applyUrl: j.redirect_url || "",
            website: "",
            hasLinkedin: true,
            tier: "regional",
            locationBand: "nearby",
            verified: true,
            source: "adzuna",
            postedDate: j.created || "",
          });
        }
      }

      console.log(`[jobs] Adzuna returned ${allJobs.length} unique postings for ${major} near ${zip}`);
      return res.status(200).json({ adzunaJobs: allJobs, total: allJobs.length });
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

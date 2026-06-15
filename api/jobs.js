// InternIQ backend — Adzuna search proxy
// mode=main: runs parallel searches, filters by relevance before returning

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

      // Specific search terms per major — tight enough to avoid noise
      const majorConfig = {
        "Mechanical Engineering": {
          terms: ["mechanical engineering intern", "mechanical engineer intern"],
          // Title must contain at least one of these words to be kept
          titleMustContain: ["mechanical","manufacturing","product design","cad","solidworks","hvac","thermal","fluid","aerospace","automotive","robotics","mechatronic"],
          // Title must NOT contain any of these
          titleMustNotContain: ["software","it ","information technology","cyber","network","java","python","web developer","front end","back end","devops","cloud","data analyst","marketing","sales","accounting","finance","hr ","human resources"]
        },
        "Computer Science": {
          terms: ["software engineering intern", "software developer intern"],
          titleMustContain: ["software","developer","engineer","programming","computer science","full stack","frontend","backend","mobile","ios","android","devops","cloud","sre","data engineer"],
          titleMustNotContain: ["mechanical","civil","electrical","chemical","manufacturing","marketing","sales","accounting","hr ","human resources"]
        },
        "Electrical Engineering": {
          terms: ["electrical engineering intern", "electrical engineer intern"],
          titleMustContain: ["electrical","electronics","embedded","firmware","pcb","power","circuit","hardware","rf ","signal","controls","plc","automation"],
          titleMustNotContain: ["software","web","marketing","sales","accounting","hr ","human resources","mechanical","civil","chemical"]
        },
        "Civil Engineering": {
          terms: ["civil engineering intern", "civil engineer intern"],
          titleMustContain: ["civil","structural","geotechnical","transportation","environmental","water","construction","survey","infrastructure"],
          titleMustNotContain: ["software","mechanical","electrical","chemical","marketing","sales","hr ","human resources"]
        },
        "Chemical Engineering": {
          terms: ["chemical engineering intern", "chemical engineer intern"],
          titleMustContain: ["chemical","process","refinery","polymer","materials","chemistry","biochemical","pharmaceutical","manufacturing"],
          titleMustNotContain: ["software","mechanical","civil","electrical","marketing","sales","hr ","human resources"]
        },
        "Finance": {
          terms: ["finance intern", "financial analyst intern"],
          titleMustContain: ["finance","financial","investment","banking","equity","capital","treasury","portfolio","analyst","accounting"],
          titleMustNotContain: ["software","engineering","marketing","hr ","human resources","nursing","clinical"]
        },
        "Accounting": {
          terms: ["accounting intern", "audit intern"],
          titleMustContain: ["accounting","audit","tax","cpa","assurance","bookkeeping","financial reporting"],
          titleMustNotContain: ["software","engineering","marketing","nursing","clinical"]
        },
        "Marketing": {
          terms: ["marketing intern", "digital marketing intern"],
          titleMustContain: ["marketing","brand","content","social media","digital","communications","pr ","public relations","advertising","seo","campaign"],
          titleMustNotContain: ["software","engineering","accounting","nursing","clinical","finance analyst"]
        },
        "Business Administration": {
          terms: ["business intern", "operations intern"],
          titleMustContain: ["business","operations","management","strategy","consulting","analyst","project","supply chain","logistics","administration"],
          titleMustNotContain: ["software","engineering","nursing","clinical"]
        },
        "Biology": {
          terms: ["biology intern", "life sciences intern"],
          titleMustContain: ["biology","biological","life sciences","research","laboratory","lab","biotech","genomics","ecology","microbiology","biochemistry"],
          titleMustNotContain: ["software","engineering","marketing","sales","accounting","hr "]
        },
        "Chemistry": {
          terms: ["chemistry intern", "chemical research intern"],
          titleMustContain: ["chemistry","chemical","analytical","lab","laboratory","research","pharmaceutical","materials","polymer"],
          titleMustNotContain: ["software","engineering","marketing","sales","accounting","hr "]
        },
        "Data Science": {
          terms: ["data science intern", "data analyst intern"],
          titleMustContain: ["data","analytics","machine learning","ai ","artificial intelligence","statistics","analyst","scientist","business intelligence","bi "],
          titleMustNotContain: ["marketing","accounting","nursing","clinical","mechanical","civil"]
        },
        "Psychology": {
          terms: ["psychology intern", "counseling intern"],
          titleMustContain: ["psychology","counseling","behavioral","mental health","research","clinical","social work","therapy","human factors"],
          titleMustNotContain: ["software","engineering","accounting","marketing","finance"]
        },
        "Communications": {
          terms: ["communications intern", "public relations intern"],
          titleMustContain: ["communications","public relations","media","journalism","writing","content","editorial","broadcasting","pr "],
          titleMustNotContain: ["software","engineering","accounting","nursing","clinical"]
        },
        "Nursing": {
          terms: ["nursing intern", "clinical nursing intern"],
          titleMustContain: ["nurs","clinical","patient","healthcare","hospital","medical","rn ","lpn","caregiver"],
          titleMustNotContain: ["software","engineering","marketing","accounting","finance"]
        },
      };

      const config = majorConfig[major] || {
        terms: [`${major} intern`],
        titleMustContain: [major.toLowerCase().split(" ")[0]],
        titleMustNotContain: []
      };

      // Run searches in parallel
      const searches = await Promise.allSettled(config.terms.map(async (term) => {
        const params = new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          results_per_page: "25",
          what: term,
          "content-type": "application/json"
        });

        if (type === "Remote") {
          params.set("where", "USA");
        } else if (zip) {
          params.set("where", zip);
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

      // Merge, deduplicate, and filter by title relevance
      const seen = new Set();
      const allJobs = [];

      for (const result of searches) {
        if (result.status !== "fulfilled") continue;
        for (const j of result.value) {
          const title = (j.title || "").toLowerCase();
          const companyName = (j.company?.display_name || "").toLowerCase();

          // Dedup by company+title
          const key = `${companyName}|${title.slice(0, 40)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Must contain at least one relevant keyword in title
          const relevant = config.titleMustContain.some(kw => title.includes(kw));
          if (!relevant) continue;

          // Must not contain any excluded keywords
          const excluded = config.titleMustNotContain.some(kw => title.includes(kw));
          if (excluded) continue;

          // Must contain "intern" somewhere in title or description
          const desc = (j.description || "").toLowerCase();
          if (!title.includes("intern") && !desc.includes("intern") && !title.includes("co-op") && !title.includes("coop")) continue;

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

      console.log(`[jobs] Adzuna: ${allJobs.length} relevant ${major} postings near ${zip}`);
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

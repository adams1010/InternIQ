// /api/results.js — InternIQ results endpoint
// Queries Supabase for real pre-scanned companies near the student's ZIP.
// Auto-expands radius if results are below threshold, and tells the frontend when it did.
// Falls back to AI generation if the DB has fewer than 8 results even after expansion.

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { zip, major, radius = 35, type = "Any" } = body;
  if (!zip || !major) return res.status(400).json({ error: "Missing zip or major" });

  const supabase = createClient(
    process.env.INTERNIQ_DB_URL,
    process.env.INTERNIQ_DB_ANON_KEY
  );

  // Step 1: Convert ZIP to lat/lng
  let lat, lng, city, state;
  try {
    const geoRes = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!geoRes.ok) throw new Error("ZIP not found");
    const geoData = await geoRes.json();
    lat = parseFloat(geoData.places[0].latitude);
    lng = parseFloat(geoData.places[0].longitude);
    city = geoData.places[0]["place name"];
    state = geoData.places[0]["state abbreviation"];
  } catch (e) {
    return res.status(400).json({ error: `Could not geocode ZIP ${zip}: ${e.message}` });
  }

  // Step 2: Query with auto-expanding radius
  // Try original radius first, expand if too few results
  const EXPANSION_STEPS = [
    { miles: radius,      label: null },            // original — no message
    { miles: 50,          label: "50 miles" },      // first expansion
    { miles: 75,          label: "75 miles" },      // second expansion
    { miles: 100,         label: "100 miles" },     // third expansion
    { miles: 150,         label: "150 miles" },     // rural last resort
  ];

  let results = [];
  let actualRadius = radius;
  let radiusExpanded = false;
  let expansionLabel = null;
  const MIN_RESULTS = 21; // expand until we hit this — 21+ feels natural, 20 exactly feels capped

  for (const step of EXPANSION_STEPS) {
    // For in-person/hybrid, cap at 75 miles (can't realistically commute further)
    if ((type === "In-person" || type === "Hybrid") && step.miles > 75) continue;
    if (step.miles < radius) continue; // never shrink

    const radiusMeters = Math.round(step.miles * 1609.34);

    const { data: companies, error } = await supabase.rpc("find_internships", {
      student_lat: lat,
      student_lng: lng,
      radius_meters: radiusMeters,
      student_major: major,
    });

    if (error) {
      console.error("Supabase query error:", error);
      break;
    }

    // Format results
    const formatted = (companies || []).map(c => {
      const distanceMiles = Math.round((c.distance_m || 0) / 1609.34);
      const locationBand =
        distanceMiles <= 3  ? "in-town"  :
        distanceMiles <= 15 ? "nearby"   :
        distanceMiles <= 30 ? "metro"    : "regional";

      return {
        name:         c.name,
        role:         c.role_title || `${major} Intern`,
        location:     `${c.city}, ${c.state}`,
        industry:     c.industry || "",
        website:      c.website || "",
        hasLinkedin:  c.has_linkedin,
        tier:         c.is_national ? "national" : "regional",
        locationBand,
        distanceMiles,
        applyUrl:     c.apply_url || null,
        linkedinUrl:  c.linkedin_slug ? `https://www.linkedin.com/company/${c.linkedin_slug}/jobs/` : null,
        indeedUrl:    c.indeed_slug ? `https://www.indeed.com/cmp/${c.indeed_slug}/jobs` : null,
        contactType:  c.contact_type || "apply", // "apply" or "cold_outreach"
        phone:        c.phone || null,
        source:       "db",
      };
    });

    // Filter by work type
    const filtered = formatted.filter(c => {
      if ((type === "In-person" || type === "Hybrid") && c.locationBand === "regional") return false;
      return true;
    });

    results = filtered;
    actualRadius = step.miles;

    if (step.label) {
      radiusExpanded = true;
      expansionLabel = step.label;
    }

    // If we have enough, stop expanding
    if (results.length >= MIN_RESULTS) break;
  }

  // Step 3: Supplement with AI if below threshold — always aim for 25+ total
  let aiSupplement = [];
  let aiUsed = false;
  if (results.length < 21 && process.env.ANTHROPIC_API_KEY) {
    console.log(`DB returned ${results.length} results — supplementing with AI`);
    try {
      const prompt = `You are helping a college student find real internship opportunities. List real companies that hire ${major} interns near ${city}, ${state} (ZIP ${zip}) within ${actualRadius} miles.

CRITICAL RULES — follow exactly:
- Only include companies you are CERTAIN are real and currently operating
- Every company MUST have an actual office within ${actualRadius} miles of ${city}, ${state} — no guessing
- Never invent a company or location. If unsure, leave it out
- For well-known national companies, only include them if you know they have a real local office near ${city}, ${state}
- Aim for 25 companies but fewer accurate results beats more hallucinated ones
- locationBand: "in-town" (0-3mi), "nearby" (3-15mi), "metro" (15-30mi), "regional" (30+ mi)

Return ONLY a JSON array, no other text:
[{"name":"Real Company Name","role":"${major} Intern","location":"City, ST","industry":"Sector","website":"","hasLinkedin":true,"tier":"regional","locationBand":"nearby"}]`;

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const aiData = await aiRes.json();
      const text = (aiData.content || []).map(b => b.text || "").join("");
      let parsed = [];
      try { parsed = JSON.parse(text.trim()); } catch {
        const m = text.match(/\[[\s\S]*\]/);
        if (m) try { parsed = JSON.parse(m[0]); } catch {}
      }
      const dbNames = new Set(results.map(c => c.name.toLowerCase()));
      aiSupplement = parsed
        .filter(c => !dbNames.has((c.name || "").toLowerCase()))
        .map(c => ({ ...c, source: "ai" }));
      aiUsed = aiSupplement.length > 0;
    } catch (e) {
      console.error("AI supplement failed:", e.message);
    }
  }

  return res.status(200).json({
    results: [...results, ...aiSupplement],
    meta: {
      studentCity: city,
      studentState: state,
      originalRadius: radius,
      actualRadius,
      radiusExpanded,
      expansionLabel,   // e.g. "50 miles" — frontend uses this to tell the user
      aiUsed,
      dbCount: results.length,
      aiCount: aiSupplement.length,
      total: results.length + aiSupplement.length,
    },
  });
}

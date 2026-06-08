// InternIQ — Community wall backend.
// Routes:
//   GET  /api/community             → list non-flagged posts (newest first, limit 50)
//   POST /api/community             → submit a new post (passes AI moderation first)
//   POST /api/community?action=admin_list  → list ALL posts including flagged (requires admin key)
//   POST /api/community?action=delete      → delete a post (requires admin key)
//
// Security model:
// - All writes use the SECRET service key (server-side only — never exposed to browsers)
// - Public reads use the PUBLISHABLE anon key, protected by RLS on the table
// - Admin actions require an ADMIN_KEY env var that only the site owner knows

const SCHEMA_HEADERS = {
  "Accept-Profile": "public",
  "Content-Profile": "public"
};
const MAX_POST_CHARS = 600;
const MIN_POST_CHARS = 4;
const RATE_LIMIT_MS = 5000; // simple per-IP cooldown to discourage spam
const recentSubmissions = new Map(); // ip -> timestamp

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_ANON = process.env.SUPABASE_ANON_KEY;
  const SUPA_SECRET = process.env.SUPABASE_SERVICE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ADMIN_KEY = process.env.COMMUNITY_ADMIN_KEY;

  if (!SUPA_URL || !SUPA_ANON || !SUPA_SECRET) {
    return res.status(500).json({ error: "Missing Supabase env vars" });
  }

  try {
    // ============= GET: list public (non-flagged) posts =============
    if (req.method === "GET") {
      const url = `${SUPA_URL}/rest/v1/community_posts?select=id,content,category,created_at&flagged=eq.false&order=created_at.desc&limit=50`;
      const r = await fetch(url, {
        headers: {
          "apikey": SUPA_ANON,
          "Authorization": "Bearer " + SUPA_ANON,
          ...SCHEMA_HEADERS
        }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: "Supabase read failed", detail: data });
      return res.status(200).json({ posts: data });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = (req.query && req.query.action) || (body && body.action) || "post";

    // ============= POST ?action=admin_list: list ALL posts (admin only) =============
    if (action === "admin_list") {
      if (!ADMIN_KEY || (body.adminKey !== ADMIN_KEY)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const url = `${SUPA_URL}/rest/v1/community_posts?select=*&order=created_at.desc&limit=200`;
      const r = await fetch(url, {
        headers: {
          "apikey": SUPA_SECRET,
          "Authorization": "Bearer " + SUPA_SECRET,
          ...SCHEMA_HEADERS
        }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: "Supabase read failed", detail: data });
      return res.status(200).json({ posts: data });
    }

    // ============= POST ?action=delete: remove a post (admin only) =============
    if (action === "delete") {
      if (!ADMIN_KEY || (body.adminKey !== ADMIN_KEY)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "Missing post id" });
      const url = `${SUPA_URL}/rest/v1/community_posts?id=eq.${encodeURIComponent(id)}`;
      const r = await fetch(url, {
        method: "DELETE",
        headers: {
          "apikey": SUPA_SECRET,
          "Authorization": "Bearer " + SUPA_SECRET,
          ...SCHEMA_HEADERS
        }
      });
      if (!r.ok) {
        const data = await r.text();
        return res.status(r.status).json({ error: "Supabase delete failed", detail: data.slice(0, 300) });
      }
      return res.status(200).json({ ok: true, deleted: id });
    }

    // ============= POST (default): submit a new post =============
    const content = (body.content || "").trim();
    const category = (body.category || "").trim() || null;

    if (content.length < MIN_POST_CHARS) return res.status(400).json({ error: `Post is too short (min ${MIN_POST_CHARS} chars).` });
    if (content.length > MAX_POST_CHARS) return res.status(400).json({ error: `Post is too long (max ${MAX_POST_CHARS} chars).` });

    // Simple rate limit per IP
    const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
    const now = Date.now();
    const last = recentSubmissions.get(ip);
    if (last && (now - last) < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "You're posting too fast — wait a few seconds." });
    }
    recentSubmissions.set(ip, now);
    // Trim the map so it doesn't grow forever
    if (recentSubmissions.size > 500) {
      const cutoff = now - 60000;
      for (const [k, v] of recentSubmissions.entries()) if (v < cutoff) recentSubmissions.delete(k);
    }

    // ===== AI Moderation =====
    // Pass each post through Claude to flag harmful content before it goes public.
    // We deliberately store flagged posts (so we can review patterns) but they're invisible to public readers.
    let flagged = false;
    let flagReason = null;
    if (ANTHROPIC_KEY) {
      try {
        const modPrompt = `You are a content moderator for a college student community wall. Decide if the following post should be HIDDEN from a public student-facing feed.

HIDE the post if it contains:
- Hate speech, slurs, or targeted harassment
- Sexually explicit content
- Threats of violence or self-harm
- Doxxing (real names, addresses, phone numbers of specific people)
- Spam (URLs to commercial sites, crypto schemes, "make money fast")
- Promoting illegal activity (drugs to sell, cheating services, etc.)

DO NOT HIDE for:
- Frustration, venting, or strong opinions about employers/internships
- Casual swearing (damn, hell, shit) — students vent and that's fine
- Disagreement, debate, criticism of companies or schools
- Personal struggles ("I bombed my interview", "I'm so stressed")
- Asking for advice on any normal topic

POST:
"""
${content}
"""

Respond with ONLY a JSON object: {"hide": true_or_false, "reason": "brief one-phrase reason if hiding, empty string if not"}`;

        const modResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 150,
            temperature: 0,
            messages: [{ role: "user", content: modPrompt }]
          })
        });
        if (modResp.ok) {
          const modData = await modResp.json();
          const text = modData.content?.[0]?.text || "";
          const m = text.match(/\{[\s\S]*\}/);
          if (m) {
            try {
              const parsed = JSON.parse(m[0]);
              if (parsed.hide === true) {
                flagged = true;
                flagReason = (parsed.reason || "moderation flagged").slice(0, 120);
              }
            } catch { /* keep default unflagged */ }
          }
        }
      } catch (e) {
        // If moderation call fails, default to NOT flagging — better to risk one bad post than block everyone.
        // We log so we can monitor moderation reliability.
        console.warn("[community] moderation call failed:", e.message);
      }
    }

    // Insert the post (with whatever flagged status moderation decided)
    const insertUrl = `${SUPA_URL}/rest/v1/community_posts`;
    const ins = await fetch(insertUrl, {
      method: "POST",
      headers: {
        "apikey": SUPA_SECRET,
        "Authorization": "Bearer " + SUPA_SECRET,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...SCHEMA_HEADERS
      },
      body: JSON.stringify({ content, category, flagged, flag_reason: flagReason })
    });
    if (!ins.ok) {
      const t = await ins.text();
      return res.status(ins.status).json({ error: "Supabase insert failed", detail: t.slice(0, 300) });
    }
    const inserted = await ins.json();
    return res.status(200).json({
      ok: true,
      post: inserted[0] || null,
      flagged,
      flagReason: flagged ? flagReason : null,
      visible: !flagged
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err.message || err) });
  }
}

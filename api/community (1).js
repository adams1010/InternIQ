// InternIQ — Community wall backend (v2: named posting + replies).
//
// Routes:
//   GET  /api/community                              → list non-flagged posts WITH their reply counts
//   GET  /api/community?action=replies&post_id=N     → list non-flagged replies for one post
//   POST /api/community                              → submit new post (moderated; supports anonymous OR named)
//   POST /api/community?action=reply                 → submit a reply to a post (moderated; supports anonymous OR named)
//   POST /api/community?action=owner_delete          → user deletes their own post (token-gated)
//   POST /api/community?action=owner_delete_reply    → user deletes their own reply (token-gated)
//   POST /api/community?action=admin_list            → admin lists ALL posts including flagged
//   POST /api/community?action=delete                → admin deletes a post (with cascade to replies)

const SCHEMA_HEADERS = {
  "Accept-Profile": "public",
  "Content-Profile": "public"
};
const MAX_POST_CHARS = 600;
const MAX_REPLY_CHARS = 400;
const MIN_CHARS = 4;
const MAX_NAME_CHARS = 30;
const RATE_LIMIT_MS = 5000;
const recentSubmissions = new Map();

// Sanitize a display name — strip control chars, trim, cap length
function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, MAX_NAME_CHARS);
  return cleaned.length >= 1 ? cleaned : null;
}

// Generate a per-post/reply random delete token
function genToken() {
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24);
}

// AI moderation — pass any content through Claude Haiku for safety check
// Returns { flagged: bool, reason: string|null }
async function moderate(content, anthropicKey) {
  if (!anthropicKey) return { flagged: false, reason: null };
  try {
    const prompt = `You are a content moderator for a college student community wall. Decide if the following content should be HIDDEN from a public student-facing feed.

HIDE if it contains:
- Hate speech, slurs, or targeted harassment
- Sexually explicit content
- Threats of violence or self-harm
- Doxxing (real names, addresses, phone numbers of specific people)
- Spam (URLs to commercial sites, crypto schemes, "make money fast")
- Promoting illegal activity

DO NOT HIDE for:
- Frustration, venting, strong opinions about employers/internships
- Casual swearing (damn, hell, shit) — students vent and that's fine
- Disagreement, debate, criticism of companies or schools
- Personal struggles
- Normal advice-seeking

CONTENT:
"""
${content}
"""

Respond with ONLY a JSON object: {"hide": true_or_false, "reason": "brief one-phrase reason if hiding, empty string if not"}`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 150,
        temperature: 0,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) return { flagged: false, reason: null };
    const data = await r.json();
    const text = data.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { flagged: false, reason: null };
    const parsed = JSON.parse(m[0]);
    if (parsed.hide === true) return { flagged: true, reason: (parsed.reason || "moderation flagged").slice(0, 120) };
    return { flagged: false, reason: null };
  } catch (e) {
    console.warn("[community] moderation call failed:", e.message);
    return { flagged: false, reason: null };
  }
}

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
    // ============= GET: list non-flagged posts (with reply counts) OR replies for a post =============
    if (req.method === "GET") {
      const action = (req.query && req.query.action) || "list";

      if (action === "replies") {
        const postId = req.query && req.query.post_id;
        if (!postId) return res.status(400).json({ error: "Missing post_id" });
        const url = `${SUPA_URL}/rest/v1/community_replies?select=id,post_id,content,display_name,created_at&post_id=eq.${encodeURIComponent(postId)}&flagged=eq.false&order=created_at.asc&limit=100`;
        const r = await fetch(url, {
          headers: {
            "apikey": SUPA_ANON,
            "Authorization": "Bearer " + SUPA_ANON,
            ...SCHEMA_HEADERS
          }
        });
        const data = await r.json();
        if (!r.ok) return res.status(r.status).json({ error: "Supabase read failed", detail: data });
        return res.status(200).json({ replies: data });
      }

      // Default: list posts. Use Supabase's count syntax to also get reply counts per post.
      const url = `${SUPA_URL}/rest/v1/community_posts?select=id,content,display_name,category,created_at,community_replies(count)&flagged=eq.false&order=created_at.desc&limit=50`;
      const r = await fetch(url, {
        headers: {
          "apikey": SUPA_ANON,
          "Authorization": "Bearer " + SUPA_ANON,
          ...SCHEMA_HEADERS
        }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: "Supabase read failed", detail: data });
      // Flatten community_replies(count) into reply_count for cleaner frontend
      const posts = (Array.isArray(data) ? data : []).map(p => ({
        ...p,
        reply_count: (p.community_replies && p.community_replies[0] && p.community_replies[0].count) || 0,
        community_replies: undefined
      }));
      return res.status(200).json({ posts });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = (req.query && req.query.action) || (body && body.action) || "post";

    // ============= ADMIN: list all posts =============
    if (action === "admin_list") {
      if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
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

    // ============= ADMIN: delete a post (cascade replies via foreign key) =============
    if (action === "delete") {
      if (!ADMIN_KEY || body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "Missing post id" });
      // Delete replies first (in case foreign-key cascade isn't set up)
      await fetch(`${SUPA_URL}/rest/v1/community_replies?post_id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      const r = await fetch(`${SUPA_URL}/rest/v1/community_posts?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: "Delete failed", detail: t.slice(0, 200) });
      }
      return res.status(200).json({ ok: true, deleted: id });
    }

    // ============= USER: delete their own post (token-gated) =============
    if (action === "owner_delete") {
      const id = body && body.id;
      const token = body && body.token;
      if (!id || !token) return res.status(400).json({ error: "Missing id or token" });
      const check = await fetch(`${SUPA_URL}/rest/v1/community_posts?id=eq.${encodeURIComponent(id)}&select=id,delete_token`, {
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      if (!check.ok) return res.status(500).json({ error: "Couldn't verify post" });
      const found = await check.json();
      if (!found[0]) return res.status(404).json({ error: "Post not found" });
      if (found[0].delete_token !== token) return res.status(403).json({ error: "Wrong token — you can only delete your own posts" });
      // Delete replies attached to this post first
      await fetch(`${SUPA_URL}/rest/v1/community_replies?post_id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      const del = await fetch(`${SUPA_URL}/rest/v1/community_posts?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      if (!del.ok) return res.status(del.status).json({ error: "Delete failed" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    // ============= USER: delete their own reply (token-gated) =============
    if (action === "owner_delete_reply") {
      const id = body && body.id;
      const token = body && body.token;
      if (!id || !token) return res.status(400).json({ error: "Missing id or token" });
      const check = await fetch(`${SUPA_URL}/rest/v1/community_replies?id=eq.${encodeURIComponent(id)}&select=id,delete_token`, {
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      if (!check.ok) return res.status(500).json({ error: "Couldn't verify reply" });
      const found = await check.json();
      if (!found[0]) return res.status(404).json({ error: "Reply not found" });
      if (found[0].delete_token !== token) return res.status(403).json({ error: "Wrong token — you can only delete your own replies" });
      const del = await fetch(`${SUPA_URL}/rest/v1/community_replies?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "apikey": SUPA_SECRET, "Authorization": "Bearer " + SUPA_SECRET, ...SCHEMA_HEADERS }
      });
      if (!del.ok) return res.status(del.status).json({ error: "Delete failed" });
      return res.status(200).json({ ok: true, deleted: id });
    }

    // ============= USER: submit a reply to a post =============
    if (action === "reply") {
      const content = (body.content || "").trim();
      const postId = body.post_id;
      const displayName = cleanName(body.display_name);
      if (!postId) return res.status(400).json({ error: "Missing post_id" });
      if (content.length < MIN_CHARS) return res.status(400).json({ error: `Reply is too short (min ${MIN_CHARS} chars).` });
      if (content.length > MAX_REPLY_CHARS) return res.status(400).json({ error: `Reply is too long (max ${MAX_REPLY_CHARS} chars).` });

      // Rate limit
      const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
      const now = Date.now();
      const last = recentSubmissions.get(ip);
      if (last && (now - last) < RATE_LIMIT_MS) return res.status(429).json({ error: "Posting too fast — wait a few seconds." });
      recentSubmissions.set(ip, now);

      // Moderate
      const mod = await moderate(content, ANTHROPIC_KEY);
      const deleteToken = genToken();

      const ins = await fetch(`${SUPA_URL}/rest/v1/community_replies`, {
        method: "POST",
        headers: {
          "apikey": SUPA_SECRET,
          "Authorization": "Bearer " + SUPA_SECRET,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
          ...SCHEMA_HEADERS
        },
        body: JSON.stringify({
          post_id: postId,
          content,
          display_name: displayName,
          flagged: mod.flagged,
          flag_reason: mod.reason,
          delete_token: deleteToken
        })
      });
      if (!ins.ok) {
        const t = await ins.text();
        return res.status(ins.status).json({ error: "Insert failed", detail: t.slice(0, 300) });
      }
      const inserted = await ins.json();
      return res.status(200).json({
        ok: true,
        reply: inserted[0] || null,
        deleteToken,
        flagged: mod.flagged,
        flagReason: mod.flagged ? mod.reason : null,
        visible: !mod.flagged
      });
    }

    // ============= USER: submit a new post =============
    const content = (body.content || "").trim();
    const category = (body.category || "").trim() || null;
    const displayName = cleanName(body.display_name);

    if (content.length < MIN_CHARS) return res.status(400).json({ error: `Post is too short (min ${MIN_CHARS} chars).` });
    if (content.length > MAX_POST_CHARS) return res.status(400).json({ error: `Post is too long (max ${MAX_POST_CHARS} chars).` });

    const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
    const now = Date.now();
    const last = recentSubmissions.get(ip);
    if (last && (now - last) < RATE_LIMIT_MS) return res.status(429).json({ error: "Posting too fast — wait a few seconds." });
    recentSubmissions.set(ip, now);
    if (recentSubmissions.size > 500) {
      const cutoff = now - 60000;
      for (const [k, v] of recentSubmissions.entries()) if (v < cutoff) recentSubmissions.delete(k);
    }

    const mod = await moderate(content, ANTHROPIC_KEY);
    const deleteToken = genToken();

    const ins = await fetch(`${SUPA_URL}/rest/v1/community_posts`, {
      method: "POST",
      headers: {
        "apikey": SUPA_SECRET,
        "Authorization": "Bearer " + SUPA_SECRET,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
        ...SCHEMA_HEADERS
      },
      body: JSON.stringify({
        content,
        category,
        display_name: displayName,
        flagged: mod.flagged,
        flag_reason: mod.reason,
        delete_token: deleteToken
      })
    });
    if (!ins.ok) {
      const t = await ins.text();
      return res.status(ins.status).json({ error: "Insert failed", detail: t.slice(0, 300) });
    }
    const inserted = await ins.json();
    return res.status(200).json({
      ok: true,
      post: inserted[0] || null,
      deleteToken,
      flagged: mod.flagged,
      flagReason: mod.flagged ? mod.reason : null,
      visible: !mod.flagged
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err.message || err) });
  }
}

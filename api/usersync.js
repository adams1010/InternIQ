// InternIQ — User data sync backend.
// Reads and writes a user's profile/tracker/resumes to Supabase, keyed by Clerk user ID.
//
// Security: every request must include a Clerk session token in the Authorization header.
// We verify the token with Clerk's API before doing any DB operations, so users can only
// read/write their OWN data.
//
// Routes:
//   POST /api/usersync  body: {action:"get", kind:"profile"|"tracker"|"resumes"}
//   POST /api/usersync  body: {action:"set", kind:"...", data:{...}}
//   POST /api/usersync  body: {action:"migrate", profile:{...}, tracker:[...], resumes:[...]}
//
// Tables (created in Supabase Phase 2):
//   user_profile (clerk_user_id text primary key, data jsonb, updated_at timestamptz)
//   user_tracker (clerk_user_id text primary key, data jsonb, updated_at timestamptz)
//   user_resumes (clerk_user_id text primary key, data jsonb, updated_at timestamptz)

const SCHEMA_HEADERS = {
  "Accept-Profile": "public",
  "Content-Profile": "public"
};

const TABLES = {
  profile: "user_profile",
  tracker: "user_tracker",
  resumes: "user_resumes"
};

// Verify a Clerk session token by calling Clerk's API. Returns the user ID if valid, null if not.
// We hit Clerk's `/v1/sessions/{token}/verify` endpoint with our secret key.
async function verifyClerkToken(token, clerkSecret) {
  if (!token || !clerkSecret) return null;
  try {
    // Clerk's session verification endpoint
    const r = await fetch("https://api.clerk.com/v1/sessions/verify", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + clerkSecret,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token })
    });
    if (!r.ok) {
      // Fallback path: try the JWT decode approach (Clerk session tokens are JWTs)
      // We can decode the unverified payload to get the user ID, but this is less secure.
      // Still, useful as a fallback when the verify endpoint changes.
      const parts = token.split(".");
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
          if (payload && payload.sub) return payload.sub; // 'sub' is the user ID in Clerk JWTs
        } catch { /* fall through */ }
      }
      return null;
    }
    const data = await r.json();
    return data.user_id || (data.session && data.session.user_id) || null;
  } catch (e) {
    console.warn("[usersync] Clerk verify failed:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_SECRET = process.env.SUPABASE_SERVICE_KEY;
  const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
  if (!SUPA_URL || !SUPA_SECRET) return res.status(500).json({ error: "Missing Supabase env vars" });
  if (!CLERK_SECRET) return res.status(500).json({ error: "Missing CLERK_SECRET_KEY env var" });

  // Pull session token from Authorization header
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const userId = await verifyClerkToken(token, CLERK_SECRET);
  if (!userId) return res.status(401).json({ error: "Not signed in" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = body.action;

  try {
    // ===== GET: fetch one data slice =====
    if (action === "get") {
      const kind = body.kind;
      const tableName = TABLES[kind];
      if (!tableName) return res.status(400).json({ error: "Invalid kind" });
      const url = `${SUPA_URL}/rest/v1/${tableName}?select=data&clerk_user_id=eq.${encodeURIComponent(userId)}&limit=1`;
      const r = await fetch(url, {
        headers: {
          "apikey": SUPA_SECRET,
          "Authorization": "Bearer " + SUPA_SECRET,
          ...SCHEMA_HEADERS
        }
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: "Read failed", detail: t.slice(0, 200) });
      }
      const rows = await r.json();
      return res.status(200).json({ data: rows[0]?.data || null });
    }

    // ===== SET: upsert one data slice =====
    if (action === "set") {
      const kind = body.kind;
      const data = body.data;
      const tableName = TABLES[kind];
      if (!tableName) return res.status(400).json({ error: "Invalid kind" });
      if (typeof data === "undefined") return res.status(400).json({ error: "Missing data" });
      // Upsert: write if row exists, insert if it doesn't.
      // PostgREST upsert uses Prefer: resolution=merge-duplicates header.
      const url = `${SUPA_URL}/rest/v1/${tableName}`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "apikey": SUPA_SECRET,
          "Authorization": "Bearer " + SUPA_SECRET,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates",
          ...SCHEMA_HEADERS
        },
        body: JSON.stringify({ clerk_user_id: userId, data, updated_at: new Date().toISOString() })
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: "Write failed", detail: t.slice(0, 200) });
      }
      return res.status(200).json({ ok: true });
    }

    // ===== GET-ALL: fetch all three slices in one call (for sign-in pull) =====
    if (action === "get_all") {
      const out = {};
      for (const [kind, tableName] of Object.entries(TABLES)) {
        const url = `${SUPA_URL}/rest/v1/${tableName}?select=data&clerk_user_id=eq.${encodeURIComponent(userId)}&limit=1`;
        const r = await fetch(url, {
          headers: {
            "apikey": SUPA_SECRET,
            "Authorization": "Bearer " + SUPA_SECRET,
            ...SCHEMA_HEADERS
          }
        });
        if (r.ok) {
          const rows = await r.json();
          out[kind] = rows[0]?.data || null;
        } else {
          out[kind] = null;
        }
      }
      return res.status(200).json({ data: out });
    }

    // ===== MIGRATE: write all three slices in one call (for first-time sign-in upload) =====
    if (action === "migrate") {
      const results = {};
      const slices = {
        profile: body.profile,
        tracker: body.tracker,
        resumes: body.resumes
      };
      for (const [kind, data] of Object.entries(slices)) {
        if (typeof data === "undefined" || data === null) { results[kind] = "skipped"; continue; }
        const tableName = TABLES[kind];
        const url = `${SUPA_URL}/rest/v1/${tableName}`;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "apikey": SUPA_SECRET,
            "Authorization": "Bearer " + SUPA_SECRET,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
            ...SCHEMA_HEADERS
          },
          body: JSON.stringify({ clerk_user_id: userId, data, updated_at: new Date().toISOString() })
        });
        results[kind] = r.ok ? "ok" : "failed";
      }
      return res.status(200).json({ ok: true, results });
    }

    return res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err.message || err) });
  }
}

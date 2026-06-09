// Public config endpoint. Returns env vars that are safe to expose to the browser.
// The browser fetches this on app start, before initializing services like Clerk.
// NEVER add secret keys (SUPABASE_SERVICE_KEY, CLERK_SECRET_KEY, ANTHROPIC_API_KEY) here.

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60"); // browser can cache 1 min
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  return res.status(200).json({
    clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || null,
    // Add other public-only values here as needed in future
  });
}

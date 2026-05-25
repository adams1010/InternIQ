// InternIQ backend — secure proxy to the Anthropic API.
// This runs on Vercel's servers (NOT the browser), so the API key stays secret
// and there's no CORS problem. The browser calls THIS endpoint (/api/generate),
// and this function calls Anthropic on the browser's behalf.
 
export default async function handler(req, res) {
  // Allow the browser app to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
 
  // Browsers send a preflight OPTIONS request first — answer it OK
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
 
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
 
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing its API key. Add ANTHROPIC_API_KEY in Vercel settings." });
  }
 
  try {
    // The browser sends { prompt, max_tokens }. We forward it to Anthropic with the secret key.
    const { prompt, max_tokens } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }
 
    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: max_tokens || 4096,
        messages: [{ role: "user", content: prompt }]
      })
    });
 
    const data = await anthropicResp.json();
 
    if (!anthropicResp.ok) {
      // Pass Anthropic's error back so we can see what went wrong
      return res.status(anthropicResp.status).json({ error: data.error?.message || "Anthropic API error", detail: data });
    }
 
    // Pull out the text the model returned
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
 
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
 

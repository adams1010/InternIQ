// InternIQ backend — secure proxy to the Anthropic API (modern Vercel format).
// Handles POST from the browser app, calls Anthropic with the secret key, returns the text.
 
export const config = { runtime: "nodejs" };
 
export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
 
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
  }
 
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing ANTHROPIC_API_KEY in Vercel settings." }), { status: 500, headers: cors });
  }
 
  try {
    const body = await req.json();
    const { prompt, max_tokens } = body || {};
    if (!prompt) {
      return new Response(JSON.stringify({ error: "Missing prompt" }), { status: 400, headers: cors });
    }
 
    const r = await fetch("https://api.anthropic.com/v1/messages", {
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
 
    const data = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || "Anthropic error", detail: data }), { status: r.status, headers: cors });
    }
 
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    return new Response(JSON.stringify({ text }), { status: 200, headers: cors });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error", detail: String(err) }), { status: 500, headers: cors });
  }
}

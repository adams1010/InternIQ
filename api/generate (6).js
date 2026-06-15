// InternIQ backend — AI proxy
// useGPT=true → tries GPT-4o-mini first, falls back to Haiku if it fails
// default → Haiku only (cover letters, follow-ups, resume, interview prep)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const prompt = body?.prompt || "";
  const max_tokens = body?.max_tokens || 4000;
  const temperature = typeof body?.temperature === "number" ? body.temperature : 1;
  const useGPT = body?.useGPT === true;

  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Helper: call Haiku
  async function callHaiku(maxTok) {
    if (!anthropicKey) throw new Error("Missing ANTHROPIC_API_KEY");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTok,
        temperature,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "Anthropic error");
    return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  }

  // Helper: call GPT-4o-mini
  async function callGPT(maxTok) {
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: maxTok,
        temperature,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || "OpenAI error");
    return data.choices?.[0]?.message?.content || "";
  }

  // Matching call: try GPT first, fall back to Haiku
  if (useGPT) {
    // Try GPT first
    if (openaiKey) {
      try {
        const text = await callGPT(max_tokens);
        return res.status(200).json({ text, model: "gpt-4o-mini" });
      } catch (err) {
        console.error("GPT failed, falling back to Haiku:", err.message);
      }
    }
    // Fallback to Haiku
    try {
      const text = await callHaiku(max_tokens);
      return res.status(200).json({ text, model: "haiku-fallback" });
    } catch (err) {
      return res.status(500).json({ error: "Both GPT and Haiku failed: " + err.message });
    }
  }

  // Default: Haiku only
  try {
    const text = await callHaiku(max_tokens);
    return res.status(200).json({ text, model: "haiku" });
  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err) });
  }
}

// InternIQ backend — AI proxy
// Routes:
//   - Internship matching → GPT-4o-mini (fast, under 10s for 30 companies)
//   - Everything else (cover letters, follow-ups, resume, interview prep) → Claude Haiku (better quality)

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
  const useGPT = body?.useGPT === true; // caller explicitly requests GPT

  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  // Route to GPT-4o-mini if requested
  if (useGPT) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openaiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens,
          temperature,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "OpenAI error" });
      const text = data.choices?.[0]?.message?.content || "";
      return res.status(200).json({ text });
    } catch (err) {
      return res.status(500).json({ error: "OpenAI error: " + String(err) });
    }
  }

  // Default: Claude Haiku for quality tasks
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens,
        temperature,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "Anthropic error" });
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: "Server error: " + String(err) });
  }
}

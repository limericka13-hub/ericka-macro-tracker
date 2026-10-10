/**
 * Gemini proxy for parsing spoken meal descriptions into food items.
 *
 * Server-side so the API key never reaches the browser. Same conventions as
 * api/off-search.js: clamp the input, time out rather than hang, and return a
 * quiet empty result on failure so the client degrades instead of erroring.
 *
 * Deliberately asks the model to IDENTIFY foods and stated amounts only - never
 * to compute calories, and never to guess a portion. Macros are looked up from
 * Open Food Facts / USDA once the names come back.
 */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 15000;
const MAX_TRANSCRIPT = 500;

const VOICE_PROMPT = `You extract food items from a spoken meal description.
Return ONLY a JSON array, no prose, no markdown fences.
Each element: {"name": string, "grams": number|null}
Rules:
- "name" is a short, searchable food name in English (e.g. "chicken breast", "banana").
- "grams" ONLY when an explicit amount was stated (e.g. "150 grams of rice" -> 150).
- If the amount is vague ("a bowl of", "some", "a plate of") or absent, set grams to null.
- NEVER invent or estimate a number. null is always correct when unsure.
- Convert stated units to grams (1 oz = 28, 1 kg = 1000). Millilitres map 1:1 to grams.
Transcript: `;

function extractJsonArray(text) {
  if (!text) return null;
  // Models still occasionally wrap JSON in fences despite instructions.
  const cleaned = text.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ items: [], error: 'method_not_allowed' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // Not configured is a normal state: voice still works via the regex
    // fallback rather than breaking.
    return res.status(200).json({ items: [], error: 'not_configured' });
  }

  const body = req.body || {};
  const transcript = String(body.transcript || '').trim().slice(0, MAX_TRANSCRIPT);
  if (!transcript) return res.status(200).json({ items: [], error: 'empty' });
  const parts = [{ text: VOICE_PROMPT + transcript }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!upstream.ok) {
      return res.status(200).json({ items: [], error: `upstream_${upstream.status}` });
    }

    const data = await upstream.json();
    const text = data
      && data.candidates
      && data.candidates[0]
      && data.candidates[0].content
      && data.candidates[0].content.parts
      && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;

    const items = extractJsonArray(text);
    if (!items) return res.status(200).json({ items: [], error: 'unparseable' });

    // Normalise here so the client can trust the shape.
    const clean = items
      .filter(it => it && typeof it.name === 'string' && it.name.trim())
      .slice(0, 12)
      .map(it => {
        const grams = Number(it.grams);
        return {
          name: it.name.trim().slice(0, 60),
          grams: Number.isFinite(grams) && grams > 0 ? Math.round(grams) : null
        };
      });

    return res.status(200).json({ items: clean });
  } catch (e) {
    return res.status(200).json({ items: [], error: 'request_failed' });
  } finally {
    clearTimeout(timer);
  }
}

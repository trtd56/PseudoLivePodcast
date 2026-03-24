import { GoogleGenAI } from '@google/genai'

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY

if (!apiKey) {
  throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY is required')
}

const ai = new GoogleGenAI({ apiKey })

export function normalizeCommentaryInput(body) {
  const transcript = String(body?.transcript ?? '').trim()
  const recentComments = Array.isArray(body?.recentComments)
    ? body.recentComments.map((item) => String(item))
    : []

  return {
    transcript,
    recentComments,
  }
}

export async function generateCommentary({ transcript, recentComments }) {
  if (!transcript) {
    throw new Error('transcript is required')
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: {
      responseMimeType: 'application/json',
      temperature: 1,
    },
    contents: `
You are producing simulated live audience comments for a solo podcast recording screen.

Requirements:
- Output JSON only.
- Detect the current topic and mood from the transcript.
- Create 3 short Japanese comments that feel like a YouTube Live or Twitch chat.
- Each comment must sound distinct, natural, and a little reactive.
- Avoid repeating the recent comments.
- Keep each message under 55 Japanese characters.
- Ticker items should be 4 short Japanese phrases.

Return this exact JSON shape:
{
  "segmentTitle": "string",
  "vibe": "string",
  "ticker": ["string", "string", "string", "string"],
  "comments": [
    { "author": "string", "handle": "string", "message": "string", "tone": "string" }
  ]
}

Transcript:
${transcript}

Recent comments to avoid repeating:
${recentComments.join('\n')}
    `.trim(),
  })

  const text = response.text?.trim()
  if (!text) {
    throw new Error('Empty response from Gemini')
  }

  return JSON.parse(text)
}

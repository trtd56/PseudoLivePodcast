import { generateCommentary, normalizeCommentaryInput } from '../lib/commentary.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { transcript, recentComments } = normalizeCommentaryInput(req.body)

  if (!transcript) {
    return res.status(400).json({ error: 'transcript is required' })
  }

  try {
    const response = await generateCommentary({ transcript, recentComments })
    return res.status(200).json(response)
  } catch (error) {
    console.error(error)
    return res.status(500).json({
      error: 'Failed to generate commentary',
      details: error instanceof Error ? error.message : 'Unknown server error',
    })
  }
}

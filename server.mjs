import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { generateCommentary, normalizeCommentaryInput } from './lib/commentary.mjs'

const app = express()
const port = Number(process.env.PORT ?? 8787)

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/commentary', async (req, res) => {
  const { transcript, recentComments } = normalizeCommentaryInput(req.body)

  if (!transcript) {
    return res.status(400).json({ error: 'transcript is required' })
  }

  try {
    const response = await generateCommentary({ transcript, recentComments })
    res.json(response)
  } catch (error) {
    console.error(error)
    res.status(500).json({
      error: 'Failed to generate commentary',
      details: error instanceof Error ? error.message : 'Unknown server error',
    })
  }
})

app.listen(port, () => {
  console.log(`Gemini commentary server listening on http://localhost:${port}`)
})

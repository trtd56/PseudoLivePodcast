import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type GeneratedComment = {
  author: string
  handle: string
  message: string
  tone: string
}

type CommentaryResponse = {
  segmentTitle: string
  vibe: string
  ticker: string[]
  comments: GeneratedComment[]
}

type TranscriptEntry = {
  id: string
  text: string
  at: string
}

type ChatMessage = GeneratedComment & {
  id: string
  at: string
}

type SpeechRecognitionCtor = new () => SpeechRecognition

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionCtor
    SpeechRecognition?: SpeechRecognitionCtor
  }

  interface SpeechRecognition extends EventTarget {
    continuous: boolean
    interimResults: boolean
    lang: string
    onresult: ((event: SpeechRecognitionEvent) => void) | null
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
    onend: (() => void) | null
    start(): void
    stop(): void
  }

  interface SpeechRecognitionEvent {
    resultIndex: number
    results: SpeechRecognitionResultList
  }

  interface SpeechRecognitionErrorEvent {
    error: string
  }
}

const COMMENTARY_COOLDOWN_MS = 12000
const MAX_CHAT_MESSAGES = 18
const MAX_TRANSCRIPT_ENTRIES = 24

function App() {
  const speechCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const lastPromptAtRef = useRef(0)
  const spokenWindowRef = useRef('')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const captureStreamRef = useRef<MediaStream | null>(null)

  const [isListening, setIsListening] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [status, setStatus] = useState('待機中')
  const [interimText, setInterimText] = useState('')
  const [segmentTitle, setSegmentTitle] = useState('オープニング')
  const [vibe, setVibe] = useState('落ち着いた導入')
  const [tickerItems, setTickerItems] = useState<string[]>([
    'マイクを許可して開始',
    'AIコメントはGeminiで自動生成',
    'この画面をそのまま録画して配信風に出力',
  ])
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null)
  const [audioUrl, setAudioUrl] = useState<string>('')

  const elapsed = useElapsedTime(recordingStartedAt)

  const transcriptText = useMemo(
    () => transcriptEntries.map((entry) => entry.text).join('\n'),
    [transcriptEntries],
  )

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      mediaRecorderRef.current?.stop()
      captureStreamRef.current?.getTracks().forEach((track) => track.stop())
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl)
      }
    }
  }, [audioUrl])

  const appendTranscript = (text: string) => {
    const cleanText = text.trim()
    if (!cleanText) return

    const now = new Date()
    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      text: cleanText,
      at: now.toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    }

    spokenWindowRef.current = [spokenWindowRef.current, cleanText].filter(Boolean).join('\n').slice(-2400)
    setTranscriptEntries((current) => [entry, ...current].slice(0, MAX_TRANSCRIPT_ENTRIES))
  }

  const requestCommentary = async (force = false) => {
    const transcript = spokenWindowRef.current.trim()
    if (!transcript) return

    const now = Date.now()
    if (!force && now - lastPromptAtRef.current < COMMENTARY_COOLDOWN_MS) return

    lastPromptAtRef.current = now
    setIsGenerating(true)
    setStatus('Gemini がコメント生成中')

    try {
      const response = await fetch('/api/commentary', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transcript,
          recentComments: chatMessages.slice(0, 6).map((message) => message.message),
        }),
      })

      if (!response.ok) {
        throw new Error('commentary request failed')
      }

      const data = (await response.json()) as CommentaryResponse
      const timestamp = new Date().toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
      })

      setSegmentTitle(data.segmentTitle)
      setVibe(data.vibe)
      setTickerItems(data.ticker.slice(0, 4))
      setChatMessages((current) => {
        const next = data.comments.map((comment) => ({
          ...comment,
          id: crypto.randomUUID(),
          at: timestamp,
        }))

        return [...next, ...current].slice(0, MAX_CHAT_MESSAGES)
      })
      setStatus('コメント更新済み')
    } catch (error) {
      console.error(error)
      setStatus('Gemini コメント生成に失敗')
    } finally {
      setIsGenerating(false)
    }
  }

  const startListening = async () => {
    if (!speechCtor) {
      setStatus('このブラウザでは音声認識に未対応')
      return
    }

    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }

    const recognition = new speechCtor()
    recognition.lang = 'ja-JP'
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event) => {
      let finalChunk = ''
      let interimChunk = ''

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''

        if (result.isFinal) {
          finalChunk += `${text} `
        } else {
          interimChunk += text
        }
      }

      setInterimText(interimChunk.trim())

      if (finalChunk.trim()) {
        appendTranscript(finalChunk)
        void requestCommentary()
      }
    }

    recognition.onerror = (event) => {
      setStatus(`音声認識エラー: ${event.error}`)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
      setInterimText('')
    }

    recognition.start()
    recognitionRef.current = recognition
    setIsListening(true)
    setStatus('音声認識中')
  }

  const stopListening = () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setIsListening(false)
    setInterimText('')
    setStatus('停止中')
  }

  const startAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      captureStreamRef.current = stream
      audioChunksRef.current = []

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
        if (audioUrl) {
          URL.revokeObjectURL(audioUrl)
        }
        const nextUrl = URL.createObjectURL(blob)
        setAudioUrl(nextUrl)
        captureStreamRef.current?.getTracks().forEach((track) => track.stop())
      }

      recorder.start()
      mediaRecorderRef.current = recorder
      setRecordingStartedAt(Date.now())
      setStatus('収録中')
    } catch (error) {
      console.error(error)
      setStatus('マイク録音を開始できませんでした')
    }
  }

  const stopAudioCapture = () => {
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    setRecordingStartedAt(null)
    setStatus('収録停止')
  }

  return (
    <main className="studio-shell">
      <section className="hero-panel">
        <div className="hero-backdrop" />
        <header className="topbar">
          <div>
            <p className="eyebrow">Solo Podcast Broadcast Desk</p>
            <h1>One-person live podcast screen</h1>
          </div>
          <div className="live-status">
            <span className={`dot ${recordingStartedAt ? 'is-live' : ''}`} />
            <strong>{recordingStartedAt ? 'LIVE REC' : 'STANDBY'}</strong>
            <span>{elapsed}</span>
          </div>
        </header>

        <section className="stage-card">
          <div className="stage-main">
            <div className="glass">
              <p className="section-label">Now talking</p>
              <h2>{segmentTitle}</h2>
              <p className="vibe">{vibe}</p>
              <div className="quote-box">
                <span className="quote-label">リアルタイム文字起こし</span>
                <p>{interimText || transcriptEntries[0]?.text || '話し始めるとここに内容が出ます。'}</p>
              </div>
            </div>

            <div className="meter-grid">
              <MetricCard label="Speech" value={isListening ? 'ON AIR' : 'OFF'} detail={status} />
              <MetricCard label="Gemini" value={isGenerating ? 'THINKING' : 'READY'} detail="実況コメント生成" />
              <MetricCard
                label="Output"
                value={recordingStartedAt ? 'REC' : 'ARMED'}
                detail="この画面をそのまま録画"
              />
            </div>
          </div>

          <aside className="chat-panel">
            <div className="chat-header">
              <div>
                <p className="section-label">AI audience</p>
                <h3>Generated comments</h3>
              </div>
              <button className="ghost-button" onClick={() => void requestCommentary(true)}>
                今すぐ更新
              </button>
            </div>

            <div className="chat-list">
              {chatMessages.length === 0 ? (
                <div className="empty-chat">
                  <p>会話が進むと Gemini が実況コメントを流します。</p>
                </div>
              ) : (
                chatMessages.map((message) => (
                  <article className="chat-bubble" key={message.id}>
                    <div className="chat-meta">
                      <strong>{message.author}</strong>
                      <span>{message.handle}</span>
                      <time>{message.at}</time>
                    </div>
                    <p>{message.message}</p>
                    <span className="tone">{message.tone}</span>
                  </article>
                ))
              )}
            </div>
          </aside>
        </section>

        <section className="control-strip">
          <div className="ticker">
            <span className="ticker-head">TOPICS</span>
            <div className="ticker-track">
              {[...tickerItems, ...tickerItems].map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              ))}
            </div>
          </div>

          <div className="controls">
            <button className="primary-button" onClick={isListening ? stopListening : startListening}>
              {isListening ? '音声認識を止める' : '音声認識を始める'}
            </button>
            <button
              className="secondary-button"
              onClick={recordingStartedAt ? stopAudioCapture : startAudioCapture}
            >
              {recordingStartedAt ? 'マイク録音を停止' : 'マイク録音を開始'}
            </button>
          </div>
        </section>

        <section className="bottom-grid">
          <div className="transcript-panel">
            <div className="panel-heading">
              <p className="section-label">Transcript log</p>
              <strong>{transcriptEntries.length} entries</strong>
            </div>
            <div className="transcript-list">
              {transcriptEntries.length === 0 ? (
                <p className="placeholder">音声認識を始めるとログがここに溜まります。</p>
              ) : (
                transcriptEntries.map((entry) => (
                  <article className="transcript-item" key={entry.id}>
                    <time>{entry.at}</time>
                    <p>{entry.text}</p>
                  </article>
                ))
              )}
            </div>
          </div>

          <div className="notes-panel">
            <div className="panel-heading">
              <p className="section-label">Output helper</p>
              <strong>録画向け</strong>
            </div>
            <p className="helper-copy">
              画面収録は macOS 標準の画面録画や OBS でこのウィンドウ全体を撮れば、そのまま配信風の映像として出力できます。
            </p>
            {audioUrl ? (
              <div className="audio-box">
                <audio controls src={audioUrl} />
                <a href={audioUrl} download="podcast-session.webm" className="download-link">
                  音声ファイルを保存
                </a>
              </div>
            ) : (
              <p className="placeholder">マイク録音を停止すると音声ファイルを保存できます。</p>
            )}
            <div className="summary-box">
              <p className="summary-label">Transcript snapshot</p>
              <p>{transcriptText || 'まだ発話はありません。'}</p>
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  )
}

function useElapsedTime(startedAt: number | null) {
  const [elapsed, setElapsed] = useState('00:00')

  useEffect(() => {
    if (!startedAt) {
      setElapsed('00:00')
      return
    }

    const intervalId = window.setInterval(() => {
      const diffSeconds = Math.floor((Date.now() - startedAt) / 1000)
      const minutes = String(Math.floor(diffSeconds / 60)).padStart(2, '0')
      const seconds = String(diffSeconds % 60).padStart(2, '0')
      setElapsed(`${minutes}:${seconds}`)
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [startedAt])

  return elapsed
}

export default App

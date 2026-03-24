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
  const chatListRef = useRef<HTMLDivElement | null>(null)
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
  const isCameraEnabled = false

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

  useEffect(() => {
    const node = chatListRef.current
    if (!node) return

    node.scrollTo({
      top: node.scrollHeight,
      behavior: 'smooth',
    })
  }, [chatMessages])

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

        return [...current, ...next].slice(-MAX_CHAT_MESSAGES)
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
      <div className="app-shell">
        <header className="app-bar">
          <div className="app-brand">
            <div className="brand-mark" aria-hidden="true" />
            <div>
              <h1>Live Control Room</h1>
              <p>ポッドキャスト配信を YouTube Live 風にモニタリング</p>
            </div>
          </div>
          <div className="app-status">
            <span className={`dot ${recordingStartedAt ? 'is-live' : ''}`} />
            <strong>{recordingStartedAt ? 'ライブ配信中' : '配信準備中'}</strong>
            <span>{elapsed}</span>
          </div>
        </header>

        <section className="dashboard">
          <section className="hero-stage">
            <div className="left-column">
              <article className="player-card">
                <div className="player-visual">
                  <div className="player-chrome">
                    <div className="status-icons">
                      <StatusIcon kind="live" active={Boolean(recordingStartedAt)} label={recordingStartedAt ? 'ライブ中' : '待機中'} />
                      <StatusIcon kind="mic" active={isListening} label={isListening ? 'マイク入力中' : 'マイク停止'} />
                      <StatusIcon kind="spark" active={isGenerating} label={isGenerating ? 'AI生成中' : 'AI待機'} />
                      {isCameraEnabled ? <StatusIcon kind="camera" active label="カメラ有効" /> : null}
                    </div>
                    <span className="elapsed-badge">{elapsed}</span>
                  </div>

                  <div className="hero-copy">
                    <h2>{segmentTitle}</h2>
                    <p className="hero-meta">{vibe}</p>
                    <div className="quote-box">
                      <span className="quote-label">リアルタイム文字起こし</span>
                      <p>{interimText || transcriptEntries[0]?.text || '話し始めるとここに内容が出ます。'}</p>
                    </div>
                  </div>
                </div>
              </article>

              <section className="video-meta">
                <div className="video-heading">
                  <div>
                    <h3>{segmentTitle}</h3>
                    <p>ひとりポッドキャスト配信 / AI ライブチャット連動</p>
                  </div>
                  <div className="meta-stats">
                    <span>{chatMessages.length} chats</span>
                    <span>{transcriptEntries.length} logs</span>
                    <span>{recordingStartedAt ? 'LIVE' : 'READY'}</span>
                  </div>
                </div>

                <div className="status-strip">
                  <StatusPill label="配信" value={recordingStartedAt ? 'LIVE' : 'READY'} active={Boolean(recordingStartedAt)} />
                  <StatusPill label="音声" value={isListening ? 'ON' : 'OFF'} active={isListening} />
                  <StatusPill label="AI" value={isGenerating ? 'RUN' : 'IDLE'} active={isGenerating} />
                  <StatusPill label="状態" value={status} />
                </div>
              </section>
            </div>

            <aside className="right-column">
              <section className="side-card chat-panel">
                <div className="chat-header">
                  <div>
                    <h3>ライブチャット</h3>
                    <p className="panel-subtle">視聴者コメントを模した AI メッセージ</p>
                  </div>
                  <div className="chat-actions">
                    <span className="chat-count">{chatMessages.length} 件</span>
                  </div>
                </div>

                <div className="chat-list" ref={chatListRef}>
                  {chatMessages.length === 0 ? (
                    <div className="empty-chat">
                      <p>会話が進むと Gemini がライブチャット風の反応を追加します。</p>
                    </div>
                  ) : (
                    chatMessages.map((message) => (
                      <article className="chat-message" key={message.id}>
                        <div className="chat-meta">
                          <strong>{message.author}</strong>
                          <span className="chat-handle">{message.handle}</span>
                          <time>{message.at}</time>
                        </div>
                        <p className="chat-text">{message.message}</p>
                        <span className="tone">{message.tone}</span>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </aside>
          </section>

          <section className="control-strip">
            <div className="controls">
              <button className="control-button primary" onClick={isListening ? stopListening : startListening}>
                {isListening ? '音声認識を停止' : '音声認識を開始'}
              </button>
              <button
                className="control-button"
                onClick={recordingStartedAt ? stopAudioCapture : startAudioCapture}
              >
                {recordingStartedAt ? 'マイク録音を停止' : 'マイク録音を開始'}
              </button>
              <button className="control-button subtle" onClick={() => void requestCommentary(true)}>
                コメント更新
              </button>
            </div>

            <div className="ticker">
              <span className="ticker-head">TOP CHAT</span>
              <div className="ticker-track compact">
                {[...tickerItems, ...tickerItems].map((item, index) => (
                  <span key={`${item}-${index}`}>{item}</span>
                ))}
              </div>
            </div>
          </section>

          <section className="bottom-grid">
            <section className="transcript-panel">
              <div className="panel-heading">
                <div>
                  <h3>文字起こし</h3>
                  <p className="panel-subtle">配信中の発話ログ</p>
                </div>
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
            </section>

            <section className="notes-panel">
              <div className="panel-heading">
                <div>
                  <h3>出力とメモ</h3>
                  <p className="panel-subtle">配信レイアウトのメモとトランスクリプト要約</p>
                </div>
                <strong>Control Room</strong>
              </div>
              <p className="helper-copy">
                OBS や macOS 標準の画面録画でこのウィンドウをそのまま取り込めば、配信管理画面とプレビューを一体化した見た目で出力できます。
              </p>
              <div className="audio-box">
                <div className="audio-copy">
                  <p className="summary-label">Audio export</p>
                  <p>{audioUrl ? '収録音声を確認して保存できます。' : '録音停止後に音声を書き出せます。'}</p>
                </div>
                {audioUrl ? (
                  <>
                    <audio controls src={audioUrl} />
                    <a href={audioUrl} download="podcast-session.webm" className="download-link">
                      音声ファイルを保存
                    </a>
                  </>
                ) : (
                  <p className="placeholder">まだ保存可能な音声はありません。</p>
                )}
              </div>
              <div className="summary-box">
                <p className="summary-label">Transcript snapshot</p>
                <p>{transcriptText || 'まだ発話はありません。'}</p>
              </div>
            </section>
          </section>
        </section>
      </div>
    </main>
  )
}

function StatusPill({
  label,
  value,
  active = false,
}: {
  label: string
  value: string
  active?: boolean
}) {
  return (
    <article className={`status-pill ${active ? 'is-active' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function StatusIcon({
  kind,
  active,
  label,
}: {
  kind: 'live' | 'mic' | 'spark' | 'camera'
  active: boolean
  label: string
}) {
  return (
    <span className={`status-icon ${active ? 'is-active' : ''}`} aria-label={label} title={label}>
      {kind === 'live' ? <span className="status-icon-dot" /> : null}
      {kind === 'mic' ? '●' : null}
      {kind === 'spark' ? '✦' : null}
      {kind === 'camera' ? '▣' : null}
    </span>
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

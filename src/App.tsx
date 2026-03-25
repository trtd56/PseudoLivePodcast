import { useEffect, useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
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
const COMMENTARY_FLUSH_INTERVAL_MS = 10000
const COMMENTARY_BATCH_SIZE = 1
const MAX_CHAT_MESSAGES = 18
const MAX_TRANSCRIPT_ENTRIES = 24

function getSupportedMimeType(mimeTypes: string[]) {
  return mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

function getExtensionFromMimeType(mimeType: string, fallback: string) {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('quicktime')) return 'mov'
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('ogg')) return 'ogg'
  return fallback
}

function App() {
  const speechCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
  const appShellRef = useRef<HTMLDivElement | null>(null)
  const cameraPreviewRef = useRef<HTMLVideoElement | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const chatListRef = useRef<HTMLDivElement | null>(null)
  const lastPromptAtRef = useRef(0)
  const spokenWindowRef = useRef('')
  const pendingCommentsRef = useRef<GeneratedComment[]>([])
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const audioRecordingChunksRef = useRef<Blob[]>([])
  const micStreamRef = useRef<MediaStream | null>(null)
  const videoStreamRef = useRef<MediaStream | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const recordingUrlRef = useRef('')
  const audioRecordingUrlRef = useRef('')
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const renderIntervalRef = useRef<number | null>(null)
  const isRenderingFrameRef = useRef(false)

  const [isListening, setIsListening] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCameraEnabled, setIsCameraEnabled] = useState(false)
  const [isCameraLoading, setIsCameraLoading] = useState(false)
  const [status, setStatus] = useState('待機中')
  const [interimText, setInterimText] = useState('')
  const [segmentTitle, setSegmentTitle] = useState('オープニング')
  const [vibe, setVibe] = useState('落ち着いた導入')
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null)
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null)
  const [recordingUrl, setRecordingUrl] = useState<string>('')
  const [recordingMimeType, setRecordingMimeType] = useState<string>('')
  const [audioRecordingBlob, setAudioRecordingBlob] = useState<Blob | null>(null)
  const [audioRecordingUrl, setAudioRecordingUrl] = useState<string>('')
  const [audioPreviewMimeType, setAudioPreviewMimeType] = useState<string>('')
  const [cameraError, setCameraError] = useState('')
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [downloadFormat, setDownloadFormat] = useState<'video' | 'audio'>('video')
  const [queuedCommentCount, setQueuedCommentCount] = useState(0)
  const [isTranscriptOpen, setIsTranscriptOpen] = useState(false)
  const [isNotesOpen, setIsNotesOpen] = useState(false)

  const elapsed = useElapsedTime(recordingStartedAt)

  const transcriptText = useMemo(
    () => transcriptEntries.map((entry) => entry.text).join('\n'),
    [transcriptEntries],
  )

  useEffect(() => {
    recordingUrlRef.current = recordingUrl
  }, [recordingUrl])

  useEffect(() => {
    audioRecordingUrlRef.current = audioRecordingUrl
  }, [audioRecordingUrl])

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
      mediaRecorderRef.current?.stop()
      audioRecorderRef.current?.stop()
      micStreamRef.current?.getTracks().forEach((track) => track.stop())
      videoStreamRef.current?.getTracks().forEach((track) => track.stop())
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
      if (renderIntervalRef.current !== null) {
        window.clearInterval(renderIntervalRef.current)
      }
      if (recordingUrlRef.current) {
        URL.revokeObjectURL(recordingUrlRef.current)
      }
      if (audioRecordingUrlRef.current) {
        URL.revokeObjectURL(audioRecordingUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const preview = cameraPreviewRef.current
    if (!preview) return

    if (!cameraStream) {
      preview.pause()
      preview.srcObject = null
      return
    }

    preview.srcObject = cameraStream
    preview.muted = true
    preview.playsInline = true

    void preview.play().catch((error) => {
      console.error(error)
    })

    return () => {
      preview.pause()
      preview.srcObject = null
    }
  }, [cameraStream, isCameraEnabled])

  useEffect(() => {
    const node = chatListRef.current
    if (!node) return

    node.scrollTo({
      top: node.scrollHeight,
      behavior: 'smooth',
    })
  }, [chatMessages])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pendingCommentsRef.current.length === 0) return

      const nextBatch = pendingCommentsRef.current.splice(0, COMMENTARY_BATCH_SIZE)
      const timestamp = new Date().toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
      })

      setChatMessages((current) => {
        const queued = nextBatch.map((comment) => ({
          ...comment,
          id: crypto.randomUUID(),
          at: timestamp,
        }))

        return [...current, ...queued].slice(-MAX_CHAT_MESSAGES)
      })
      setQueuedCommentCount(pendingCommentsRef.current.length)
      setStatus(pendingCommentsRef.current.length > 0 ? `コメント待機中 (${pendingCommentsRef.current.length}件)` : 'コメント更新済み')
    }, COMMENTARY_FLUSH_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

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
    setStatus('コメント生成中')

    try {
      const response = await fetch('/api/commentary', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transcript,
          recentComments: [
            ...chatMessages.slice(-6).map((message) => message.message),
            ...pendingCommentsRef.current.slice(-6).map((message) => message.message),
          ].slice(-6),
        }),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { details?: string } | null
        throw new Error(payload?.details ?? 'commentary request failed')
      }

      const data = (await response.json()) as CommentaryResponse

      setSegmentTitle(data.segmentTitle)
      setVibe(data.vibe)
      pendingCommentsRef.current.push(...data.comments)
      setQueuedCommentCount(pendingCommentsRef.current.length)
      setStatus(`コメント待機中 (${pendingCommentsRef.current.length}件)`)
    } catch (error) {
      console.error(error)
      setStatus('コメント生成に失敗')
    } finally {
      setIsGenerating(false)
    }
  }

  const startListening = async () => {
    if (!speechCtor) {
      setStatus('このブラウザでは音声認識に未対応')
      return false
    }

    if (isListening) {
      return true
    }

    try {
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
      return true
    } catch (error) {
      console.error(error)
      setStatus('音声認識を開始できませんでした')
      return false
    }
  }

  const stopListening = () => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setIsListening(false)
    setInterimText('')
    setStatus('停止中')
  }

  const stopCamera = () => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    cameraStreamRef.current = null
    setCameraStream(null)
    setIsCameraEnabled(false)
    setIsCameraLoading(false)
    setCameraError('')
  }

  const startCamera = async () => {
    if (cameraStreamRef.current) {
      setCameraError('')
      setIsCameraEnabled(true)
      return true
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('このブラウザではPCカメラ取得に対応していません。')
      return false
    }

    setIsCameraLoading(true)
    setCameraError('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })

      for (const track of stream.getVideoTracks()) {
        track.onended = () => {
          cameraStreamRef.current = null
          setCameraStream(null)
          setIsCameraEnabled(false)
          setCameraError('カメラが切断されたため映像表示を停止しました。')
        }
      }

      cameraStreamRef.current = stream
      setCameraStream(stream)
      setIsCameraEnabled(true)
      return true
    } catch (error) {
      console.error(error)
      setCameraError('PCカメラを開始できませんでした。ブラウザの権限設定を確認してください。')
      setIsCameraEnabled(false)
      return false
    } finally {
      setIsCameraLoading(false)
    }
  }

  const toggleCamera = () => {
    if (isCameraEnabled) {
      stopCamera()
      return
    }

    void startCamera()
  }

  const stopCaptureStreams = () => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    videoStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
    videoStreamRef.current = null
    captureCanvasRef.current = null
    isRenderingFrameRef.current = false

    if (renderIntervalRef.current !== null) {
      window.clearInterval(renderIntervalRef.current)
      renderIntervalRef.current = null
    }
  }

  const getVideoRecordingMimeType = () => {
    return getSupportedMimeType([
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/quicktime;codecs=h264,aac',
      'video/quicktime',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ])
  }

  const getAudioRecordingMimeType = () => {
    return getSupportedMimeType([
      'audio/webm;codecs=opus',
      'audio/webm',
    ])
  }

  const renderAppFrame = async () => {
    const target = appShellRef.current
    const canvas = captureCanvasRef.current

    if (!target || !canvas || isRenderingFrameRef.current) {
      return
    }

    isRenderingFrameRef.current = true

    try {
      const snapshot = await html2canvas(target, {
        backgroundColor: null,
        useCORS: true,
        scale: Math.min(window.devicePixelRatio || 1, 2),
      })

      if (canvas.width !== snapshot.width || canvas.height !== snapshot.height) {
        canvas.width = snapshot.width
        canvas.height = snapshot.height
      }

      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('Canvas context is not available')
      }

      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(snapshot, 0, 0)

      const preview = cameraPreviewRef.current
      if (
        isCameraEnabled
        && preview
        && preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        && preview.videoWidth > 0
        && preview.videoHeight > 0
      ) {
        const targetRect = target.getBoundingClientRect()
        const previewRect = preview.getBoundingClientRect()
        const scaleX = canvas.width / targetRect.width
        const scaleY = canvas.height / targetRect.height
        const x = (previewRect.left - targetRect.left) * scaleX
        const y = (previewRect.top - targetRect.top) * scaleY
        const width = previewRect.width * scaleX
        const height = previewRect.height * scaleY
        const cssRadius = Number.parseFloat(window.getComputedStyle(preview).borderTopLeftRadius) || 0
        const radius = cssRadius * scaleX

        context.save()
        clipRoundedRect(context, x, y, width, height, radius)
        context.clip()
        drawVideoCover(context, preview, x, y, width, height)
        context.restore()
      }
    } finally {
      isRenderingFrameRef.current = false
    }
  }

  const startVideoCapture = async () => {
    if (mediaRecorderRef.current) {
      return true
    }

    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const target = appShellRef.current

      if (!target) {
        micStream.getTracks().forEach((track) => track.stop())
        setStatus('録画対象の画面を取得できませんでした')
        return false
      }

      const snapshot = await html2canvas(target, {
        backgroundColor: null,
        useCORS: true,
        scale: Math.min(window.devicePixelRatio || 1, 2),
      })
      const captureCanvas = document.createElement('canvas')
      captureCanvas.width = snapshot.width
      captureCanvas.height = snapshot.height

      const captureContext = captureCanvas.getContext('2d')
      if (!captureContext) {
        micStream.getTracks().forEach((track) => track.stop())
        setStatus('録画用キャンバスを初期化できませんでした')
        return false
      }

      captureContext.drawImage(snapshot, 0, 0)
      const stream = captureCanvas.captureStream(12)
      const videoTrack = stream.getVideoTracks()[0]
      const micTrack = micStream.getAudioTracks()[0]

      if (!videoTrack || !micTrack) {
        stream.getTracks().forEach((track) => track.stop())
        micStream.getTracks().forEach((track) => track.stop())
        setStatus('映像またはマイクを取得できませんでした')
        return false
      }

      micStreamRef.current = micStream
      videoStreamRef.current = stream
      captureCanvasRef.current = captureCanvas
      recordingChunksRef.current = []
      audioRecordingChunksRef.current = []
      setRecordingBlob(null)
      setRecordingMimeType('')
      setAudioRecordingBlob(null)
      setAudioPreviewMimeType('')

      const combinedStream = new MediaStream([videoTrack, micTrack])
      const videoMimeType = getVideoRecordingMimeType()
      const audioMimeType = getAudioRecordingMimeType()
      const recorder = videoMimeType ? new MediaRecorder(combinedStream, { mimeType: videoMimeType }) : new MediaRecorder(combinedStream)
      const audioRecorder = audioMimeType ? new MediaRecorder(micStream, { mimeType: audioMimeType }) : new MediaRecorder(micStream)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, {
          type: videoMimeType || 'video/webm',
        })

        if (recordingUrl) {
          URL.revokeObjectURL(recordingUrl)
        }

        const nextUrl = URL.createObjectURL(blob)
        setRecordingBlob(blob)
        setRecordingUrl(nextUrl)
        setRecordingMimeType(blob.type || videoMimeType || 'video/webm')
      }

      audioRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioRecordingChunksRef.current.push(event.data)
        }
      }

      audioRecorder.onstop = () => {
        const sourceBlob = new Blob(audioRecordingChunksRef.current, {
          type: audioMimeType || 'audio/webm',
        })

        void (async () => {
          try {
            setStatus('音声を WAV に変換中')
            const blob = await convertAudioBlobToWav(sourceBlob)

            if (audioRecordingUrl) {
              URL.revokeObjectURL(audioRecordingUrl)
            }

            const nextUrl = URL.createObjectURL(blob)
            setAudioRecordingBlob(blob)
            setAudioRecordingUrl(nextUrl)
            setAudioPreviewMimeType(blob.type)
          } catch (error) {
            console.error(error)

            if (audioRecordingUrl) {
              URL.revokeObjectURL(audioRecordingUrl)
            }

            const nextUrl = URL.createObjectURL(sourceBlob)
            setAudioRecordingBlob(sourceBlob)
            setAudioRecordingUrl(nextUrl)
            setAudioPreviewMimeType(sourceBlob.type)
            setStatus('WAV 変換に失敗したため元の音声を保持')
          } finally {
            stopCaptureStreams()
          }
        })()
      }

      renderIntervalRef.current = window.setInterval(() => {
        void renderAppFrame()
      }, 250)

      recorder.start()
      audioRecorder.start()
      mediaRecorderRef.current = recorder
      audioRecorderRef.current = audioRecorder
      setRecordingStartedAt(Date.now())
      setDownloadFormat('video')
      setStatus('アプリ画面を収録中')
      return true
    } catch (error) {
      console.error(error)
      stopCaptureStreams()
      setStatus('アプリ画面の収録を開始できませんでした')
      return false
    }
  }

  const stopVideoCapture = () => {
    mediaRecorderRef.current?.stop()
    audioRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    audioRecorderRef.current = null
    setRecordingStartedAt(null)
    setStatus('収録停止')
  }

  const selectedDownload = downloadFormat === 'audio'
    ? {
        blob: audioRecordingBlob,
        filename: 'podcast-session-audio.wav',
        label: '音声ファイルを保存',
      }
    : {
        blob: recordingBlob,
        filename: `podcast-session.${getExtensionFromMimeType(recordingMimeType, 'webm')}`,
        label: '動画ファイルを保存',
      }

  const canDownloadAudio = Boolean(audioRecordingBlob)
  const canDownloadVideo = Boolean(recordingBlob)

  const handleDownload = () => {
    if (!selectedDownload.blob) {
      setStatus('選択した形式はまだ保存できません')
      return
    }

    const downloadUrl = URL.createObjectURL(selectedDownload.blob)
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = selectedDownload.filename
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
  }

  const startSession = async () => {
    const didStartCapture = await startVideoCapture()
    if (!didStartCapture) return

    const didStartListening = await startListening()
    if (!didStartListening) {
      stopVideoCapture()
      return
    }

    setStatus('収録と音声認識を開始')
  }

  const stopSession = (nextStatus = '収録と音声認識を停止') => {
    stopListening()
    stopVideoCapture()
    setStatus(nextStatus)
  }

  return (
    <main className="studio-shell">
      <div className="app-shell" ref={appShellRef}>
        <header className="app-bar">
          <div className="app-brand">
            <div className="brand-mark" aria-hidden="true" />
            <div>
              <h1>Live Control Room</h1>
              <p>ポッドキャスト配信を YouTube Live 風にモニタリング</p>
            </div>
          </div>
          <div className="app-bar-actions">
            <button
              className={`control-button ${isCameraEnabled ? 'is-toggled' : ''}`}
              type="button"
              onClick={toggleCamera}
              disabled={isCameraLoading}
            >
              {isCameraLoading ? 'カメラを起動中...' : isCameraEnabled ? 'カメラをオフ' : 'カメラをオン'}
            </button>
            <button
              className="control-button primary"
              onClick={isListening || recordingStartedAt ? () => stopSession() : () => void startSession()}
            >
              {isListening || recordingStartedAt ? '音声認識と収録を停止' : '音声認識と収録を開始'}
            </button>
            <div className="app-status">
              <span className={`dot ${recordingStartedAt ? 'is-live' : ''}`} />
              <strong>{status}</strong>
              <span>{elapsed}</span>
            </div>
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
                      <StatusIcon kind="camera" active={isCameraEnabled} label={isCameraEnabled ? 'カメラ有効' : 'カメラ停止'} />
                    </div>
                    <span className="elapsed-badge">{elapsed}</span>
                  </div>

                  {isCameraEnabled || isCameraLoading || cameraError ? (
                    <>
                      <div className="camera-stage">
                        {isCameraEnabled ? (
                          <video
                            ref={cameraPreviewRef}
                            className="camera-preview"
                            autoPlay
                            muted
                            playsInline
                          />
                        ) : (
                          <div className="camera-placeholder">
                            <div className="camera-placeholder-copy">
                              <span className={`camera-badge ${isCameraEnabled ? 'is-live' : ''}`}>
                                {isCameraLoading ? 'CAM BOOT' : 'CAM OFF'}
                              </span>
                              <p>{isCameraLoading ? 'カメラを起動しています。' : cameraError}</p>
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="player-visual-overlay" aria-hidden="true" />
                    </>
                  ) : null}

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

            </div>

            <aside className="right-column">
              <section className="side-card chat-panel">
                <div className="chat-header">
                  <div>
                    <h3>ライブチャット</h3>
                    <p className="panel-subtle">視聴者コメント風メッセージ</p>
                  </div>
                  <div className="chat-actions">
                    <button
                      className={`icon-button ${isGenerating ? 'is-spinning' : ''}`}
                      onClick={() => void requestCommentary(true)}
                      disabled={isGenerating || !spokenWindowRef.current.trim()}
                      aria-label="コメントを更新"
                      title="コメントを更新"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M20 12a8 8 0 1 1-2.34-5.66"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                        <path
                          d="M20 4v5h-5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <span className="chat-count">{chatMessages.length} 件</span>
                    <span className="chat-count">queue {queuedCommentCount}</span>
                  </div>
                </div>

                <div className="chat-list" ref={chatListRef}>
                  {chatMessages.length === 0 ? (
                    <div className="empty-chat">
                      <p>会話が進むとライブチャット風の反応が表示されます。</p>
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

          <section className="bottom-grid">
            <section className={`transcript-panel collapsible-panel ${isTranscriptOpen ? 'is-open' : ''}`}>
              <div className="panel-heading">
                <div>
                  <h3>文字起こし</h3>
                  <p className="panel-subtle">配信中の発話ログ</p>
                </div>
                <div className="panel-heading-actions">
                  <strong>{transcriptEntries.length} entries</strong>
                  <button
                    className="panel-toggle"
                    onClick={() => setIsTranscriptOpen((current) => !current)}
                    aria-expanded={isTranscriptOpen}
                  >
                    {isTranscriptOpen ? '閉じる' : '開く'}
                  </button>
                </div>
              </div>
              {isTranscriptOpen ? (
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
              ) : null}
            </section>

            <section className={`notes-panel collapsible-panel ${isNotesOpen ? 'is-open' : ''}`}>
              <div className="panel-heading">
                <div>
                  <h3>出力とメモ</h3>
                  <p className="panel-subtle">配信レイアウトのメモとトランスクリプト要約</p>
                </div>
                <div className="panel-heading-actions">
                  <strong>Control Room</strong>
                  <button
                    className="panel-toggle"
                    onClick={() => setIsNotesOpen((current) => !current)}
                    aria-expanded={isNotesOpen}
                  >
                    {isNotesOpen ? '閉じる' : '開く'}
                  </button>
                </div>
              </div>
              {isNotesOpen ? (
                <>
                  <div className="audio-box">
                    <div className="audio-copy">
                      <p className="summary-label">Media export</p>
                      <p>
                        {recordingUrl || audioRecordingUrl
                          ? '収録した動画または音声を選んで保存できます。'
                          : '収録停止後に動画と音声を書き出せます。'}
                      </p>
                    </div>
                    {recordingUrl || audioRecordingUrl ? (
                      <>
                        {recordingUrl ? <video controls src={recordingUrl} className="recording-preview" /> : null}
                        {audioRecordingUrl ? (
                          <audio controls>
                            <source src={audioRecordingUrl} type={audioPreviewMimeType || undefined} />
                          </audio>
                        ) : null}
                        <div className="download-format-picker" role="radiogroup" aria-label="保存する形式">
                          <button
                            type="button"
                            className={`format-chip ${downloadFormat === 'video' ? 'is-active' : ''}`}
                            onClick={() => setDownloadFormat('video')}
                            disabled={!canDownloadVideo}
                            aria-pressed={downloadFormat === 'video'}
                          >
                            動画
                          </button>
                          <button
                            type="button"
                            className={`format-chip ${downloadFormat === 'audio' ? 'is-active' : ''}`}
                            onClick={() => setDownloadFormat('audio')}
                            disabled={!canDownloadAudio}
                            aria-pressed={downloadFormat === 'audio'}
                          >
                            音声
                          </button>
                        </div>
                        {selectedDownload.blob ? (
                          <button type="button" onClick={handleDownload} className="download-link">
                            {selectedDownload.label}
                          </button>
                        ) : (
                          <p className="placeholder">選択した形式はまだ保存できません。</p>
                        )}
                      </>
                    ) : (
                      <p className="placeholder">まだ保存可能な動画・音声はありません。</p>
                    )}
                  </div>
                  <div className="summary-box">
                    <p className="summary-label">Transcript snapshot</p>
                    <p>{transcriptText || 'まだ発話はありません。'}</p>
                  </div>
                </>
              ) : null}
            </section>
          </section>
        </section>
      </div>
    </main>
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

async function convertAudioBlobToWav(sourceBlob: Blob) {
  const arrayBuffer = await sourceBlob.arrayBuffer()
  const audioContext = new AudioContext()

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    const wavBuffer = encodeAudioBufferToWav(audioBuffer)
    return new Blob([wavBuffer], { type: 'audio/wav' })
  } finally {
    await audioContext.close()
  }
}

function encodeAudioBufferToWav(audioBuffer: AudioBuffer) {
  const { numberOfChannels, sampleRate } = audioBuffer
  const frameCount = audioBuffer.length
  const bytesPerSample = 2
  const blockAlign = numberOfChannels * bytesPerSample
  const buffer = new ArrayBuffer(44 + frameCount * blockAlign)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + frameCount * blockAlign, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numberOfChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, frameCount * blockAlign, true)

  const channelData = Array.from({ length: numberOfChannels }, (_, index) => audioBuffer.getChannelData(index))
  let offset = 44

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channelIndex][frameIndex] ?? 0))
      const pcmValue = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      view.setInt16(offset, pcmValue, true)
      offset += bytesPerSample
    }
  }

  return buffer
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function clipRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2)

  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

function drawVideoCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const videoAspectRatio = video.videoWidth / video.videoHeight
  const frameAspectRatio = width / height

  let sourceX = 0
  let sourceY = 0
  let sourceWidth = video.videoWidth
  let sourceHeight = video.videoHeight

  if (videoAspectRatio > frameAspectRatio) {
    sourceWidth = video.videoHeight * frameAspectRatio
    sourceX = (video.videoWidth - sourceWidth) / 2
  } else {
    sourceHeight = video.videoWidth / frameAspectRatio
    sourceY = (video.videoHeight - sourceHeight) / 2
  }

  context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height)
}

export default App

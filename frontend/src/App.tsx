import { useEffect, useRef, useState } from 'react'
import './App.css'
import { extractPdfText } from './lib/pdf'
import { summarizePdf, type PdfSummary, type Severity } from './lib/litellm'

type Status = 'idle' | 'reading' | 'extracting' | 'summarizing' | 'done' | 'error'

const DEFAULT_API_BASE = 'http://localhost:4000'
const DEFAULT_MODEL = 'ollama/gpt-oss:20b'
const DEFAULT_MAX_CHARS = 20000
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info']
// 本機 20B 模型吞吐量大約 15-25 tokens/s，長報告（很多 findings）跑好幾分鐘是正常的，
// 這個 timeout 只是防止真的卡死（例如模型陷入無限碎念）時畫面一直空轉。
const SUMMARIZE_TIMEOUT_MS = 8 * 60 * 1000

function loadSetting(key: string, fallback: string) {
  return localStorage.getItem(key) ?? fallback
}

function slugify(name: string) {
  return (
    name
      .replace(/\.pdf$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'report'
  )
}

function App() {
  const [apiBase, setApiBase] = useState(() => loadSetting('litellm_api_base', DEFAULT_API_BASE))
  const [apiKey, setApiKey] = useState(() => loadSetting('litellm_api_key', ''))
  const [model, setModel] = useState(() => loadSetting('litellm_model', DEFAULT_MODEL))

  const [status, setStatus] = useState<Status>('idle')
  const [isDragging, setIsDragging] = useState(false)
  const [fileName, setFileName] = useState('')
  const [pageCount, setPageCount] = useState(0)
  const [result, setResult] = useState<PdfSummary | null>(null)
  const [generatedAt, setGeneratedAt] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => localStorage.setItem('litellm_api_base', apiBase), [apiBase])
  useEffect(() => localStorage.setItem('litellm_api_key', apiKey), [apiKey])
  useEffect(() => localStorage.setItem('litellm_model', model), [model])

  useEffect(() => {
    if (status !== 'summarizing') return
    setElapsedSeconds(0)
    const interval = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(interval)
  }, [status])

  const processFile = async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setError('請提供 PDF 檔案')
      setStatus('error')
      return
    }

    setError('')
    setResult(null)
    setFileName(file.name)
    setStatus('extracting')

    try {
      const { text, pageCount: pages } = await extractPdfText(file)
      setPageCount(pages)

      if (!text.trim()) {
        throw new Error('無法從此 PDF 擷取到文字內容（可能是掃描檔或圖片型 PDF）')
      }

      setStatus('summarizing')
      const controller = new AbortController()
      abortControllerRef.current = controller
      const timeoutId = setTimeout(
        () => controller.abort(new Error(`模型超過 ${SUMMARIZE_TIMEOUT_MS / 60000} 分鐘未回應，已自動取消`)),
        SUMMARIZE_TIMEOUT_MS,
      )

      try {
        const { data, truncated: wasTruncated } = await summarizePdf({
          apiBase,
          apiKey,
          model,
          fileName: file.name,
          pageCount: pages,
          text,
          maxChars: DEFAULT_MAX_CHARS,
          signal: controller.signal,
        })

        setResult(data)
        setGeneratedAt(new Date().toISOString())
        setTruncated(wasTruncated)
        setStatus('done')
      } finally {
        clearTimeout(timeoutId)
        abortControllerRef.current = null
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const handleCancel = () => {
    abortControllerRef.current?.abort(new Error('已手動取消'))
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void processFile(file)
  }

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void processFile(file)
    event.target.value = ''
  }

  // 附加穩定的 finding_id、以實際 findings 數量覆寫 severity_summary（避免模型自己數錯，
  // 之後這份 JSON 會直接匯入 Elasticsearch，欄位正確性比模型自述的統計數字更重要）
  const output = (() => {
    if (!result) return null

    const slug = slugify(fileName)
    const severityCounts = SEVERITIES.reduce(
      (acc, s) => ({ ...acc, [s]: 0 }),
      {} as Record<Severity, number>,
    )
    const findings = result.findings.map((finding, index) => {
      severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1
      return { finding_id: `${slug}-${String(index + 1).padStart(3, '0')}`, ...finding }
    })

    return {
      source_file: fileName,
      page_count: pageCount,
      generated_at: generatedAt,
      model,
      truncated,
      ...result,
      severity_summary: severityCounts,
      findings,
    }
  })()

  const handleDownload = () => {
    if (!output) return
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slugify(fileName)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const isBusy = status === 'reading' || status === 'extracting' || status === 'summarizing'

  return (
    <div className="app">
      <h1>弱點掃描報告解析工具</h1>
      <p className="subtitle">
        拖曳弱點掃描報告 PDF 到下方區域，透過本地 LiteLLM Proxy 呼叫本地 Ollama 模型解析成結構化 JSON（供匯入 Elasticsearch）
      </p>

      <details className="settings">
        <summary>連線設定</summary>
        <div className="settings-grid">
          <label>
            LiteLLM API Base
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder={DEFAULT_API_BASE} />
          </label>
          <label>
            API Key（LITELLM_MASTER_KEY）
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-xxxxxxxx"
            />
          </label>
          <label>
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={DEFAULT_MODEL} />
          </label>
        </div>
      </details>

      <div
        className={`dropzone ${isDragging ? 'dropzone-active' : ''} ${isBusy ? 'dropzone-busy' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isBusy && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden-input"
          onChange={handleFileInput}
        />
        {status === 'idle' && <p>將 PDF 檔案拖曳到這裡，或點擊選擇檔案</p>}
        {status === 'extracting' && <p>正在讀取 PDF 內容...</p>}
        {status === 'summarizing' && (
          <>
            <p>
              正在呼叫 {model} 產生摘要...（已等待 {elapsedSeconds} 秒，報告內容多時可能需要數分鐘）
            </p>
            <button
              className="cancel-button"
              onClick={(e) => {
                e.stopPropagation()
                handleCancel()
              }}
            >
              取消
            </button>
          </>
        )}
        {status === 'done' && <p>已完成：{fileName}（{pageCount} 頁）</p>}
        {status === 'error' && <p>{fileName ? `處理 ${fileName} 時發生錯誤` : '請提供 PDF 檔案'}</p>}
      </div>

      {status === 'error' && <p className="error">{error}</p>}

      {truncated && status === 'done' && (
        <p className="warning">內容過長，已截取前 {DEFAULT_MAX_CHARS.toLocaleString()} 字送出摘要，結果可能不完整。</p>
      )}

      {output && (
        <div className="result">
          <div className="result-header">
            <h2>{output.report_title}</h2>
            <button onClick={handleDownload}>下載 JSON</button>
          </div>
          <p className="severity-summary">
            {SEVERITIES.map((s) => (
              <span key={s} className={`severity-badge severity-${s}`}>
                {s}: {output.severity_summary[s]}
              </span>
            ))}
          </p>
          <pre className="json-preview">{JSON.stringify(output, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}

export default App

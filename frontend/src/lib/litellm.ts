export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface VulnFinding {
  title: string
  severity: Severity
  cve: string[]
  cvss_score: number | null
  affected_assets: string[]
  description: string
  impact: string
  recommendation: string
}

export interface PdfSummary {
  report_title: string
  scan_target: string
  scan_date: string | null
  executive_summary: string
  severity_summary: Record<Severity, number>
  findings: VulnFinding[]
  key_recommendations: string[]
}

export interface SummarizeOptions {
  apiBase: string
  apiKey: string
  model: string
  fileName: string
  pageCount: number
  text: string
  maxChars: number
  signal?: AbortSignal
}

// 幫模型輸出長度設上限，避免它在 findings 很多、或陷入 harmony 分析頻道碎念時，
// 一路生到吃滿 context window（本機 ollama 目前跑起來是 32768 tokens）才停。
const MAX_RESPONSE_TOKENS = 8192

export interface SummarizeResult {
  data: PdfSummary
  truncated: boolean
}

const SYSTEM_PROMPT = `你是一個資安弱點掃描報告解析助理。使用者會提供弱點掃描報告 PDF 擷取出的純文字內容
（例如 Nessus、OpenVAS、Qualys、Burp Suite、Nuclei 等工具產出的報告），
請你分析內容並「只」輸出一個 JSON 物件，不要包含任何 Markdown 標記、程式碼區塊符號或額外說明文字。

JSON 物件必須符合以下結構，且欄位型別與命名不可更改（之後會直接匯入 Elasticsearch）：
{
  "report_title": string,          // 報告標題，找不到則自行歸納（例如「OO系統弱點掃描報告」）
  "scan_target": string,           // 受測範圍，例如主機/網域/IP range，找不到給空字串 ""
  "scan_date": string | null,      // 掃描日期，格式 "YYYY-MM-DD"；找不到給 null，不要猜測
  "executive_summary": string,     // 2-5 句話的整體摘要，給非技術主管看的
  "severity_summary": {            // 各風險等級的項目數量統計
    "critical": number,
    "high": number,
    "medium": number,
    "low": number,
    "info": number
  },
  "findings": [                    // 每一項弱點/發現各自一筆，不要合併
    {
      "title": string,             // 弱點名稱
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "cve": string[],             // 相關 CVE 編號，例如 ["CVE-2023-12345"]；沒有給空陣列 []
      "cvss_score": number | null, // CVSS 分數，找不到給 null，不要猜測
      "affected_assets": string[], // 受影響的主機/URL/服務，找不到給空陣列 []
      "description": string,       // 弱點說明
      "impact": string,            // 可能造成的影響
      "recommendation": string     // 修補建議
    }
  ],
  "key_recommendations": string[]  // 整份報告的優先修補建議，3-8 項
}

severity 只能使用上述五個固定值之一（全部小寫）。若報告中的風險分級名稱不同（例如「嚴重」「高」「中」「低」「資訊」），
請對應轉換為 critical/high/medium/low/info。`

function buildUserPrompt(text: string, truncated: boolean) {
  const note = truncated
    ? '\n\n（注意：內容過長，以下為擷取的前段內容，請根據現有內容盡力摘要。）'
    : ''
  return `請閱讀以下 PDF 內容並依照系統指示輸出 JSON：${note}\n\n"""\n${text}\n"""`
}

function extractJsonObject(raw: string): PdfSummary {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('模型未回傳有效的 JSON 內容')
    }
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

export async function summarizePdf(options: SummarizeOptions): Promise<SummarizeResult> {
  const { apiBase, apiKey, model, text, maxChars, signal } = options
  const truncated = text.length > maxChars
  const content = truncated ? text.slice(0, maxChars) : text

  const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(content, truncated) },
      ],
      temperature: 0.2,
      max_tokens: MAX_RESPONSE_TOKENS,
      response_format: { type: 'json_object' },
    }),
    signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`LiteLLM 呼叫失敗 (${response.status}): ${errText || response.statusText}`)
  }

  const payload = await response.json()
  const rawContent: string | undefined = payload?.choices?.[0]?.message?.content
  if (!rawContent) {
    throw new Error('模型回應中沒有內容')
  }

  return { data: extractJsonObject(rawContent), truncated }
}

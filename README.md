# liteLLM Proxy

使用 [LiteLLM](https://github.com/BerriAI/litellm) 建立的統一 LLM Proxy，透過同一組 OpenAI 相容 API（`/v1/chat/completions`）同時呼叫：

- **雲端模型**：Anthropic Claude（例如 `claude-haiku-4-5`）
- **本地模型**：透過 [Ollama](https://ollama.com/) 執行的開源模型（例如 `gpt-oss:20b`）

## 環境需求

- [Docker](https://www.docker.com/) / Docker Compose
- [Ollama](https://ollama.com/)（需在本機另外安裝並啟動，供 Docker 容器透過 `host.docker.internal` 連線）
- 一組有效的 `ANTHROPIC_API_KEY`（在 [Anthropic Console](https://console.anthropic.com/) 申請並儲值 API credits；與 Claude Pro 訂閱是不同帳務系統）

## 設定步驟

1. 複製環境變數範本並填入自己的密鑰：

   ```bash
   cp .env.example .env
   ```

   接著編輯 `.env`，至少要填：

   | 變數 | 說明 |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | Anthropic API 金鑰 |
   | `LITELLM_MASTER_KEY` | 呼叫 proxy 時的 `Authorization: Bearer <key>` |
   | `DATABASE_URL` | litellm 用來存模型設定的 Postgres 連線字串（預設值可直接用） |
   | `VIRTUAL_KEY` | 選用，供 UI 建立的虛擬金鑰 |

2. 安裝並啟動 Ollama，下載要使用的本地模型：

   ```bash
   ollama pull gpt-oss:20b
   ollama list   # 確認模型已下載
   ```

3. 於 `config.yaml` 中設定要代理的模型清單（已包含 Anthropic 與 Ollama 範例）。

## 啟動

```bash
docker compose up -d
```

- Proxy 監聽在 `http://localhost:4000`
- Postgres（儲存模型設定）監聽在 `localhost:5432`

## 測試

呼叫雲端 Claude 模型：

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-haiku-4-5",
    "messages": [
      { "role": "system", "content": "你是一個樂於助人的 AI 助理。" },
      { "role": "user", "content": "請簡單說明什麼是多模型代理架構。" }
    ]
  }'
```

呼叫本地 Ollama 模型：

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "ollama/gpt-oss:20b",
    "messages": [
      { "role": "user", "content": "請簡單說明什麼是多模型代理架構。" }
    ]
  }'
```

查看目前 proxy 認得的所有模型：

```bash
curl -s http://localhost:4000/v1/models -H "Authorization: Bearer ${LITELLM_MASTER_KEY}"
```

## 注意事項

- `.env` 內含實際密鑰，已列入 `.gitignore`，**請勿提交到版本控制**。
- Anthropic API 為用量計費，需在 Console 另行儲值 credits，與 ChatGPT/Claude Pro 等訂閱制方案無關。

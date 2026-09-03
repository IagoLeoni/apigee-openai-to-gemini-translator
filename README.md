[English](README.md) | [Português (Brasil)](README.pt-BR.md)

# LLM Gateway on Apigee X — OpenAI Surface over Vertex AI Gemini

An Apigee X proxy that exposes the **OpenAI Chat Completions** API contract to AI agents and converts it in-flight to the **Vertex AI `:generateContent`** contract on Model Garden. Your agents continue using the standard OpenAI SDK without any code changes; the backend is Gemini.

```
Agent (OpenAI SDK)  ──POST /llm/v1/chat/completions──▶  Apigee X  ──▶  Vertex AI Model Garden
       header: x-apikey                                 llm-gateway-v1        gemini-3.7-flash
                                                                              gemini-3.1-flash-lite
```

---

## 1. Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Client Surface | `/llm/v1/chat/completions` | With base path `/llm`, the SDK `base_url` becomes `https://host/llm/v1`. Zero changes needed in agent client code. |
| Translation | `Javascript` policies (Rhino/ES5) | The GPT↔Gemini schema mapping is not 1-to-1 (roles, tool calling, multimodal, thinking tokens). AssignMessage and XSL are insufficient; JS is the standard declarative approach inside the proxy. |
| Routing | `RouteRule` based on `llm.model.alias` | Meets the requirement to route based on the body's `model` field, providing per-model isolation: independent timeouts, retries, and circuit breakers. |
| Client Authentication | `VerifyAPIKey` on `request.header.x-apikey` | Automatically resolves App, Developer, and API Product — populating analytics dimensions and quota counters without extra overhead. |
| Backend Authentication | `<GoogleAccessToken>` in TargetEndpoint | Apigee assumes the deployment Service Account. No Vertex AI API keys circulate, and no credentials need to be stored in KVM. |
| Configuration | Environment KVM `llm-gateway-config` | Switching region, project, or model catalog is done purely via KVM updates. No redeployment or rebuild required. |
| Telemetry | `DataCapture` + Data Collectors | LLM tokens become native dimensions/metrics in Apigee Analytics, with direct export capability to BigQuery. |
| Audit & Logs | `MessageLogging` (Cloud Logging) | Asynchronous dispatch in `PostClientFlow` with full payload (prompt, response, metadata, tokens) without adding latency to the client response. |

**Alternative pattern considered:** A single TargetEndpoint with dynamic `target.url` eliminates RouteRules and makes adding new models a single-line KVM change. It was omitted because the requirements specify explicit routing and per-model operational isolation (timeouts, failover, segmented spike arrest). The bundle supports both — see Section 8.

---

## 2. Execution Flow

**Request**

1. `AM-CorsPreflight` — handles CORS `OPTIONS` preflight requests immediately without calling the backend.
2. `SA-SpikeArrest` — protects against sudden IP-level traffic spikes (60 req/s).
3. `VA-VerifyApiKey` — validates `x-apikey`, populating `developer.app.name`, `client_id`, and API Product.
4. `Q-RequestQuota` — enforces request rate quota per app as inherited from the API Product.
5. `KVM-LoadGatewayConfig` — loads Vertex host/project/region and `model_map` from KVM (cached for 300s).
6. `EV-ExtractRequestFields` — extracts `$.model` → `llm.model.alias` (read by RouteRules), `$.stream`, and `$.user`.
7. `JS-OpenAIToGemini` — validates and transforms the entire JSON payload to Gemini format.
8. `RF-ClientError` — returns standard OpenAI error responses immediately if validation fails.
9. `LTQ-TokenEnforce` — verifies LLM token quota availability before forwarding to the upstream model.
10. `AM-CleanTargetRequest` — strips client `x-apikey` and incoming `Authorization` headers before calling Vertex AI.
11. RouteRule selects `gemini-flash` or `gemini-flash-lite`.
12. `AM-SetVertexTarget` — constructs the full target URL.

**Response**

13. `JS-VertexErrorToOpenAI` — normalizes non-200 Vertex AI error responses into OpenAI error envelopes.
14. `JS-GeminiToOpenAI` — constructs the `chat.completion` response payload and exports `llm.usage.*` variables.
15. `LTQ-TokenCount` — debits consumed tokens against the API Product / App token quota.
16. `JS-SseEmulation` — converts the response to Server-Sent Events (SSE) format when `stream: true`.
17. `DC-LlmUsage` — records token metrics into Data Collectors (runs in both PostFlow and DefaultFaultRule).
18. `AM-AddCorsAndTrace` — attaches response headers: `x-request-id`, `x-llm-model`, and `x-llm-total-tokens`.
19. `JS-PrepareCloudLog` — structures the complete JSON payload for Google Cloud Logging.
20. `ML-LogToCloudLogging` (in `PostClientFlow`) — dispatches structured logs asynchronously to Cloud Logging after the response has been delivered to the client.

The target `success.codes` is explicitly set to `1xx,2xx,3xx,4xx,5xx` to allow custom JavaScript error normalization policies to execute even on Vertex 429/5xx responses.

---

## 3. Schema Mapping

### Request — OpenAI → Gemini

| OpenAI | Gemini | Note |
|---|---|---|
| `model` | path `.../models/{id}:generateContent` | Resolved via `model_map` in KVM |
| `messages[].role: system` \| `developer` | `systemInstruction.parts[].text` | Multiple system messages are concatenated with `\n\n` |
| `messages[].role: user` | `contents[].role: user` | |
| `messages[].role: assistant` | `contents[].role: model` | |
| `messages[].role: tool` | `contents[].parts[].functionResponse` | Function name resolved from preceding turn's `tool_call_id` |
| `content: "text"` | `parts[{text}]` | |
| `content: [{type:image_url}]` — data URL | `parts[{inlineData:{mimeType,data}}]` | |
| `content: [{type:image_url}]` — `gs://` / `https://` | `parts[{fileData:{mimeType,fileUri}}]` | |
| `tool_calls[].function` | `parts[{functionCall:{name,args}}]` | `arguments` (JSON string) → `args` (parsed object) |
| `tools[].function` | `tools[0].functionDeclarations[]` | Sanitized JSON Schema |
| `tool_choice: none/auto/required` | `toolConfig.functionCallingConfig.mode: NONE/AUTO/ANY` | |
| `tool_choice: {function:{name}}` | `mode: ANY` + `allowedFunctionNames` | |
| `max_tokens` \| `max_completion_tokens` | `generationConfig.maxOutputTokens` | Capped by model max token limits in KVM |
| `temperature` / `top_p` / `seed` | `temperature` / `topP` / `seed` | |
| `stop` | `stopSequences` | String converted to array |
| `n` | `candidateCount` | |
| `presence_penalty` / `frequency_penalty` | `presencePenalty` / `frequencyPenalty` | |
| `response_format: json_object` | `responseMimeType: application/json` | |
| `response_format: json_schema` | `responseMimeType` + `responseSchema` | |
| `reasoning_effort` | `thinkingConfig.thinkingBudget` | minimal: 0, low: 1024, medium: 8192, high: 24576 |
| `logprobs` / `top_logprobs` | `responseLogprobs` / `logprobs` | |

**Explicitly handled edge cases:**

- **JSON Schema Sanitization:** Gemini accepts a strict subset of OpenAPI Schema. Unsupported keywords like `$schema`, `additionalProperties`, and `definitions` trigger `400 INVALID_ARGUMENT`. The `sanitizeSchema()` function performs recursive allow-listing.
- **Consecutive Same-Role Turns:** OpenAI SDK clients can produce sequences of consecutive user or assistant messages that Gemini rejects or handles poorly. Consecutive turns of the same role are automatically merged into a single `content` turn.

### Response — Gemini → OpenAI

| Gemini | OpenAI |
|---|---|
| `candidates[].content.parts[].text` | `choices[].message.content` |
| `parts[].thought: true` | **discarded** (internal reasoning thoughts are kept private) |
| `candidates[].content.parts[].functionCall` | `choices[].message.tool_calls[]` |
| `finishReason: STOP` | `stop` |
| `finishReason: MAX_TOKENS` | `length` |
| `finishReason: SAFETY` \| `RECITATION` \| `BLOCKLIST` \| `PROHIBITED_CONTENT` \| `SPII` | `content_filter` |
| `promptFeedback.blockReason` | `choices[0].finish_reason: content_filter` + `refusal` |
| `usageMetadata.promptTokenCount` | `usage.prompt_tokens` |
| `candidatesTokenCount` + `thoughtsTokenCount` | `usage.completion_tokens` |
| `thoughtsTokenCount` | `usage.completion_tokens_details.reasoning_tokens` |
| `cachedContentTokenCount` | `usage.prompt_tokens_details.cached_tokens` |
| `totalTokenCount` | `usage.total_tokens` |

Key accounting detail: **Thinking tokens are billed**. In the OpenAI schema, they are accounted under `completion_tokens` with detailed breakdown in `completion_tokens_details.reasoning_tokens`. Summing only `candidatesTokenCount` significantly underestimates actual costs on reasoning models.

---

## 4. Token Telemetry & Governance

Nine Data Collectors (`type` in parentheses):

| Data Collector | Type | Source |
|---|---|---|
| `dc_llm_model` | STRING | Requested model alias |
| `dc_llm_prompt_tokens` | INTEGER | `usageMetadata.promptTokenCount` |
| `dc_llm_completion_tokens` | INTEGER | `candidatesTokenCount` + `thoughtsTokenCount` |
| `dc_llm_total_tokens` | INTEGER | `usageMetadata.totalTokenCount` |
| `dc_llm_cached_tokens` | INTEGER | `cachedContentTokenCount` |
| `dc_llm_reasoning_tokens` | INTEGER | `thoughtsTokenCount` |
| `dc_llm_finish_reason` | STRING | Mapped finish reason |
| `dc_llm_app` | STRING | `developer.app.name` |
| `dc_llm_end_user` | STRING | Payload `user` field |

Key rules and recommendations:

- All Data Collector names **must** start with `dc_`.
- Numeric collectors serve as both metrics (with aggregations) and dimensions; string collectors serve only as dimensions.
- Only **one** policy should write to each collector per transaction (subsequent writes overwrite).
- In Pay-as-you-go organizations, `DataCapture` requires the **Apigee API Analytics** add-on enabled.
- New data appears in custom reports with a ~30 min propagation window upon initial setup.

For cost dashboards, export analytics data to BigQuery and join with your model pricing table. App-level allocation is extracted from `dc_llm_app`, and end-user attribution is extracted from `dc_llm_end_user`.

### Token Governance & Quotas (`LLMTokenQuota`)

The default quota of **1,000,000 tokens/month** configured in the API Product debits tokens using `llm.usage.total_tokens` in [`LTQ-TokenCount.xml`](apiproxy/policies/LTQ-TokenCount.xml).

#### 1. Which Tokens Count Towards the Quota?
The total debited token count is:
$$\text{Total Debited} = \text{Prompt Tokens (Input)} + \text{Completion Tokens (Output)} + \text{Reasoning Tokens (Thinking)}$$

* **Input (Prompt)**: `usageMetadata.promptTokenCount` (text + converted image/audio tokens).
* **Output (Completion)**: `candidatesTokenCount` (generated output text and function calls).
* **Reasoning (Thinking)**: `thoughtsTokenCount` (Gemini internal reasoning tokens).

#### 2. Market Best Practices
* **FinOps Protection & Budget Caps:** AI cloud providers (Vertex AI, OpenAI, Anthropic) bill for both input and output tokens. Enforcing quotas on **Total Tokens** is the market standard to prevent unexpected billing spikes and maintain budget boundaries per application.
* **Mitigating Thinking Token Explosions:** On models with reasoning enabled (`thinkingConfig`), internal thinking token counts can be substantial. Enforcing `total_tokens` prevents concise prompts from triggering high untracked compute costs.
* **Three-Tier Defense Architecture:**
  1. `SA-SpikeArrest`: Immediate IP-level burst protection (60 req/s).
  2. `Q-RequestQuota`: App-level request rate limiting (600 req/min).
  3. `LTQ-TokenEnforce` / `LTQ-TokenCount`: App-level volumetric token consumption caps (e.g., 1M tokens/month).

> [!TIP]
> If your organization prefers to bill only *Output Tokens* or apply custom weighting factors, update the `<LLMTokenUsageSource>` element in [`LTQ-TokenCount.xml`](apiproxy/policies/LTQ-TokenCount.xml) to `{llm.usage.completion_tokens}` or to a custom variable with your weighted formula.

### Complete Audit Trail in Cloud Logging (`MessageLogging`)

The gateway integrates natively with **Google Cloud Logging** through the `PostClientFlow`, ensuring 100% of transactions are logged asynchronously **without adding latency** to the client response.

#### 1. Structured JSON Payload
[`prepare-cloud-log.js`](apiproxy/resources/jsc/prepare-cloud-log.js) consolidates metadata, token usage, and full request/response bodies:

```json
{
  "timestamp": 1788377407,
  "messageId": "38525ed5-6e29-48a7-b562-6414889357c941",
  "proxy": "llm-gateway-v1",
  "environment": "prod",
  "clientIp": "35.191.131.113",
  "developerApp": "agente-piloto",
  "developerEmail": "iagoleoni@google.com",
  "apiProduct": "llm-gateway-standard",
  "httpMethod": "POST",
  "path": "/v1/chat/completions",
  "statusCode": 200,
  "model": "gemini-3.7-flash",
  "modelId": "gemini-2.5-flash",
  "endUser": "user-123",
  "isStreaming": false,
  "usage": {
    "promptTokens": 9,
    "completionTokens": 615,
    "reasoningTokens": 611,
    "totalTokens": 624
  },
  "finishReason": "stop",
  "requestPayload": { "contents": [...] },
  "responsePayload": { "choices": [...] }
}
```

#### 2. Querying via gcloud / Logs Explorer
Logs are written to `projects/{PROJECT_ID}/logs/apigee-llm-gateway`:

```bash
# View recent LLM gateway logs
gcloud logging read 'logName="projects/'${PROJECT_ID}'/logs/apigee-llm-gateway"' --limit=5 --format=json

# Filter logs by developer application
gcloud logging read 'logName="projects/'${PROJECT_ID}'/logs/apigee-llm-gateway" AND jsonPayload.developerApp="agente-piloto"' --limit=10
```

---

## 5. Deployment

```bash
cd deploy
cp config.env.example config.env && vim config.env

./00-enable-apis.sh          # apigee + aiplatform
./01-service-account.sh      # SA + roles/aiplatform.user + tokenCreator + logging.logWriter
./02-create-datacollectors.sh
./03-create-kvm.sh           # vertex_host/project/location + model_map
./04-deploy-proxy.sh         # zip + import + deploy with serviceAccount
./05-create-product-app.sh   # create API Product with LLM Operations and Developer App
./06-create-custom-report.sh # create Custom Report in Apigee Analytics
```

The `serviceAccount=` parameter during deployment is mandatory — without it, the `<GoogleAccessToken>` target element cannot mint tokens and upstream Vertex AI calls will return 401 Unauthorized.

Validation:

```bash
export APIGEE_HOST=34.49.232.218.nip.io
export APIKEY=<consumerKey>
./tests/smoke-tests.sh          # 10 automated end-to-end test scenarios
python tests/openai_sdk_test.py # OpenAI official SDK compatibility test
```

The JS translators can also run outside Apigee: `node tests/harness.js` simulates Apigee's `context` object and executes 40+ unit assertions across both translation directions.

---

## 6. Streaming

The bundle uses **SSE emulation**: upstream Vertex AI calls are non-streaming, and the response is re-packaged into standard SSE chunks (`data: {...}` + `data: [DONE]`). OpenAI SDK clients configured with `stream=True` work out-of-the-box.

**Trade-off note:** There is **no reduction in time-to-first-token (TTFT)**. The client receives the complete response once generated, formatted as an SSE stream.

*Real Streaming (Option B):* A dedicated flow with `response.streaming.enabled=true` and `:streamGenerateContent?alt=sse` in the target endpoint delivers live tokens. The trade-off: response policies cannot inspect or transform the streamed payload body, meaning (a) the client receives Gemini SSE events rather than OpenAI chunks, and (b) `DataCapture` can only record final token values observed. For real streaming, a dedicated flow with a client-side adapter is recommended.

---

## 7. Limits & Technical Notes

- **Rhino/ES5 Engine:** Do not use `let`, `const`, arrow functions, template literals, or ES6+ array methods in JavaScript resources.
- **In-Memory Payloads:** Multimodal requests with large base64 inline images increase Message Processor memory consumption. For large attachments, prefer Cloud Storage URIs (`gs://`), which are supported via `fileData`.
- **Token Quota & Model Authorization:** Implemented natively using `LLMTokenQuota` (`LTQ-TokenEnforce` and `LTQ-TokenCount`) bound to the API Product's `llmOperationGroup`, enforcing monthly token ceilings and granular model access.
- **Asynchronous Audit Logging:** Handled via `ML-LogToCloudLogging` in `PostClientFlow`. Does not delay or block HTTP delivery to the client.
- **Model IDs:** `gemini-3.7-flash` and `gemini-3.1-flash-lite` are configured as aliases and `id`s in `model_map`. Verify publisher model IDs in Model Garden for your target region; update the KVM entry if needed without redeploying the proxy.
- **Region Configuration:** When using `vertex_location=global`, `vertex_host` must be `aiplatform.googleapis.com` (without a regional prefix).

---

## 8. Roadmap & Extensions

| Next Step | Implementation |
|---|---|
| Additional Models | Add entry to KVM `model_map` + 1 RouteRule + 1 TargetEndpoint |
| Large Model Catalog | Migrate to a single TargetEndpoint with dynamic `target.url` (`AM-SetVertexTarget` already builds the dynamic URL) |
| Safety Guardrails | `SanitizeUserPrompt` / `SanitizeModelResponse` (Model Armor) in PreFlow and Response flows |
| Semantic Caching | `SemanticCacheLookup` / `SemanticCachePopulate` — reduces cost and latency on frequent prompts |
| Automated Failover | `LoadBalancer` failover from Flash to Flash-Lite on 429/503 responses |
| Multi-Provider Support | Add translation scripts for additional dialects (Anthropic, Mistral); incoming contract remains OpenAI |
| PII Masking | JavaScript policy or Model Armor filter to mask sensitive PII before shipping payloads to Cloud Logging |

---

## 9. Bundle Structure

```
apiproxy/
  llm-gateway-v1.xml
  proxies/default.xml                    Base path /llm, flows, RouteRules, FaultRules, PostClientFlow
  targets/gemini-flash.xml               Vertex + GoogleAccessToken (primary model)
  targets/gemini-flash-lite.xml          Target for lite model with lower timeout
  policies/                              24 policies (AssignMessage, DataCapture, LLMTokenQuota, MessageLogging, etc.)
  resources/jsc/
    llm-common.js                        ES5 shared helper library
    openai-to-gemini.js                  Request payload translator
    gemini-to-openai.js                  Response payload translator + token metrics
    prepare-cloud-log.js                 JSON structuring for Cloud Logging
    sse-emulation.js                     Server-Sent Events emulator (stream: true)
    vertex-error-to-openai.js            Error envelope normalizer
    list-models.js                       GET /v1/models mock response generator
deploy/                                  7 idempotent automation scripts (00 to 06 + config)
tests/                                   Offline harness, smoke tests, OpenAI SDK verification
```

---

## License

All solutions within this repository are provided under the [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) license. Please see the [LICENSE](https://github.com/GoogleCloudPlatform/apigee-samples/blob/main/LICENSE.txt) file for more detailed terms and conditions.

## Not Google Product Clause

This is not an officially supported Google product, nor is it part of an official Google product.

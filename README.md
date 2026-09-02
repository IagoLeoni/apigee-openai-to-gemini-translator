# LLM Gateway no Apigee X — superfície OpenAI sobre Vertex AI Gemini

Proxy que expõe o contrato **OpenAI Chat Completions** para os agentes e converte, em voo, para o
contrato **Vertex AI `:generateContent`** do Model Garden. O agente continua usando o SDK da OpenAI
sem alteração de código; o backend é Gemini.

```
Agente (SDK OpenAI)  ──POST /llm/v1/chat/completions──▶  Apigee X  ──▶  Vertex AI Model Garden
       header: x-apikey                                  llm-gateway-v1        gemini-3.7-flash
                                                                               gemini-3.1-flash-lite
```

---

## 1. Decisões de arquitetura

| Decisão | Escolha | Por quê |
|---|---|---|
| Superfície do cliente | `/llm/v1/chat/completions` | Com base path `/llm`, o `base_url` do SDK vira `https://host/llm/v1`. Zero mudança no agente. |
| Tradução | Policies `Javascript` (Rhino/ES5) | O mapeamento GPT↔Gemini não é 1-para-1 (roles, tools, multimodal, thinking). AssignMessage/XSL não dão conta; JS é a única opção declarativa dentro do proxy. |
| Roteamento | `RouteRule` sobre `llm.model.alias` | Atende ao requisito de rotear pelo campo `model` do body, e dá isolamento por modelo: timeout, retry e circuit breaker independentes. |
| Autenticação do cliente | `VerifyAPIKey` sobre `request.header.x-apikey` | Traz junto app, developer e produto — que viram dimensões de analytics e base de quota, sem trabalho extra. |
| Autenticação no backend | `<GoogleAccessToken>` no TargetEndpoint | O Apigee assume a service account de deploy. Não existe chave de API do Vertex circulando, nem segredo no KVM. |
| Configuração | KVM de environment `llm-gateway-config` | Trocar região, projeto ou catálogo de modelos vira edição de KVM. Sem redeploy, sem rebuild. |
| Telemetria | `DataCapture` + data collectors | Tokens viram dimensão/métrica nativa do Apigee Analytics, com export para BigQuery. |

**Padrão alternativo considerado:** um único TargetEndpoint com `target.url` dinâmico elimina as
RouteRules e faz "adicionar modelo" ser só uma linha no KVM. Ficou de fora porque o requisito pede
roteamento explícito e porque perde-se o controle por modelo (timeout, failover, spike arrest
segmentado). O bundle está preparado para os dois — ver seção 8.

---

## 2. Fluxo de execução

**Request**

1. `AM-CorsPreflight` — responde `OPTIONS` sem tocar no backend.
2. `SA-SpikeArrest` — protege contra rajada por IP (60/s).
3. `VA-VerifyApiKey` — valida `x-apikey`, popula `developer.app.name`, `client_id`, produto.
4. `Q-RequestQuota` — quota por app, herdada do API product.
5. `KVM-LoadGatewayConfig` — carrega host/projeto/região do Vertex e o `model_map` (cache 300s).
6. `EV-ExtractRequestFields` — extrai `$.model` → `llm.model.alias` (é isso que a RouteRule lê), `$.stream`, `$.user`.
7. `JS-OpenAIToGemini` — valida e reescreve o payload inteiro.
8. `RF-ClientError` — se a validação reprovou, devolve erro no envelope OpenAI e encerra.
9. `AM-CleanTargetRequest` — remove `x-apikey` e qualquer `Authorization` do cliente antes do upstream.
10. RouteRule seleciona `gemini-flash` ou `gemini-flash-lite`.
11. `AM-SetVertexTarget` — monta `target.url` completo.

**Response**

12. `JS-VertexErrorToOpenAI` — se `status != 200`, normaliza o erro do Vertex para o envelope OpenAI.
13. `JS-GeminiToOpenAI` — monta o objeto `chat.completion` e publica `llm.usage.*`.
14. `JS-SseEmulation` — só quando `stream: true`.
15. `DC-LlmUsage` — grava nos data collectors (PostFlow **e** DefaultFaultRule, para não perder tokens em chamadas que falharam no meio).
16. `AM-AddCorsAndTrace` — headers `x-request-id`, `x-llm-model`, `x-llm-total-tokens`.

O `success.codes` do target está como `1xx,2xx,3xx,4xx,5xx` **de propósito**: sem isso o Apigee
levanta fault no 429 do Vertex e a policy de normalização de erro nunca roda.

---

## 3. Mapeamento de schema

### Request — OpenAI → Gemini

| OpenAI | Gemini | Nota |
|---|---|---|
| `model` | path `.../models/{id}:generateContent` | Resolvido via `model_map` no KVM |
| `messages[].role: system` \| `developer` | `systemInstruction.parts[].text` | Múltiplos systems são concatenados com `\n\n` |
| `messages[].role: user` | `contents[].role: user` | |
| `messages[].role: assistant` | `contents[].role: model` | |
| `messages[].role: tool` | `contents[].parts[].functionResponse` | Nome resolvido pelo `tool_call_id` do turno anterior |
| `content: "texto"` | `parts[{text}]` | |
| `content: [{type:image_url}]` — data URL | `parts[{inlineData:{mimeType,data}}]` | |
| `content: [{type:image_url}]` — `gs://` / `https://` | `parts[{fileData:{mimeType,fileUri}}]` | |
| `tool_calls[].function` | `parts[{functionCall:{name,args}}]` | `arguments` (string) → `args` (objeto) |
| `tools[].function` | `tools[0].functionDeclarations[]` | JSON Schema sanitizado |
| `tool_choice: none/auto/required` | `toolConfig.functionCallingConfig.mode: NONE/AUTO/ANY` | |
| `tool_choice: {function:{name}}` | `mode: ANY` + `allowedFunctionNames` | |
| `max_tokens` \| `max_completion_tokens` | `generationConfig.maxOutputTokens` | Limitado pelo teto do modelo no KVM |
| `temperature` / `top_p` / `seed` | `temperature` / `topP` / `seed` | |
| `stop` | `stopSequences` | String vira array |
| `n` | `candidateCount` | |
| `presence_penalty` / `frequency_penalty` | `presencePenalty` / `frequencyPenalty` | |
| `response_format: json_object` | `responseMimeType: application/json` | |
| `response_format: json_schema` | `responseMimeType` + `responseSchema` | |
| `reasoning_effort` | `thinkingConfig.thinkingBudget` | minimal 0, low 1024, medium 8192, high 24576 |
| `logprobs` / `top_logprobs` | `responseLogprobs` / `logprobs` | |

**Duas armadilhas tratadas explicitamente:**

- **Sanitização de JSON Schema.** O Gemini aceita só um subconjunto do OpenAPI Schema. Campos como
  `$schema`, `additionalProperties` e `definitions` causam `400 INVALID_ARGUMENT`. A função
  `sanitizeSchema()` faz allow-list recursiva.
- **Turnos consecutivos do mesmo role.** O SDK OpenAI produz sequências que o Gemini rejeita ou
  degrada. Mensagens consecutivas do mesmo role são fundidas em um único `content`.

### Response — Gemini → OpenAI

| Gemini | OpenAI |
|---|---|
| `candidates[].content.parts[].text` | `choices[].message.content` |
| `parts[].thought: true` | **descartado** (raciocínio interno não vaza para o cliente) |
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

O ponto de atenção na contabilidade: **thinking tokens são faturados**. No schema OpenAI eles vivem
dentro de `completion_tokens`, com detalhamento em `reasoning_tokens`. Somar apenas
`candidatesTokenCount` subestima o custo real — em modelos com raciocínio, bastante.

---

## 4. Telemetria de tokens

Nove data collectors (`type` entre parênteses):

| Data collector | Tipo | Origem |
|---|---|---|
| `dc_llm_model` | STRING | alias solicitado |
| `dc_llm_prompt_tokens` | INTEGER | `usageMetadata.promptTokenCount` |
| `dc_llm_completion_tokens` | INTEGER | `candidatesTokenCount` + `thoughtsTokenCount` |
| `dc_llm_total_tokens` | INTEGER | `usageMetadata.totalTokenCount` |
| `dc_llm_cached_tokens` | INTEGER | `cachedContentTokenCount` |
| `dc_llm_reasoning_tokens` | INTEGER | `thoughtsTokenCount` |
| `dc_llm_finish_reason` | STRING | mapeado |
| `dc_llm_app` | STRING | `developer.app.name` |
| `dc_llm_end_user` | STRING | campo `user` do payload |

Regras que valem a pena reter:

- Todo nome **precisa** começar com `dc_`.
- Numérico serve como métrica (com agregação) e como dimensão; string só como dimensão.
- Só **uma** policy deve gravar em cada data collector — a última execução sobrescreve.
- Em orgs Pay-as-you-go, a `DataCapture` exige o add-on **Apigee API Analytics** habilitado.
- Dados novos aparecem em custom reports com atraso de ~30 min na primeira vez.

Para dashboards de custo, exporte a analytics para BigQuery e junte com a tabela de preço por modelo
(`analytics/export-data`). O rateio por time sai de `dc_llm_app`; o rateio por usuário final, de
`dc_llm_end_user`.

### Governança e Cota de Tokens (`LLMTokenQuota`)

A cota padrão de **1.000.000 tokens/mês** configurada no API Product utiliza como fonte de débito a variável `llm.usage.total_tokens` na policy `LTQ-TokenCount.xml`.

#### 1. Quais tokens são contabilizados na Cota?
O total debitado corresponde a:
$$\text{Total Debitado} = \text{Prompt Tokens (Input)} + \text{Completion Tokens (Output)} + \text{Reasoning Tokens (Thinking)}$$

* **Input (Prompt)**: `usageMetadata.promptTokenCount` (texto + imagens/áudio convertidos).
* **Output (Completion)**: `candidatesTokenCount` (texto e chamadas de função geradas).
* **Reasoning (Thinking)**: `thoughtsTokenCount` (tokens de raciocínio interno do Gemini).

#### 2. Melhor Prática de Mercado
* **Proteção FinOps & Budget Caps**: Provedores de IA (Vertex AI, OpenAI, Anthropic) faturam tanto tokens de entrada quanto de saída. Estabelecer a cota sobre o **Total de Tokens** é o padrão de mercado para evitar surpresas no faturamento e garantir isolamento orçamentário por time/App.
* **Mitigação de Explosão de Thinking Tokens**: Em modelos com raciocínio (`thinkingConfig`), o volume de tokens internos pode ser expressivo. Contabilizar `total_tokens` impede que prompts aparentemente curtos gerem custos desproporcionais sem controle de cota.
* **Defesa em 3 Camadas**:
  1. `SA-SpikeArrest`: Proteção contra rajadas imediatas por IP (60 req/s).
  2. `Q-RequestQuota`: Limite de frequência de requisições por App (600 req/min).
  3. `LTQ-TokenEnforce` / `LTQ-TokenCount`: Limite volumétrico de consumo de tokens por App (ex: 1M tokens/mês).

> [!TIP]
> Caso sua organização opte por tarifar apenas *Output Tokens* ou aplicar pesos distintos, basta alterar a tag `<LLMTokenUsageSource>` em [`LTQ-TokenCount.xml`](file:///usr/local/google/home/iagoleoni/projects-fde/l300/apigee-gpt-gemini/apigee-proxy-deploy/apiproxy/policies/LTQ-TokenCount.xml) para `{llm.usage.completion_tokens}` ou para uma variável customizada com fórmula de ponderação.

---

## 5. Deploy

```bash
cd deploy
cp config.env.example config.env && vim config.env

./00-enable-apis.sh          # apigee + aiplatform
./01-service-account.sh      # SA + roles/aiplatform.user + tokenCreator
./02-create-datacollectors.sh
./03-create-kvm.sh           # vertex_host/project/location + model_map
./04-deploy-proxy.sh         # zip + import + deploy com serviceAccount
./05-create-product-app.sh   # cria API Product com LLM Operations e app
./06-create-custom-report.sh # cria Custom Report de consumo no Apigee Analytics
```

O `serviceAccount=` no deploy é obrigatório — sem ele o `<GoogleAccessToken>` do target não funciona
e toda chamada retorna 401 do Vertex.

Validação:

```bash
export APIGEE_HOST=34.49.232.218.nip.io
export APIKEY=<consumerKey>
./tests/smoke-tests.sh          # 10 cenários, incluindo os caminhos de erro
python tests/openai_sdk_test.py # prova de compatibilidade com o SDK oficial
```

Os tradutores também rodam fora do Apigee: `node tests/harness.js` simula o objeto `context` e
executa 40+ asserções sobre os dois sentidos da tradução. Vale plugar no CI antes do import.

---

## 6. Streaming

O bundle usa **emulação SSE**: a chamada ao Vertex é não-streaming e a resposta é reempacotada em
frames `data: {...}` + `data: [DONE]`. SDKs OpenAI com `stream=True` funcionam sem mudança.

A limitação é honesta: **não há ganho de time-to-first-token**. O cliente recebe tudo de uma vez,
formatado como stream.

*Modo B — streaming real.* Um flow separado com `response.streaming.enabled=true` e
`:streamGenerateContent?alt=sse` no target entrega tokens de verdade. O custo: policies de resposta
não rodam sobre o corpo, então (a) o cliente recebe o SSE no formato Gemini, não OpenAI, e (b) a
captura de tokens pela `DataCapture` fica limitada — em SSE ela grava apenas o último valor
observado. Se streaming real virar requisito, o caminho é um flow dedicado com um shim no cliente,
e não uma extensão deste.

---

## 7. Limites e pontos de atenção

- **Modelo Rhino/ES5.** Nada de `let`, `const`, arrow, template literal, `Array.prototype.includes`. Os scripts respeitam isso.
- **Payload em memória.** Requests multimodais com imagens em base64 sobem o consumo de memória do MP. Para anexos grandes, prefira `gs://` (o `fileData` já suporta).
- **Cota e Autorização de Tokens.** Implementado nativamente via `LLMTokenQuota` (`LTQ-TokenEnforce` e `LTQ-TokenCount`) vinculado ao `llmOperationGroup` do API Product, com limite mensal de tokens e autorização granular por modelo.
- **IDs dos modelos.** `gemini-3.7-flash` e `gemini-3.1-flash-lite` estão como aliases *e* como `id` no `model_map`. Confirme o publisher model id exato no Model Garden e na região escolhida antes do primeiro deploy — se divergir, basta editar o `id` no KVM, sem tocar no proxy.
- **Região.** Se usar `vertex_location=global`, o `vertex_host` precisa ser `aiplatform.googleapis.com` (sem prefixo de região).

---

## 8. Evolução natural

| Próximo passo | Como |
|---|---|
| Terceiro modelo | Entrada no `model_map` + uma RouteRule + um TargetEndpoint |
| Catálogo grande | Migrar para target único com `target.url` dinâmico (o `AM-SetVertexTarget` já monta a URL inteira; basta apontar as RouteRules para um só target) |
| Guardrails | Policies `SanitizeUserPrompt` / `SanitizeModelResponse` (Model Armor) no PreFlow e no Response |
| Cache semântico | `SemanticCacheLookup` / `SemanticCachePopulate` — corta custo em prompts repetidos |
| Failover | `LoadBalancer` com fallback do flash para o flash-lite em 429/503 |
| Multi-provider | Novo par de scripts de tradução por dialeto (Anthropic, Mistral); o contrato de entrada continua sendo OpenAI |
| Auditoria | `MessageLogging` para Cloud Logging no PostClientFlow, com máscara de PII |

---

## 9. Estrutura do bundle

```
apiproxy/
  llm-gateway-v1.xml
  proxies/default.xml                    base path /llm, flows, RouteRules, FaultRules
  targets/gemini-flash.xml               Vertex + GoogleAccessToken (modelo principal)
  targets/gemini-flash-lite.xml          idem, timeout menor
  policies/                              23 policies (AssignMessage, DataCapture, LLMTokenQuota, etc.)
  resources/jsc/
    llm-common.js                        helpers ES5 compartilhados
    openai-to-gemini.js                  tradução de request
    gemini-to-openai.js                  tradução de response + tokens
    sse-emulation.js                     stream: true
    vertex-error-to-openai.js            normalização de erro
    list-models.js                       GET /v1/models
deploy/                                  7 scripts idempotentes (00 a 06 + config)
tests/                                   harness offline, smoke tests, SDK OpenAI
```

---

## License

All solutions within this repository are provided under the [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) license. Please see the [LICENSE](https://github.com/GoogleCloudPlatform/apigee-samples/blob/main/LICENSE.txt) file for more detailed terms and conditions.

## Not Google Product Clause

This is not an officially supported Google product, nor is it part of an official Google product.

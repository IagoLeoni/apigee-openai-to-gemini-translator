#!/usr/bin/env bash
#
# Testes de fumaca contra o proxy implantado.
#   export APIGEE_HOST=api.minhaempresa.com.br
#   export APIKEY=<consumerKey do app>
#
set -uo pipefail
: "${APIGEE_HOST:?defina APIGEE_HOST}"
: "${APIKEY:?defina APIKEY}"
BASE="https://${APIGEE_HOST}/llm"

hr () { echo; echo "=============== $1 ==============="; }

hr "1. Health (sem apikey)"
curl -sS "${BASE}/health" | python3 -m json.tool

hr "2. Catalogo de modelos"
curl -sS "${BASE}/v1/models" -H "x-apikey: ${APIKEY}" | python3 -m json.tool

hr "3. Chat completion - gemini-3.7-flash"
curl -sS -X POST "${BASE}/v1/chat/completions" \
  -H "x-apikey: ${APIKEY}" -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.7-flash",
    "messages": [
      {"role": "system", "content": "Responda em uma frase."},
      {"role": "user", "content": "Explique o que e um API gateway."}
    ],
    "temperature": 0.2,
    "max_tokens": 200
  }' | python3 -m json.tool

hr "4. Roteamento para o modelo lite"
curl -sS -X POST "${BASE}/v1/chat/completions" \
  -H "x-apikey: ${APIKEY}" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.1-flash-lite","messages":[{"role":"user","content":"Diga oi."}]}' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("modelo:", d.get("model")); print("usage:", d.get("usage"))'

hr "5. Function calling"
curl -sS -X POST "${BASE}/v1/chat/completions" \
  -H "x-apikey: ${APIKEY}" -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.7-flash",
    "messages": [{"role":"user","content":"Qual o clima em Sao Paulo agora?"}],
    "tools": [{"type":"function","function":{
      "name":"get_weather",
      "description":"Consulta o clima atual de uma cidade",
      "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
    }}],
    "tool_choice": "auto"
  }' | python3 -m json.tool

hr "6. JSON mode"
curl -sS -X POST "${BASE}/v1/chat/completions" \
  -H "x-apikey: ${APIKEY}" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","response_format":{"type":"json_object"},
       "messages":[{"role":"user","content":"Liste 3 frutas como JSON com a chave frutas."}]}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'

hr "7. Streaming (SSE emulado)"
curl -sS -N -X POST "${BASE}/v1/chat/completions" \
  -H "x-apikey: ${APIKEY}" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","stream":true,"messages":[{"role":"user","content":"Conte ate 3."}]}'

hr "8. Modelo invalido (espera 404 no schema OpenAI)"
curl -sS -w "\nHTTP %{http_code}\n" -X POST "${BASE}/v1/chat/completions" \
  -H "x-apikey: ${APIKEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"oi"}]}'

hr "9. Sem apikey (espera 401)"
curl -sS -w "\nHTTP %{http_code}\n" -X POST "${BASE}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","messages":[{"role":"user","content":"oi"}]}'

hr "10. Rota inexistente (espera 404)"
curl -sS -w "\nHTTP %{http_code}\n" "${BASE}/v1/embeddings" -H "x-apikey: ${APIKEY}"

echo
echo "Confira os headers de rastreio: x-request-id, x-llm-model, x-llm-total-tokens"

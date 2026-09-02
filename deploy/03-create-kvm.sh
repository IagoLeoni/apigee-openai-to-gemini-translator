#!/usr/bin/env bash
#
# Cria o KVM de environment com a configuracao do backend Vertex e o catalogo de modelos.
# Trocar de modelo ou de regiao passa a ser edicao de KVM, sem redeploy do proxy.
#
set -euo pipefail
source "$(dirname "$0")/config.env"

TOKEN="$(gcloud auth print-access-token)"
BASE="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}/environments/${APIGEE_ENV}/keyvaluemaps"

curl -sS -X POST "$BASE" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d '{"name":"llm-gateway-config","encrypted":true}' > /dev/null || true

put_entry () {
  local key="$1" value="$2"
  curl -sS -X DELETE "${BASE}/llm-gateway-config/entries/${key}" -H "Authorization: Bearer ${TOKEN}" > /dev/null || true
  curl -sS -X POST "${BASE}/llm-gateway-config/entries" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"name":sys.argv[1],"value":sys.argv[2]}))' "$key" "$value")" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("-->", d.get("name") or d.get("error",{}).get("message"))'
}

put_entry vertex_host     "$VERTEX_HOST"
put_entry vertex_project  "$VERTEX_PROJECT"
put_entry vertex_location "$VERTEX_LOCATION"

# Catalogo de modelos. A chave e o alias que o cliente envia em "model".
#   id                    -> publisher model id no Model Garden
#   maxOutputTokens       -> teto aplicado sobre max_tokens do cliente
#   thinkingBudget        -> orcamento de raciocinio padrao (-1 = automatico, 0 = desligado)
#   safetySettings        -> opcional, repassado direto ao Vertex
read -r -d '' MODEL_MAP <<'JSON' || true
{
  "gemini-3.7-flash": {
    "id": "gemini-2.5-flash",
    "maxOutputTokens": 65535,
    "defaultMaxOutputTokens": 8192,
    "thinkingBudget": -1
  },
  "gemini-3.1-flash-lite": {
    "id": "gemini-2.5-flash-lite",
    "maxOutputTokens": 8192,
    "defaultMaxOutputTokens": 4096,
    "thinkingBudget": 0
  }
}
JSON

put_entry model_map "$(echo "$MODEL_MAP" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin),separators=(",",":")))')"

echo "KVM llm-gateway-config configurado no env ${APIGEE_ENV}."

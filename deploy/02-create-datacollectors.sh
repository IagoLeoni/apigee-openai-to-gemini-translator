#!/usr/bin/env bash
#
# Cria os data collectors usados pela policy DC-LlmUsage.
# Todo nome DEVE comecar com o prefixo dc_. Tipos aceitos: STRING, INTEGER, FLOAT, BOOLEAN, DATETIME.
#
set -euo pipefail
source "$(dirname "$0")/config.env"

TOKEN="$(gcloud auth print-access-token)"

create_dc () {
  local name="$1" type="$2" desc="$3"
  echo "--> $name ($type)"
  curl -sS -X POST \
    "https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}/datacollectors" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${name}\",\"description\":\"${desc}\",\"type\":\"${type}\"}" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   ", d.get("name") or d.get("error",{}).get("message"))'
}

create_dc dc_llm_model             STRING  "Alias do modelo LLM solicitado pelo cliente"
create_dc dc_llm_prompt_tokens     INTEGER "Tokens de entrada (prompt) consumidos"
create_dc dc_llm_completion_tokens INTEGER "Tokens de saida (completion + reasoning)"
create_dc dc_llm_total_tokens      INTEGER "Total de tokens da chamada"
create_dc dc_llm_cached_tokens     INTEGER "Tokens servidos de context cache"
create_dc dc_llm_reasoning_tokens  INTEGER "Tokens de raciocinio (thoughts) do modelo"
create_dc dc_llm_finish_reason     STRING  "Motivo de encerramento da geracao"
create_dc dc_llm_app               STRING  "Developer app que originou a chamada"
create_dc dc_llm_end_user          STRING  "Identificador de usuario final (campo user do payload)"

echo
echo "Data collectors criados. Listagem atual:"
curl -sS "https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}/datacollectors" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool

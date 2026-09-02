#!/usr/bin/env bash
#
# Cria o Custom Report de auditoria e consumo de tokens por Developer App no Apigee Analytics.
#
set -euo pipefail
source "$(dirname "$0")/config.env"
TOKEN="$(gcloud auth print-access-token)"
ORG="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"

REPORT_DISPLAY_NAME="LLM Gateway - Consumo de Tokens por Developer App"

REPORT_PAYLOAD="{
  \"displayName\": \"${REPORT_DISPLAY_NAME}\",
  \"metrics\": [
    {\"name\": \"dc_llm_total_tokens\", \"function\": \"sum\"},
    {\"name\": \"dc_llm_prompt_tokens\", \"function\": \"sum\"},
    {\"name\": \"dc_llm_completion_tokens\", \"function\": \"sum\"},
    {\"name\": \"dc_llm_reasoning_tokens\", \"function\": \"sum\"},
    {\"name\": \"message_count\", \"function\": \"sum\"}
  ],
  \"dimensions\": [
    \"developer_app\",
    \"developer_email\",
    \"dc_llm_model\",
    \"api_product\",
    \"response_status_code\"
  ],
  \"chartType\": \"column\"
}"

EXISTING_ID=$(curl -sS "${ORG}/reports" -H "Authorization: Bearer ${TOKEN}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
reports = [r for r in d.get('qualifier', []) if r.get('displayName') == '${REPORT_DISPLAY_NAME}']
if reports:
    print(reports[0].get('name'))
" 2>/dev/null || true)

if [ -n "$EXISTING_ID" ]; then
  echo "Relatorio '${REPORT_DISPLAY_NAME}' ja existe (ID: ${EXISTING_ID})."
else
  RESP=$(curl -sS -X POST "${ORG}/reports" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "$REPORT_PAYLOAD")
  echo "Relatorio '${REPORT_DISPLAY_NAME}' criado com sucesso."
fi

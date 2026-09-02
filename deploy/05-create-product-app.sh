#!/usr/bin/env bash
#
# Cria API product, developer e app. A consumerKey resultante e a chave do header x-apikey.
#
set -euo pipefail
source "$(dirname "$0")/config.env"
TOKEN="$(gcloud auth print-access-token)"
ORG="https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}"

# Payload do API Product com operacoes REST e LLM Operations (autorizacao por modelo e cota de tokens)
PRODUCT_PAYLOAD="{
  \"name\": \"${PRODUCT_NAME}\",
  \"displayName\": \"LLM Gateway - Standard\",
  \"approvalType\": \"auto\",
  \"environments\": [\"${APIGEE_ENV}\"],
  \"operationGroup\": {
    \"operationConfigType\": \"proxy\",
    \"operationConfigs\": [
      {
        \"apiSource\": \"${PROXY_NAME}\",
        \"operations\": [
          {\"resource\": \"/v1/chat/completions\", \"methods\": [\"POST\"]}
        ],
        \"quota\": {\"limit\": \"600\", \"interval\": \"1\", \"timeUnit\": \"minute\"}
      },
      {
        \"apiSource\": \"${PROXY_NAME}\",
        \"operations\": [
          {\"resource\": \"/v1/models\", \"methods\": [\"GET\"]}
        ],
        \"quota\": {\"limit\": \"600\", \"interval\": \"1\", \"timeUnit\": \"minute\"}
      }
    ]
  },
  \"llmOperationGroup\": {
    \"operationConfigs\": [
      {
        \"apiSource\": \"${PROXY_NAME}\",
        \"llmOperations\": [
          {\"resource\": \"/v1/chat/completions\", \"model\": \"gemini-3.7-flash\"}
        ],
        \"llmTokenQuota\": {
          \"limit\": \"1000000\",
          \"interval\": \"1\",
          \"timeUnit\": \"month\"
        }
      },
      {
        \"apiSource\": \"${PROXY_NAME}\",
        \"llmOperations\": [
          {\"resource\": \"/v1/chat/completions\", \"model\": \"gemini-3.1-flash-lite\"}
        ],
        \"llmTokenQuota\": {
          \"limit\": \"1000000\",
          \"interval\": \"1\",
          \"timeUnit\": \"month\"
        }
      }
    ]
  }
}"

# Cria ou atualiza o API Product
curl -sS -X POST "${ORG}/apiproducts" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "$PRODUCT_PAYLOAD" > /dev/null 2>&1 || \
curl -sS -X PUT "${ORG}/apiproducts/${PRODUCT_NAME}" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "$PRODUCT_PAYLOAD" > /dev/null 2>&1 || echo "Produto configurado."

# Garante que o developer existe
curl -sS -X POST "${ORG}/developers" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"email\":\"${DEVELOPER_EMAIL}\",\"firstName\":\"Plataforma\",\"lastName\":\"IA\",\"userName\":\"plataforma-ia\"}" > /dev/null 2>&1 || true

# Cria o app ou busca o existente
RESP=$(curl -sS -X POST "${ORG}/developers/${DEVELOPER_EMAIL}/apps" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "{\"name\":\"${APP_NAME}\",\"apiProducts\":[\"${PRODUCT_NAME}\"]}")

if echo "$RESP" | grep -q '"error"'; then
  RESP=$(curl -sS -X GET "${ORG}/developers/${DEVELOPER_EMAIL}/apps/${APP_NAME}" \
    -H "Authorization: Bearer ${TOKEN}")
fi

echo "$RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin)
creds = d.get("credentials", [{}])[0]
print()
print("APP:        ", d.get("name"))
print("API KEY:    ", creds.get("consumerKey"))
print()
print("Teste com:  export APIKEY=" + str(creds.get("consumerKey")))
'

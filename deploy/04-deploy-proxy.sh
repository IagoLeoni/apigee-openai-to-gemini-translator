#!/usr/bin/env bash
#
# Empacota e implanta o proxy. Usa apigeecli se disponivel; senao, API REST pura.
#
set -euo pipefail
source "$(dirname "$0")/config.env"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="$(gcloud auth print-access-token)"

cd "$ROOT"
rm -f "${PROXY_NAME}.zip"
zip -q -r "${PROXY_NAME}.zip" apiproxy -x '*.DS_Store'
echo "Bundle empacotado: ${PROXY_NAME}.zip"

REV=$(curl -sS -X POST \
  "https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}/apis?action=import&name=${PROXY_NAME}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@${PROXY_NAME}.zip" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
rev = d.get("revision")
if not rev:
    print(json.dumps(d, indent=2), file=sys.stderr)
    sys.exit(1)
print(rev)')

echo "Revisao importada: ${REV}"

# serviceAccount e o que habilita o <GoogleAccessToken> no TargetEndpoint.
curl -sS -X POST \
  "https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}/environments/${APIGEE_ENV}/apis/${PROXY_NAME}/revisions/${REV}/deployments?override=true&serviceAccount=${PROXY_SA}" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool

echo "Deploy solicitado em ${APIGEE_ENV}."

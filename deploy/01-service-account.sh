#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/config.env"

SA_ID="${PROXY_SA%%@*}"

gcloud iam service-accounts create "$SA_ID" \
  --display-name="Apigee LLM Gateway - acesso ao Vertex AI" \
  --project "$PROJECT_ID" || echo "Service account ja existe, seguindo."

# Permissao minima: invocar modelos do Vertex AI.
gcloud projects add-iam-policy-binding "$VERTEX_PROJECT" \
  --member="serviceAccount:${PROXY_SA}" \
  --role="roles/aiplatform.user" \
  --condition=None

# Necessario para o Apigee gerar tokens em nome desta SA no deploy.
APIGEE_AGENT="service-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')@gcp-sa-apigee.iam.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding "$PROXY_SA" \
  --member="serviceAccount:${APIGEE_AGENT}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project "$PROJECT_ID"

echo "Service account pronta: $PROXY_SA"

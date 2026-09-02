#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/config.env"

gcloud services enable \
  apigee.googleapis.com \
  aiplatform.googleapis.com \
  iam.googleapis.com \
  --project "$PROJECT_ID"

echo "APIs habilitadas."

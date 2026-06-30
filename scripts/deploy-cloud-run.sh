#!/usr/bin/env bash
set -euo pipefail

# Deploy missive-mcp remote server to Google Cloud Run.
# Requires: gcloud CLI authenticated, Docker not required (uses Cloud Build).

PROJECT_ID="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-missive-mcp}"
DATA_BUCKET="${DATA_BUCKET:-${PROJECT_ID}-missive-mcp-data}"
SECRET_NAME="${SECRET_NAME:-missive-mcp-encryption-key}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP project: gcloud config set project YOUR_PROJECT"
  exit 1
fi

echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE_NAME"
echo "Bucket:   $DATA_BUCKET"

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet

if ! gcloud storage buckets describe "gs://${DATA_BUCKET}" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Creating storage bucket gs://${DATA_BUCKET}..."
  gcloud storage buckets create "gs://${DATA_BUCKET}" \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --uniform-bucket-level-access
fi

if ! gcloud secrets describe "$SECRET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  echo "Creating secret ${SECRET_NAME}..."
  printf '%s' "$ENCRYPTION_KEY" | gcloud secrets create "$SECRET_NAME" \
    --project="$PROJECT_ID" \
    --data-file=-
else
  echo "Secret ${SECRET_NAME} already exists (reusing)."
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SA in "$CLOUDBUILD_SA" "$RUNTIME_SA"; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
done

echo "Deploying to Cloud Run (initial pass to discover service URL)..."
gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source="$REPO_ROOT" \
  --allow-unauthenticated \
  --port=3000 \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=1 \
  --max-instances=3 \
  --set-env-vars="DATA_DIR=/data,BASE_URL=https://placeholder.run.app,MCP_INSTRUCTIONS_PROFILE=all" \
  --set-secrets="ENCRYPTION_KEY=${SECRET_NAME}:latest" \
  --add-volume="name=data,type=cloud-storage,bucket=${DATA_BUCKET}" \
  --add-volume-mount="volume=data,mount-path=/data" \
  --quiet

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format='value(status.url)')"

echo "Service URL: $SERVICE_URL"
echo "Updating BASE_URL..."

gcloud run services update "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --update-env-vars="BASE_URL=${SERVICE_URL}" \
  --quiet

cat <<EOF

Deployment complete.

MCP endpoint: ${SERVICE_URL}/mcp
OAuth metadata: ${SERVICE_URL}/.well-known/oauth-authorization-server

Add to Cursor (~/.cursor/mcp.json):

{
  "mcpServers": {
    "missive": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${SERVICE_URL}/mcp"]
    }
  }
}

Each team member:
1. Restarts Cursor after adding the MCP server
2. Completes OAuth when prompted
3. Pastes their Missive API token (Missive → Settings → API → Create token)
   Requires Missive Productive plan.

EOF

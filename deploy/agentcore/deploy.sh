#!/usr/bin/env bash
# Build the worker image for ARM64, push it to ECR and create (or update) the
# healwright AgentCore Runtime. Needs: AWS CLI v2 with bedrock-agentcore-control,
# docker buildx, envsubst, credentials for the target account.
#
#   REGION=us-west-2 ./deploy/agentcore/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

REGION="${REGION:-${AWS_REGION:-us-west-2}}"
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
REPO="healwright-agentcore"
RUNTIME_NAME="${RUNTIME_NAME:-healwright_worker}"
ROLE_NAME="${ROLE_NAME:-healwright-agentcore-runtime}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"
export REGION ACCOUNT_ID

echo "==> ECR repository ${REPO}"
aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1 \
  || aws ecr create-repository --region "$REGION" --repository-name "$REPO" --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "==> Build and push ${IMAGE} (linux/arm64)"
docker buildx build --platform linux/arm64 -f Dockerfile.agentcore -t "$IMAGE" --push .

echo "==> Execution role ${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$(envsubst < deploy/agentcore/trust-policy.json)" >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name healwright-runtime \
  --policy-document "$(envsubst < deploy/agentcore/execution-role-policy.json)"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"${IMAGE}\"}}"
ENV_VARS="{\"BROWSER_PROVIDER\":\"agentcore\",\"AI_PROVIDER\":\"bedrock\",\"AWS_REGION\":\"${REGION}\",\"REQUIRE_TENANT\":\"true\"}"
HEADERS='{"requestHeaderAllowlist":["X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Id"]}'

RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId | [0]" --output text 2>/dev/null || true)"

if [ -z "$RUNTIME_ID" ] || [ "$RUNTIME_ID" = "None" ]; then
  echo "==> Create runtime ${RUNTIME_NAME}"
  aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
    --agent-runtime-name "$RUNTIME_NAME" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --request-header-configuration "$HEADERS" \
    --lifecycle-configuration '{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}' \
    --environment-variables "$ENV_VARS"
else
  echo "==> Update runtime ${RUNTIME_ID}"
  aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \
    --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --request-header-configuration "$HEADERS" \
    --lifecycle-configuration '{"idleRuntimeSessionTimeout":300,"maxLifetime":3600}' \
    --environment-variables "$ENV_VARS"
fi

echo "==> Done. Runtime ARN:"
aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeArn | [0]" --output text
echo "Grant your control plane deploy/agentcore/control-plane-invoke-policy.json, then:"
echo "  AGENTCORE_RUNTIME_ARN=<arn> npx tsx src/agentcore/invoke.ts --tenant <tenant> --test <test.json>"

#!/usr/bin/env bash
# Install the CloudNativePG MCP server on a Kubernetes cluster via kagent.
# Idempotent: safe to re-run. Reads the SA token from the cnpg-mcp-server-token
# Secret and injects it into the MCPServer CR before applying.

set -euo pipefail

NAMESPACE="${NAMESPACE:-kagent}"
MCP_NAME="${MCP_NAME:-setra06-mcp-cnpg-axians}"
SA_NAME="cnpg-mcp-server"
SECRET_NAME="cnpg-mcp-server-token"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
RENDERED="$(mktemp -t mcpserver.XXXXXX.yaml)"
trap 'rm -f "$RENDERED"' EXIT

log()  { printf '[install] %s\n' "$*"; }
fail() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

command -v kubectl >/dev/null || fail "kubectl not found in PATH"

# 1. Ensure the kagent namespace exists. kagent itself usually creates it; we
#    create it on-demand so this script works on a brand-new cluster too.
log "Ensuring namespace ${NAMESPACE} exists..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# 2. Apply RBAC (SA, ClusterRole, ClusterRoleBinding, Secret).
log "Applying RBAC..."
kubectl apply -f "${SCRIPT_DIR}/rbac.yaml"

# 3. Wait for the controller-manager to populate the Secret with the JWT.
log "Waiting for ServiceAccount token to be minted..."
TOKEN=""
for _ in $(seq 1 60); do
  TOKEN_B64="$(kubectl get secret "${SECRET_NAME}" -n "${NAMESPACE}" -o jsonpath='{.data.token}' 2>/dev/null || true)"
  if [ -n "${TOKEN_B64}" ]; then
    TOKEN="$(printf '%s' "${TOKEN_B64}" | base64 -d 2>/dev/null || printf '%s' "${TOKEN_B64}" | base64 --decode)"
    break
  fi
  sleep 1
done
[ -n "${TOKEN}" ] || fail "Token never populated in Secret ${SECRET_NAME} after 60s"

# 4. Substitute the placeholder and apply the MCPServer.
log "Rendering MCPServer manifest..."
# Use a sed delimiter that cannot appear in a JWT (JWTs use base64url: A-Za-z0-9-_).
sed "s|<INJECTÉ_VIA_SCRIPT>|${TOKEN}|" "${SCRIPT_DIR}/mcpserver.yaml" > "${RENDERED}"
log "Applying MCPServer ${MCP_NAME}..."
kubectl apply -f "${RENDERED}"

# 5. Force a kagent reconcile. Without this annotation the controller can
#    silently miss the new spec on cold clusters (race observed in practice).
log "Triggering kagent reconcile..."
kubectl annotate mcpserver "${MCP_NAME}" -n "${NAMESPACE}" \
  "kagent.dev/reconcile-trigger=$(date +%s)" --overwrite >/dev/null

# 6. Wait for the pod to be Ready.
log "Waiting for pod to become Ready..."
kubectl wait --for=condition=Ready pod \
  -l "app.kubernetes.io/instance=${MCP_NAME}" \
  -n "${NAMESPACE}" --timeout=180s

POD="$(kubectl get pod -n "${NAMESPACE}" -l "app.kubernetes.io/instance=${MCP_NAME}" -o name | head -n 1)"
[ -n "${POD}" ] || fail "no pod found for MCPServer ${MCP_NAME}"
log "Pod: ${POD}"

# 7. Smoke check: hit /mcp via an in-cluster ephemeral pod so we don't depend
#    on local port-forwarding. The Service is named after the MCPServer.
log "Probing /mcp via an in-cluster curl..."
PROBE_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"install.sh","version":"0"}}}'
PROBE_HEADERS=(
  -H 'Content-Type: application/json'
  -H 'Accept: application/json, text/event-stream'
)
SVC_URL="http://${MCP_NAME}.${NAMESPACE}.svc:3000/mcp"
set +e
PROBE_OUT="$(
  kubectl run mcp-probe-$$ -n "${NAMESPACE}" \
    --rm -i --restart=Never --image=curlimages/curl:8.10.1 --quiet \
    --command -- curl -sS --max-time 10 -D - -o - \
    "${PROBE_HEADERS[@]}" "${SVC_URL}" -d "${PROBE_BODY}" 2>&1
)"
PROBE_RC=$?
set -e
if [ "${PROBE_RC}" -ne 0 ]; then
  log "Probe failed (rc=${PROBE_RC}). Output:"
  printf '%s\n' "${PROBE_OUT}"
  fail "MCP server did not respond on ${SVC_URL}"
fi
echo "${PROBE_OUT}" | grep -q 'mcp-session-id\|Mcp-Session-Id' \
  || fail "MCP initialize did not return an Mcp-Session-Id header"

# 8. Optional: print server startup line and tool count from the pod logs.
TOOL_LINE="$(kubectl logs -n "${NAMESPACE}" "${POD}" -c mcp-server --tail=200 2>/dev/null \
  | grep -E 'CloudNativePG MCP server v.* running on stdio' | tail -n 1 || true)"

cat <<EOF

================================================================================
 Deployment OK
--------------------------------------------------------------------------------
 MCPServer:  ${MCP_NAME}
 Namespace:  ${NAMESPACE}
 Service:    ${SVC_URL}
 Pod:        ${POD}
${TOOL_LINE:+ Startup:    ${TOOL_LINE}
}================================================================================
EOF

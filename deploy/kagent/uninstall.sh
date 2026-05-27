#!/usr/bin/env bash
# Remove the CloudNativePG MCP server deployment created by install.sh.
# Idempotent: missing resources do not cause an error.

set -euo pipefail

NAMESPACE="${NAMESPACE:-kagent}"
MCP_NAME="${MCP_NAME:-setra06-mcp-cnpg-axians}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"

log() { printf '[uninstall] %s\n' "$*"; }

command -v kubectl >/dev/null || { log "kubectl not found"; exit 1; }

log "Deleting MCPServer ${MCP_NAME}..."
kubectl delete mcpserver "${MCP_NAME}" -n "${NAMESPACE}" --ignore-not-found

log "Deleting RBAC..."
# --ignore-not-found makes this idempotent. We do not delete the namespace
# itself because kagent uses it for other resources.
kubectl delete -f "${SCRIPT_DIR}/rbac.yaml" --ignore-not-found

# Drop the namespace only if it is now empty (no other workload / kagent itself).
REMAINING="$(kubectl get all -n "${NAMESPACE}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
if [ "${REMAINING}" = "0" ]; then
  log "Namespace ${NAMESPACE} is empty — removing it."
  kubectl delete namespace "${NAMESPACE}" --ignore-not-found
else
  log "Namespace ${NAMESPACE} still contains ${REMAINING} resource(s) — leaving it in place."
fi

log "Done."

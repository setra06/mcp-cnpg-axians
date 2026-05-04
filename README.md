# CloudNativePG MCP Server by Axians Data Management

A Model Context Protocol (MCP) server for managing CloudNativePG PostgreSQL clusters through Claude Code, Claude Desktop, and other MCP clients.

Developed by Axians Data Management for the Kubernetes and PostgreSQL community.

## Features

Coverage spans the CNPG operator surface up to 1.29:

- **Cluster lifecycle**: create, delete, scale, restart, reload, hibernate/resume, switchover, force-promote, in-place image upgrades.
- **Declarative database management** (CNPG 1.24+ `Database` CRD): databases, owners, encodings, extensions, schemas — operating on live clusters, not just at bootstrap.
- **Logical replication** (CNPG 1.24+): `Publication` and `Subscription` CRDs.
- **Backups & restore**: on-demand `Backup`, `ScheduledBackup` lifecycle, PITR via `restore_cluster`, `barmanObjectStore` config (S3-compatible).
- **Replica clusters**: streaming replicas with proper `externalClusters` wiring.
- **Image catalogs** (CNPG 1.29): `ImageCatalog` CRUD plus `use_image_catalog` to switch a cluster from `imageName` to a catalog ref.
- **Pooler** (PgBouncer): create, list, get, delete.
- **Sync replication** via `spec.minSyncReplicas` / `spec.maxSyncReplicas` (the operator manages `synchronous_standby_names`).
- **Observability**: status, pods, events, logs, certificate secrets, connection info (rw/ro/r service hostnames + credential secret refs).

### Technical
- Native `@kubernetes/client-node` (no `kubectl` dependency on the host).
- Bearer-token auth (or default kubeconfig fallback for local dev).
- Per-resource modules under `src/tools/*.ts` (`clusters`, `backups`, `databases`, `replication`, `poolers`, `observability`, `image_catalogs`).
- Smoke test (`npm run test:smoke`) — 18 end-to-end checks against a live CNPG cluster.

## Installation

### For Claude Desktop Users

Add this to your claude_desktop_config.json:

```json
{
  "mcpServers": {
    "cnpg": {
      "command": "npx",
      "args": ["@setra06/mcp-cnpg-axians"],
      "env": {
        "K8S_API_URL": "https://your-k8s-api-server.com",
        "K8S_TOKEN": "your_bearer_token_here"
      }
    }
  }
}
```

### Prerequisites

- Node.js 18+
- Access to a Kubernetes cluster with CloudNativePG installed
- Kubernetes API bearer token

## Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `K8S_API_URL` | Kubernetes API server URL | Yes (or fall back to `~/.kube/config`) |
| `K8S_TOKEN` | Bearer token for authentication | Yes (with `K8S_API_URL`) |
| `K8S_CA_CERT` | Path to a CA file, base64-encoded PEM, or inline PEM. Used to verify the API server's certificate. | No |
| `K8S_SKIP_TLS_VERIFY` | Set to `true` to disable TLS verification (lab self-signed clusters only). **Default: `false` since v3.1.0.** | No |
| `READ_ONLY` | Set to `true` to filter all mutating tools from the server's surface at startup. The remaining read-only tools and the `get_server_mode` tool are exposed. Pairs naturally with the `cnpg-mcp-reader` ClusterRole. | No |
| `K8S_CONTEXTS` | JSON array of context descriptors for multi-cluster mode. Example: `[{"name":"prod","apiUrl":"https://prod","tokenEnv":"PROD_TOKEN","caCertEnv":"PROD_CA"},{"name":"staging","kubeconfigPath":"/etc/staging.kubeconfig"}]`. When set, every tool accepts an optional `context: string` arg; `list_contexts` enumerates them. When unset, single-context fallback uses `K8S_API_URL`/`K8S_TOKEN`/`K8S_CA_CERT` (or default kubeconfig). | No |

### Getting a Bearer Token

```bash
# For service account token
kubectl create serviceaccount cnpg-mcp
kubectl get secret $(kubectl get sa cnpg-mcp -o jsonpath='{.secrets[0].name}') -o jsonpath='{.data.token}' | base64 -d
```

## Available Tools (67)

### Cluster lifecycle (`src/tools/clusters.ts`)
`list_clusters` · `get_cluster` · `create_cluster` · `delete_cluster` · `scale_cluster` · `patch_cluster_config` · `switchover_primary` · `promote_replica` · `pause_cluster` · `resume_cluster` · `restart_cluster` · `reload_config` · `upgrade_postgres_version`

### Backup & restore (`src/tools/backups.ts`)
`create_backup` (with `ifNotExists`) · `list_backups` · `get_backup_details` · `get_backup_status` · `delete_backup` · `restore_cluster` · `create_scheduled_backup` · `list_scheduled_backups` · `delete_scheduled_backup` · `configure_object_store` (with `replace=false` for no-op) · `wipe_object_store_path` (deletes objects under the cluster's barman path; confirm-protected)

### Declarative databases (`src/tools/databases.ts`, CNPG 1.24+)
`list_databases` · `get_database` · `create_database` · `delete_database` · `manage_extensions` · `manage_schemas`

### Replication (`src/tools/replication.ts`)
`create_replica_cluster` · `set_synchronous_replication` · `list_publications` · `create_publication` · `delete_publication` · `list_subscriptions` · `create_subscription` · `delete_subscription` · `get_replication_status` · `register_external_cluster` · `unregister_external_cluster` · `setup_logical_subscription` (composite)

### PgBouncer pooler (`src/tools/poolers.ts`)
`list_poolers` · `get_pooler` · `create_pooler` · `delete_pooler`

### Observability (`src/tools/observability.ts`)
`get_cluster_status` · `get_cluster_pods` · `get_cluster_logs` · `get_cluster_events` · `get_cluster_metrics` (real Prometheus scrape, `:9187/metrics`) · `get_cluster_pod_resources` · `get_cluster_certificates` · `get_connection_info`

### Image catalogs (`src/tools/image_catalogs.ts`, CNPG 1.29+)
`list_image_catalogs` · `create_image_catalog` · `use_image_catalog` · `delete_image_catalog`

### Waits (`src/tools/waits.ts`)
`wait_for_cluster` (phase / readyInstances) · `wait_for_backup` · `wait_for_database` · `wait_for_pooler`

### Meta (`src/tools/meta.ts`, `src/index.ts`)
`get_server_mode` — reports `full` or `readonly` and the list of excluded mutating tools when `READ_ONLY=true`. · `list_contexts` — when `K8S_CONTEXTS` is configured, lists the available named contexts. Every other tool accepts an optional `context: string` argument to target a specific cluster.

### Operations (`src/tools/operations.ts`, kubectl-cnpg parity)
`get_cluster_overview` (phase + pods + events + last backup + cert expiry, in one call) · `hibernate_dump` (re-applyable JSON of the cluster + secrets) · `run_sql` (psql via pods/exec; read-only by default — wraps in `BEGIN READ ONLY; ...; COMMIT;`)

## Usage

Drive the server in natural language from any MCP client. A few representative prompts:

- *"List all PostgreSQL clusters across namespaces."*
- *"Create a 3-instance cluster called `analytics` in `data`, PostgreSQL 17, 50Gi."*
- *"Switch the primary of `prod` to pod `prod-2` for the maintenance window."*
- *"Hibernate the `dev` cluster, then resume it on Monday."*
- *"Add the `pgcrypto` and `pg_stat_statements` extensions to the `app` Database in `data`."*
- *"Configure barmanObjectStore on `prod` pointing at `s3://backups/prod` with the existing `s3-creds` secret."*
- *"Create a Publication for all tables in db `app` on cluster `prod`, then a Subscription on cluster `analytics` consuming it."*
- *"Show me the connection info for `prod` and include credentials."*

The full per-tool schema is exposed by the standard MCP `list_tools` capability — descriptions explain when to use each tool and what its arguments do.

## Examples

### Basic Usage

```bash
# Test the server locally
npx @setra06/mcp-cnpg-axians
```

### Advanced Configuration

```json
{
  "mcpServers": {
    "cnpg-production": {
      "command": "npx",
      "args": ["@setra06/mcp-cnpg-axians"],
      "env": {
        "K8S_API_URL": "https://prod-k8s.company.com",
        "K8S_TOKEN": "prod_token_here"
      }
    },
    "cnpg-staging": {
      "command": "npx", 
      "args": ["@setra06/mcp-cnpg-axians"],
      "env": {
        "K8S_API_URL": "https://staging-k8s.company.com",
        "K8S_TOKEN": "staging_token_here"
      }
    }
  }
}
```

## Troubleshooting

### Common Issues

- **Authentication errors**: Verify your K8S_TOKEN has proper RBAC permissions
- **Connection refused**: Check K8S_API_URL is accessible from your machine
- **No clusters found**: Ensure CloudNativePG is installed in your cluster

### Required RBAC

Full functionality (covers Database/Publication/Subscription/ImageCatalog CRDs added in v3.0):

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cnpg-mcp-server
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cnpg-mcp-manager
rules:
- apiGroups: ["postgresql.cnpg.io"]
  resources:
    - clusters
    - backups
    - scheduledbackups
    - poolers
    - databases
    - publications
    - subscriptions
    - imagecatalogs
    - clusterimagecatalogs
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods", "pods/log", "services", "secrets", "events", "namespaces", "persistentvolumeclaims"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cnpg-mcp-server-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cnpg-mcp-manager
subjects:
- kind: ServiceAccount
  name: cnpg-mcp-server
  namespace: default
---
apiVersion: v1
kind: Secret
metadata:
  name: cnpg-mcp-server-token
  namespace: default
  annotations:
    kubernetes.io/service-account.name: cnpg-mcp-server
type: kubernetes.io/service-account-token
```

Read-only:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cnpg-mcp-reader
rules:
- apiGroups: ["postgresql.cnpg.io"]
  resources:
    - clusters
    - backups
    - scheduledbackups
    - poolers
    - databases
    - publications
    - subscriptions
    - imagecatalogs
    - clusterimagecatalogs
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods", "pods/log", "services", "secrets", "events", "namespaces"]
  verbs: ["get", "list", "watch"]
```

## Development

```bash
git clone https://github.com/setra06/mcp-cnpg-axians.git
cd mcp-cnpg-axians
npm install
npm run build
npm start
```

### Smoke test

`test/smoke.ts` exercises 18 tool calls (cluster lifecycle, Database CRD, extensions, pooler, observability) against a live CNPG cluster. Requires a kubeconfig with permissions to create resources in the test namespace.

```bash
KUBECONFIG=~/.kube/config TEST_NAMESPACE=cnpg-mcp-test TEST_CLUSTER=mcptest npm run test:smoke
```

## Contributing

We welcome contributions! Please see our Contributing Guide.

## About Axians Data Management

This project is developed by Axians Data Management, part of Axians (a VINCI Energies brand), specializing in ICT solutions and services.

## Support

- Report Issues: https://github.com/setra06/mcp-cnpg-axians/issues
- Discussions: https://github.com/setra06/mcp-cnpg-axians/discussions
- Email: support-database@axians.com

## License

MIT

[![MCP Badge](https://lobehub.com/badge/mcp/setra06-mcp-cnpg-axians)](https://lobehub.com/mcp/setra06-mcp-cnpg-axians)

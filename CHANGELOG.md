# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-04

Initial release of `@setra06/mcp-cnpg-axians` — an MCP server for managing CloudNativePG (CNPG 1.24+/1.29) PostgreSQL clusters from Claude Desktop, Claude Code, and other MCP clients.

**67 tools** covering the CNPG operator surface up to 1.29.

### Cluster lifecycle (`src/tools/clusters.ts`)
`list_clusters` · `get_cluster` · `create_cluster` · `delete_cluster` · `scale_cluster` · `patch_cluster_config` · `switchover_primary` · `promote_replica` · `pause_cluster` · `resume_cluster` · `restart_cluster` · `reload_config` · `upgrade_postgres_version`

### Backup & restore (`src/tools/backups.ts`)
`create_backup` (with `ifNotExists`) · `list_backups` · `get_backup_details` · `get_backup_status` · `delete_backup` · `restore_cluster` · `create_scheduled_backup` · `list_scheduled_backups` · `delete_scheduled_backup` · `configure_object_store` · `wipe_object_store_path` (confirm-protected)

### Declarative databases (`src/tools/databases.ts`, CNPG 1.24+)
`list_databases` · `get_database` · `create_database` · `delete_database` · `manage_extensions` · `manage_schemas`

### Logical replication (`src/tools/replication.ts`, CNPG 1.24+)
`create_replica_cluster` · `set_synchronous_replication` · `list_publications` · `create_publication` · `delete_publication` · `list_subscriptions` · `create_subscription` · `delete_subscription` · `get_replication_status` · `register_external_cluster` · `unregister_external_cluster` · `setup_logical_subscription` (composite)

### PgBouncer pooler (`src/tools/poolers.ts`)
`list_poolers` · `get_pooler` · `create_pooler` · `delete_pooler`

### Observability (`src/tools/observability.ts`)
`get_cluster_status` · `get_cluster_pods` · `get_cluster_logs` · `get_cluster_events` · `get_cluster_metrics` (real Prometheus scrape on `:9187/metrics`) · `get_cluster_pod_resources` · `get_cluster_certificates` · `get_connection_info`

### Image catalogs (`src/tools/image_catalogs.ts`, CNPG 1.29+)
`list_image_catalogs` · `create_image_catalog` · `use_image_catalog` · `delete_image_catalog`

### Operations (`src/tools/operations.ts`)
`get_cluster_overview` (status + pods + events + last backup + cert expiry, in one call) · `hibernate_dump` (re-applyable JSON of cluster + secrets) · `run_sql` (psql via pods/exec, read-only by default — wraps in `BEGIN READ ONLY; ...; COMMIT;`)

### Wait helpers (`src/tools/waits.ts`)
`wait_for_cluster` (phase / readyInstances) · `wait_for_backup` · `wait_for_database` · `wait_for_pooler`

### Meta & multi-context (`src/tools/meta.ts`, `src/index.ts`)
- `get_server_mode` reports `full` or `readonly` and lists excluded mutating tools when `READ_ONLY=true`.
- `list_contexts` lists configured contexts when `K8S_CONTEXTS` is set; every tool then accepts an optional `context: string` argument to target a specific cluster.

### Configuration

| Environment Variable | Description |
|---|---|
| `K8S_API_URL` | Kubernetes API server URL (or fall back to `~/.kube/config`) |
| `K8S_TOKEN` | Bearer token for authentication |
| `K8S_CA_CERT` | CA cert for the API server (file path, base64 PEM, or inline PEM) |
| `K8S_SKIP_TLS_VERIFY` | Disable TLS verification (default `false`) |
| `READ_ONLY` | Filter mutating tools at startup |
| `K8S_CONTEXTS` | JSON array of context descriptors for multi-cluster mode |

### Technical
- Native `@kubernetes/client-node` — no `kubectl` dependency on the host.
- Per-resource modules under `src/tools/*.ts`.
- TypeScript, ES modules, Node.js 18+.
- Smoke test (`npm run test:smoke`) — 96 end-to-end steps against a live CNPG cluster.

[1.0.0]: https://github.com/setra06/mcp-cnpg-axians/releases/tag/v1.0.0

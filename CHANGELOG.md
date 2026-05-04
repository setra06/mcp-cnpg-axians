# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.6.0] - 2026-05-04

### Added
- **`K8S_CONTEXTS`** env var: a JSON array of context descriptors `[{name, apiUrl, tokenEnv, caCertEnv?, skipTLSVerify?}, ...]` (or `{name, kubeconfigPath, kubeconfigContext?}`). When set, the server runs in multi-context mode and every tool accepts an optional `context: string` argument naming which cluster to target. Closes [#39](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/39).
- **`list_contexts`** meta tool: lists configured context names, the default context, and per-context build status.
- **`ContextRegistry`** in `src/contexts.ts`: lazy K8sClients construction per context, with explicit error messages on unknown context names.

### Changed (additive — no breaking)
- Every tool's input schema now declares an optional `context` property. The dispatcher resolves the K8sClients before calling the handler, so handler signatures are unchanged. When `K8S_CONTEXTS` is unset, single-context behaviour is preserved (the implicit context name is `default`).
- `buildServerSurface(opts)` accepts an optional `contexts: ContextRegistry` argument.

### Tested
- Smoke test grew to 96 steps (67 / 67 tools exercised). New coverage:
  - `ContextRegistry: single-context fallback when K8S_CONTEXTS is unset` — asserts `multiContext=false`, single entry named `default`.
  - `ContextRegistry: from descriptors with kubeconfigPath, two contexts both resolve` — asserts both contexts produce distinct K8sClients and an unknown context name surfaces a clear error.
  - `buildServerSurface(with contexts) injects context arg + adds list_contexts` — asserts every tool has a `context` property in its schema and that `list_contexts` appears.
  - `list_contexts (in-process: single fallback)` — exercises the live tool against the smoke harness's surface.

Tool count: 66 → 67.

## [3.5.0] - 2026-05-04

### Added
- **`get_cluster_overview`** in `src/tools/operations.ts`. Aggregates the cluster CR status, pods (with role/restarts/ready/age), the 10 most recent events, the latest backup (phase, age, method), and TLS certificate expiry windows (server + CA, days remaining). One call replaces five round-trips. Closes part of [#35](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/35).
- **`hibernate_dump`**: returns the cluster CR + the cluster's `-ca`, `-server`, `-replication`, `-app`, `-superuser` secrets as a single re-applyable JSON document, with managedFields/resourceVersion stripped. Mirrors `kubectl cnpg hibernate dump`. Closes part of [#35](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/35).
- **`run_sql`**: runs a SQL query against the cluster's primary via `pods/exec` → `psql`. Read-only by default — wraps the user query in `BEGIN READ ONLY; ...; COMMIT;`, so any DDL/DML fails with `cannot execute X in a read-only transaction`. Pass `readWrite: true` to disable. Defaults to the cluster's `app` database via the local peer-mapped postgres user (no password needed). Closes part of [#35](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/35).

### Added (internal)
- `podExec(kc, args)` helper in `src/k8s.ts` wrapping `@kubernetes/client-node`'s `Exec` API. Collects stdout/stderr fully and reports the exit code.

### Tested
- Smoke test grew to 92 steps. New end-to-end coverage:
  - `get_cluster_overview` returns phase + pods + latestEvents + certificates with `daysRemaining`.
  - `hibernate_dump` returns the cluster + secrets manifest, stripped of managedFields.
  - `run_sql` (read-only) computes `SELECT 1+1` → `2` on the primary.
  - `run_sql` (read-only) deliberately rejects a `CREATE TABLE` with a `read-only` error.
  - `run_sql` (`readWrite: true`) round-trips a `CREATE TABLE` + `DROP TABLE`.

Tool count: 63 → 66.

## [3.4.0] - 2026-05-04

### Changed (additive — no breaking)
- **`get_cluster`, `get_database`, `get_pooler`, `get_backup_details`** now accept `fields: string[]` (dot-separated JSON paths to project) and `raw: boolean` (default false; when true, return the full Kubernetes object as before). The default behaviour now strips metadata noise (`managedFields`, `resourceVersion`, `uid`, `generation`, `finalizers`, `ownerReferences`, `selfLink`) so a typical `get_cluster` reply is dramatically smaller — `managedFields` alone often dominates the response. Closes [#33](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/33).

### Added (internal)
- `project(obj, paths)`, `stripMetadataNoise(obj)`, `projectOrStrip(obj, args)`, and `PROJECTION_SCHEMA_PROPERTIES` exported from `src/types.ts` so tools (and tests) can apply the same convention consistently.

### Tested
- Smoke test grew to 87 steps. New steps:
  - Unit-style: `project + stripMetadataNoise behave correctly on synthetic objects`.
  - Live: `get_cluster (default)` is stripped of metadata noise, `get_cluster (fields=...)` returns only the requested paths, `get_cluster (raw=true)` keeps `managedFields`.

## [3.3.0] - 2026-05-04

### Added
- **`register_external_cluster`** / **`unregister_external_cluster`** in `src/tools/replication.ts`. Idempotent on the entry name. Use before `create_subscription` so the Subscription's `externalClusterName` resolves. Closes [#41](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/41).
- **`setup_logical_subscription`** composite tool that wires logical replication between two CNPG clusters in a single call: registers the source as an externalCluster on the local cluster (using its TLS replication secrets), creates the Subscription CR, and waits for `applied=true`. Cross-namespace requires `allowSecretCopy=true`. The K8s resource name and the SQL subscription name are derived separately so callers don't have to think about hyphen/underscore rules — `subscriptionName` is the K8s name (hyphens OK), `sqlSubscriptionName` is the PG name (defaults to the K8s name with `-` → `_`).
- **`wipe_object_store_path`** in `src/tools/backups.ts`. Lists and deletes every object under the cluster's barman destination path on the configured S3 endpoint. Foot-gun protected by an exact-match `confirm` token. Reads S3 credentials from the cluster's configured `s3Credentials` secret. Closes one of the [#42](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/42) acceptance criteria.
- **`pgHba`** parameter on `patch_cluster_config`. Appends user-defined pg_hba lines to `spec.postgresql.pg_hba`. Useful for e.g. extending cert auth to non-`postgres` databases for logical replication.
- **`replace`** parameter on `configure_object_store` (default `true`). When `false` and a barmanObjectStore already targets the same destinationPath, the call is a no-op. Closes part of [#42](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/42).
- **`ifNotExists`** parameter on `create_backup` (default `false`). When `true`, the call returns the existing Backup's status instead of erroring on conflict. Closes part of [#42](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/42).

### Added (internal)
- New `src/s3.ts` module: SigV4-signed list-objects-v2 + DeleteObjects for S3-compatible endpoints. Pure HTTPS, no `@aws-sdk/*` dependency.

### Tested
- Smoke test grew to 84 steps (63 / 63 tools exercised). New steps:
  - `register_external_cluster` (idempotent add + update path) and `unregister_external_cluster` (removes + idempotent no-op).
  - `setup_logical_subscription` end-to-end against a real consumer cluster (`mcpconsumer`) in the same namespace, subscribing via cert auth on a non-default database — the smoke test extends mcptest's `pg_hba` to allow `streaming_replica` on all databases first. Wait until applied=true verified.
  - `configure_object_store` with `replace: false` returns the no-op message when destination matches.
  - `create_backup` with `ifNotExists: true` returns the existing backup status.
  - `wipe_object_store_path` enforces exact `confirm` and (when run after a backup completes) deletes ≥1 WAL/backup object on rustfs.

### Tool count: 59 → 63.

## [3.2.0] - 2026-05-04

### Added
- **`wait_for_*` helpers** in `src/tools/waits.ts`: `wait_for_cluster`, `wait_for_backup`, `wait_for_database`, `wait_for_pooler`. Server-side polling so consumers don't have to round-trip every poll through the MCP transport. `wait_for_cluster` accepts both a `phase` and a `readyInstances` lower bound (combinable). Closes [#34](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/34).
- **`READ_ONLY` mode** (env var `READ_ONLY=true`). When set, the server filters its tool list at startup to exclude all mutating tools (matching `MUTATING_PREFIXES` from `src/types.ts`). Calls to mutating tools return a clear error explaining the mode. The new informational tool `get_server_mode` reports the current mode and the list of excluded tools. Closes [#38](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/38).
- **`buildServerSurface(opts)`** exported from `src/index.ts`: builds the aggregated tool list and handler map without starting the MCP server. Used by tests; useful for embedding the server logic in other contexts.

### Changed
- `src/index.ts` only starts the listener when invoked as the entrypoint (using `import.meta.url === file://${process.argv[1]}`). Importing the module no longer kicks off the stdio server, so tests can reuse `buildServerSurface` and `isMutating` cleanly.
- Tool count: 54 → 59 (+4 wait_for, +1 get_server_mode).

### Tested
- Smoke test grew to 65 steps (59 / 59 tools exercised). The 4 `wait_for_*` helpers replace inline polling that was duplicated 5 times across the test. New steps:
  - `isMutating classifies tools correctly` — exercises the prefix table.
  - `buildServerSurface(readOnly=true)` — asserts mutating tools are excluded and key read tools remain.
  - `buildServerSurface(readOnly=false)` — asserts the full surface.
  - `get_server_mode (in-process: full)` — asserts the live tool reports `mode=full`, `mutatingExcluded=[]`.

## [3.1.0] - 2026-05-04

### Added
- **`get_cluster_metrics`** now actually scrapes the CNPG Prometheus exporter (`:9187/metrics`) on each cluster pod via the K8s API server's `pods/proxy` subresource. Accepts `metricNames: string[]` to filter, `port` and `path` overrides, `podName` to limit scope. Closes [#36](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/36).
- **`K8S_CA_CERT`** env var: pin the Kubernetes API server's CA when using the `K8S_API_URL` + `K8S_TOKEN` auth path. Accepts a file path, a base64-encoded PEM, or an inline PEM. Closes [#37](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/37).
- **`formatK8sError(err)`** helper in `src/k8s.ts` and used by the dispatcher. Reduces the verbose `HTTP-Code: ... Body: "{\"kind\":\"Status\"...}" Headers: {...}` exception to a single line: e.g. `"422 Invalid: spec.imageName: can't downgrade from major 18 to 17"`. Closes [#40](https://github.com/cuspofaries/cnpg-axians-mcp-server/issues/40).

### Changed
- **`get_cluster_metrics`** has been renamed to **`get_cluster_pod_resources`** (the v3.0 implementation only returned pod-level resource info, not metrics). The new `get_cluster_metrics` (above) replaces it. Tool count: 53 → 54.

### BREAKING
- **`K8S_SKIP_TLS_VERIFY` default flipped from `true` to `false`**. Previous releases silently accepted any TLS cert presented by the API server. Users running against a self-signed lab cluster must now explicitly set `K8S_SKIP_TLS_VERIFY=true` *or* (preferred) set `K8S_CA_CERT` to the cluster's CA. Production users are unaffected — they were already using a real CA.

### Tested
- Smoke test grew to 60 steps (54 / 54 tools exercised). Includes a deliberate webhook rejection asserting that `formatK8sError` produces a one-line message with the HTTP code and no `Headers:` dump, plus a `get_cluster_metrics` call that filters down to `cnpg_collector_up` from the live exporter.

## [3.0.1] - 2026-05-04

### Fixed
- `mutateCluster` and the inline read-modify-write paths in `set_synchronous_replication`, `manage_extensions`, `manage_schemas`, `configure_object_store`, and `use_image_catalog` had no retry on resourceVersion conflicts. A rapid sequence of mutations (the operator updates `status` between our reads and writes) would 409 with `Operation cannot be fulfilled on clusters.postgresql.cnpg.io ...: the object has been modified`. Factored a `mutateCustomObject` helper into `src/k8s.ts` with up to 5 attempts and exponential backoff, and migrated the affected handlers.
- `upgrade_postgres_version` now also clears `spec.imageCatalogRef` when setting `spec.imageName`, otherwise the API rejects clusters that have both fields.
- `restore_cluster` now accepts `postgresMajor` / `imageName`. The previous version used the operator-default image, which would not match the source cluster's PostgreSQL major version after an upgrade — and CNPG's webhook would reject the restored cluster (or it would refuse to start).

### Tested
- Smoke test extended from 18 to 58 steps. **53 / 53 tools exercised live** against CNPG 1.29 on k3s with rustfs as the S3 backend, including `restore_cluster` from a real Barman backup and a streaming replica cluster bootstrapped via pg_basebackup.

## [3.0.0] - 2026-05-03

### Major Rewrite — CNPG 1.24+/1.29 Coverage

The 2.x line had 29 tool declarations but several were broken or used deprecated CNPG patterns. This release reorganises the server into per-resource modules, fixes the broken tools, and adds support for the modern CNPG CRDs (Database, Publication, Subscription, ImageCatalog).

Tool count: **53** (up from 29).

### Fixed
- `patch_cluster_config`: tool schema accepted `parameters` but the implementation read `postgresqlConfig` — calls were no-ops.
- `create_replica_cluster`: arg names mismatched between schema and implementation; new version registers the upstream as an `externalCluster` and uses `bootstrap.pg_basebackup.source` properly.
- `create_logical_replica`: arg mismatch; replaced by the new dedicated `create_subscription` and `create_publication` tools that drive the `Publication` / `Subscription` CRDs.
- `switchover_primary`: was setting an annotation (`cnpg.io/switchover`) the operator does not recognise. Now uses the documented `cnpg.io/targetPrimary` annotation, with fall-through to `cnpg.io/triggerSwitchover` when no target is provided.
- `upgrade_postgres_version`: was setting `imageName` to `postgres:<v>` (upstream Docker Hub image, incompatible with CNPG). Now defaults to `ghcr.io/cloudnative-pg/postgresql:<major>` and accepts a full `imageName` override.
- `manage_extensions`: was modifying `spec.bootstrap.initdb.postInitApplicationSQL` on a live cluster, which the operator only consumes during initial bootstrap (effectively a no-op). Now operates on the `Database` CRD's `spec.extensions`.
- `create_database_declarative` (renamed `create_database`): same root cause as `manage_extensions`. Replaced with proper `Database` CRD lifecycle.
- `set_synchronous_replication`: was writing `synchronous_standby_names` and `synchronous_commit` to `postgresql.parameters`, which CNPG overwrites. Now uses `spec.minSyncReplicas` / `spec.maxSyncReplicas` and clears any stale params.
- `get_cluster_certificates` / `get_connection_info`: filtered secrets by a label CNPG does not apply to cluster-owned secrets; switched to name-prefix matching aligned with CNPG conventions.

### Added
- **Database CRD**: `list_databases`, `get_database`, `create_database`, `delete_database`, `manage_extensions`, `manage_schemas`.
- **Publication / Subscription CRDs** (CNPG 1.24+): `list_publications`, `create_publication`, `delete_publication`, `list_subscriptions`, `create_subscription`, `delete_subscription`.
- **ImageCatalog** (CNPG 1.29): `list_image_catalogs`, `create_image_catalog`, `use_image_catalog`, `delete_image_catalog`.
- **Pooler lifecycle**: `list_poolers`, `get_pooler`, `delete_pooler`.
- **ScheduledBackup**: `delete_scheduled_backup`.
- **Cluster operations**: `restart_cluster` (cnpg.io/restartedAt), `reload_config` (cnpg.io/reloadedAt), `promote_replica` (force, distinct from switchover).
- **Backup config**: `configure_object_store` for barman cloud (S3-compatible) backup destinations.
- **Connection info**: `get_connection_info` returns rw/ro/r service hostnames and credential secret names (with optional plaintext credentials).

### Changed
- Source split from a single 2174-line file into per-resource modules under `src/tools/*.ts`.
- `K8sClients` replaces the implicit shared `customApi` / `k8sApi` instance variables.
- Default storage size for `create_cluster` aligned with CNPG's example (`1Gi` instead of `10Gi`); arbitrary postgres parameter defaults removed (operator defaults apply).
- `create_cluster` accepts `postgresMajor` (resolves to `ghcr.io/cloudnative-pg/postgresql:<major>`) or a full `imageName` override.

### Tested
- `test/smoke.ts` — 18 end-to-end checks against a live CNPG 1.29 cluster on k3s. All passing as of 2026-05-03.

## [2.0.0] - 2024-12-05

### 🚀 Major Release - Comprehensive PostgreSQL Management Platform

This release transforms the CNPG MCP Server from a basic cluster viewer into a comprehensive PostgreSQL management platform with **29 comprehensive tools** covering the complete database lifecycle from basic operations to enterprise-grade advanced features including automated scheduling, logical replication, and connection pooling.

### ✨ Added - Comprehensive Enterprise Features

#### 📋 **Enhanced Cluster Management (5 tools)**
- `list_clusters` - List PostgreSQL clusters across namespaces (enhanced)
- `get_cluster` - Get detailed cluster information (enhanced)
- `create_cluster` - Create new PostgreSQL clusters with full configuration
- `delete_cluster` - Delete PostgreSQL clusters safely
- `scale_cluster` - Scale cluster instances dynamically

#### 🔄 **Complete Backup Lifecycle (5 tools)**
- `create_backup` - Create manual backups with auto-generated names
- `list_backups` - List and filter backups by cluster or namespace
- `restore_cluster` - Create new cluster from backup with Point-in-Time Recovery
- `get_backup_details` - Get comprehensive backup information and status
- `delete_backup` - Delete backups to manage storage and cleanup

#### 📊 **Monitoring & Troubleshooting (3 tools)**
- `get_cluster_status` - Get comprehensive cluster status and health information
- `get_cluster_pods` - Get detailed pod information including roles and readiness
- `get_cluster_events` - Get Kubernetes events for cluster troubleshooting and debugging

### 🛠 **Enhanced**
- **Comprehensive Error Handling**: All tools include robust error handling and validation
- **RBAC Documentation**: Complete permissions for full management vs read-only access
- **Usage Examples**: 50+ real-world examples across all tool categories
- **Enterprise Features**: Support for hibernation, upgrades, advanced replication

### 📚 **Documentation**
- **Complete Tool Reference**: All 29 tools documented with descriptions and use cases
- **Enhanced Usage Guide**: Practical examples for all major operations
- **RBAC Configurations**: Both full management and read-only permission sets
- **Advanced Examples**: Multi-environment configurations

### 🔧 **Technical Improvements**
- **Interface Definitions**: Comprehensive TypeScript interfaces for all operations
- **API Constants**: Support for additional CNPG resources (Poolers, ScheduledBackups)
- **Code Organization**: Structured implementation with clear separation of concerns

## [1.0.0] - 2024-11-XX

### Added
- Initial release with basic CNPG cluster management
- `list_clusters` - List PostgreSQL clusters across namespaces
- `get_cluster` - Get detailed cluster information
- `create_cluster` - Create new PostgreSQL clusters
- `delete_cluster` - Delete PostgreSQL clusters
- `scale_cluster` - Scale cluster instances
- `get_cluster_status` - Get cluster health status
- `get_cluster_pods` - Get pod information
- Basic Kubernetes API integration
- Token-based authentication
- Cross-namespace operations

[3.6.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.5.0...v3.6.0
[3.5.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.4.0...v3.5.0
[3.4.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.3.0...v3.4.0
[3.3.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.2.0...v3.3.0
[3.2.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.1.0...v3.2.0
[3.1.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.0.1...v3.1.0
[3.0.1]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v2.0.4...v3.0.0
[2.0.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/cuspofaries/cnpg-axians-mcp-server/releases/tag/v1.0.0
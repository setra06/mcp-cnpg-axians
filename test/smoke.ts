import * as fs from 'node:fs';
import { buildKubeClients, formatK8sError } from '../src/k8s.js';
import { isMutating, project, projectOrStrip, stripMetadataNoise } from '../src/types.js';
import { buildServerSurface } from '../src/index.js';
import { ContextRegistry } from '../src/contexts.js';
import type { K8sClients, ToolHandler } from '../src/types.js';

// Build the surface with a single fallback context so list_contexts is exposed and exercised.
const SMOKE_CONTEXTS = ContextRegistry.fromEnv();
const SURFACE = buildServerSurface({
  readOnly: false,
  version: 'smoke-test',
  contexts: SMOKE_CONTEXTS,
});
const allTools = SURFACE.tools;
const all: Record<string, ToolHandler> = SURFACE.handlers;

const exercised = new Set<string>();
let pass = 0;
let fail = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`▶ ${label} ... `);
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`OK (${ms}ms)`);
    pass++;
  } catch (e) {
    const ms = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL (${ms}ms): ${msg}`);
    fail++;
    failures.push(`${label}: ${msg}`);
  }
}

async function call(k8s: K8sClients, name: string, args: any) {
  const handler = all[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  exercised.add(name);
  const result = await handler(args, k8s);
  return result.content[0].text;
}

async function waitFor<T>(label: string, fn: () => Promise<T>, predicate: (r: T) => boolean, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fn();
      if (predicate(r)) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

async function main() {
  const ns = process.env.TEST_NAMESPACE ?? 'cnpg-mcp-test';
  const cluster = process.env.TEST_CLUSTER ?? 'mcptest';
  const includeHibernate = process.env.SKIP_HIBERNATE !== 'true';
  const includeScale = process.env.SKIP_SCALE !== 'true';
  const k8s = buildKubeClients();

  console.log(`# CNPG MCP smoke test — namespace=${ns}, cluster=${cluster}`);
  console.log(`# includeHibernate=${includeHibernate}, includeScale=${includeScale}\n`);

  // ---- pure-logic checks (no cluster needed) ----
  await step('isMutating classifies tools correctly', async () => {
    const cases: Array<[string, boolean]> = [
      ['list_clusters', false],
      ['get_cluster', false],
      ['get_cluster_metrics', false],
      ['wait_for_cluster', false],
      ['get_server_mode', false],
      ['create_cluster', true],
      ['delete_cluster', true],
      ['patch_cluster_config', true],
      ['set_synchronous_replication', true],
      ['manage_extensions', true],
      ['restart_cluster', true],
      ['reload_config', true],
      ['pause_cluster', true],
      ['resume_cluster', true],
      ['restore_cluster', true],
      ['scale_cluster', true],
      ['switchover_primary', true],
      ['promote_replica', true],
      ['upgrade_postgres_version', true],
      ['configure_object_store', true],
      ['use_image_catalog', true],
    ];
    for (const [name, expected] of cases) {
      if (isMutating(name) !== expected) {
        throw new Error(`isMutating("${name}") expected ${expected}, got ${!expected}`);
      }
    }
  });

  await step('buildServerSurface(readOnly=true) excludes all mutating tools', async () => {
    const ro = buildServerSurface({ readOnly: true, version: 'smoke-test-ro' });
    const exposedMutating = ro.tools.filter((t) => isMutating(t.name));
    if (exposedMutating.length > 0) {
      throw new Error(`readOnly mode still exposed: ${exposedMutating.map((t) => t.name).join(', ')}`);
    }
    if (ro.excludedMutating.length === 0) {
      throw new Error('Expected excludedMutating to be non-empty');
    }
    // Read tools that must remain available.
    const exposedNames = ro.tools.map((t) => t.name);
    for (const required of ['list_clusters', 'get_cluster', 'get_cluster_metrics', 'get_server_mode', 'wait_for_cluster']) {
      if (!exposedNames.includes(required)) throw new Error(`readOnly mode dropped a non-mutating tool: ${required}`);
    }
    // The mutating handlers must also be absent so the dispatcher can't call them.
    for (const m of ['create_cluster', 'delete_cluster', 'patch_cluster_config']) {
      if (ro.handlers[m]) throw new Error(`readOnly mode kept a mutating handler: ${m}`);
    }
  });

  await step('buildServerSurface(readOnly=false): full surface includes mutating tools', async () => {
    const full = buildServerSurface({ readOnly: false, version: 'smoke-test-full' });
    if (full.excludedMutating.length !== 0) {
      throw new Error(`Expected empty excludedMutating in full mode, got ${full.excludedMutating.length}`);
    }
    const names = full.tools.map((t) => t.name);
    for (const required of ['create_cluster', 'delete_cluster', 'get_server_mode', 'wait_for_cluster']) {
      if (!names.includes(required)) throw new Error(`full mode missing tool: ${required}`);
    }
  });

  await step('ContextRegistry: single-context fallback when K8S_CONTEXTS is unset', async () => {
    const saved = process.env.K8S_CONTEXTS;
    delete process.env.K8S_CONTEXTS;
    try {
      const reg = ContextRegistry.fromEnv();
      if (reg.multiContext) throw new Error('Expected single-context mode');
      if (reg.contextNames().length !== 1) throw new Error(`Expected 1 context, got ${reg.contextNames().length}`);
      if (reg.defaultContext() !== 'default') throw new Error(`Expected default name "default", got "${reg.defaultContext()}"`);
    } finally {
      if (saved !== undefined) process.env.K8S_CONTEXTS = saved;
    }
  });

  await step('ContextRegistry: from descriptors with kubeconfigPath, two contexts both resolve', async () => {
    const path = process.env.KUBECONFIG ?? `${process.env.HOME}/.kube/config`;
    const reg = new ContextRegistry(
      [
        { name: 'lab-a', kubeconfigPath: path },
        { name: 'lab-b', kubeconfigPath: path },
      ],
      'lab-a',
      true,
    );
    if (!reg.multiContext) throw new Error('Expected multiContext=true');
    const a = reg.resolve('lab-a');
    const b = reg.resolve('lab-b');
    if (!a.core || !b.core) throw new Error('Both contexts should resolve to functioning clients');
    // Each context should have its own KubeConfig instance.
    if (a === b) throw new Error('Contexts should resolve to distinct K8sClients');
    // Resolving an unknown context must error with an actionable message.
    let captured: unknown;
    try {
      reg.resolve('nope');
    } catch (e) {
      captured = e;
    }
    if (!captured || !/Unknown context/.test((captured as Error).message)) {
      throw new Error('Expected "Unknown context" error');
    }
  });

  await step('buildServerSurface(with contexts) injects `context` arg + adds list_contexts', async () => {
    const path = process.env.KUBECONFIG ?? `${process.env.HOME}/.kube/config`;
    const reg = new ContextRegistry(
      [
        { name: 'alpha', kubeconfigPath: path },
        { name: 'beta', kubeconfigPath: path },
      ],
      'alpha',
      true,
    );
    const s = buildServerSurface({ readOnly: false, version: 'smoke', contexts: reg });
    if (!s.tools.some((t) => t.name === 'list_contexts')) throw new Error('list_contexts not in tool list');
    // Every tool must have a `context` property in its inputSchema.
    for (const t of s.tools) {
      const props: any = (t.inputSchema as any).properties;
      if (!props?.context) throw new Error(`tool "${t.name}" missing context property`);
    }
    // list_contexts handler returns a JSON listing both contexts.
    const result = await s.handlers.list_contexts({}, reg.resolve('alpha'));
    const text = result.content[0].text;
    if (!text.includes('"alpha"') || !text.includes('"beta"')) {
      throw new Error(`list_contexts output missing one of the contexts: ${text}`);
    }
    if (!text.includes('"multiContext": true')) throw new Error('multiContext flag missing');
    if (!text.includes('"default": "alpha"')) throw new Error('default context missing');
  });

  await step('project + stripMetadataNoise behave correctly on synthetic objects', async () => {
    const sample = {
      apiVersion: 'v1',
      kind: 'Cluster',
      metadata: {
        name: 'foo',
        namespace: 'bar',
        managedFields: [{ a: 1 }, { b: 2 }],
        resourceVersion: '12345',
        uid: 'xxx',
        generation: 7,
        annotations: { 'cnpg.io/hibernation': 'on' },
      },
      spec: { instances: 3, postgresql: { parameters: { max_connections: '100' } } },
      status: { phase: 'Cluster in healthy state', readyInstances: 3 },
    };
    const stripped = stripMetadataNoise(sample) as any;
    if (stripped.metadata.managedFields) throw new Error('managedFields not stripped');
    if (stripped.metadata.resourceVersion) throw new Error('resourceVersion not stripped');
    if (!stripped.metadata.annotations) throw new Error('annotations should remain');
    if (stripped.spec.instances !== 3) throw new Error('spec.instances missing');

    const projected: any = project(sample, ['spec.instances', 'status.phase']);
    if (projected.spec?.instances !== 3) throw new Error('projection missed spec.instances');
    if (projected.status?.phase !== 'Cluster in healthy state') throw new Error('projection missed status.phase');
    if (projected.status?.readyInstances !== undefined) throw new Error('projection should not include status.readyInstances');
    if (projected.metadata !== undefined) throw new Error('projection should not include metadata');

    const orStrip: any = projectOrStrip(sample, { fields: ['spec.instances'] });
    if (orStrip.spec?.instances !== 3) throw new Error('projectOrStrip(fields) failed');
    const orStripDefault: any = projectOrStrip(sample, {});
    if (orStripDefault.metadata.managedFields) throw new Error('projectOrStrip default should strip');
    const orStripRaw: any = projectOrStrip(sample, { raw: true });
    if (!orStripRaw.metadata.managedFields) throw new Error('projectOrStrip raw should keep managedFields');
  });

  // ---- discovery ----
  await step('list_clusters (cluster-wide)', async () => {
    await call(k8s, 'list_clusters', {});
  });

  await step('get_server_mode (in-process: full)', async () => {
    const text = await call(k8s, 'get_server_mode', {});
    if (!/"mode": "full"/.test(text)) throw new Error(`Expected full mode, got: ${text}`);
    if (!/"mutatingExcluded": \[\]/.test(text)) throw new Error(`Expected empty mutatingExcluded, got: ${text}`);
  });

  await step('list_contexts (in-process: single fallback)', async () => {
    const text = await call(k8s, 'list_contexts', {});
    if (!/"default":\s*"default"/.test(text)) throw new Error(`Expected default context "default": ${text}`);
    if (!/"contexts"/.test(text)) throw new Error('Expected contexts array');
  });

  await step('list_image_catalogs (cluster scope)', async () => {
    await call(k8s, 'list_image_catalogs', { scope: 'cluster' });
  });

  // ---- setup ----
  await step(`ensure namespace ${ns} exists`, async () => {
    try {
      await k8s.core.readNamespace({ name: ns });
    } catch {
      await k8s.core.createNamespace({ body: { metadata: { name: ns } } });
    }
  });

  await step('formatK8sError reduces a webhook rejection to a one-line message', async () => {
    let captured: unknown;
    try {
      // Deliberately invalid: instances=0 fails the operator's validating webhook.
      await call(k8s, 'create_cluster', {
        name: 'bad-cluster',
        namespace: ns,
        instances: 0,
        storageSize: '1Gi',
      });
    } catch (e) {
      captured = e;
    }
    if (!captured) throw new Error('Expected webhook rejection on instances=0');
    const formatted = formatK8sError(captured);
    if (formatted.length === 0 || formatted.length > 500) {
      throw new Error(`formatted error has unreasonable length (${formatted.length}): ${formatted}`);
    }
    if (!/\b(\d{3})\b/.test(formatted)) {
      throw new Error(`expected an HTTP code in the formatted error: ${formatted}`);
    }
    if (/\bHeaders:/i.test(formatted)) {
      throw new Error(`formatted error still contains Headers: dump: ${formatted}`);
    }
  });

  await step(`create_cluster ${ns}/${cluster}`, async () => {
    try {
      await call(k8s, 'create_cluster', {
        name: cluster,
        namespace: ns,
        instances: 1,
        storageSize: '1Gi',
        // Pin to an older major so upgrade_postgres_version has somewhere to go.
        postgresMajor: 16,
        monitoringEnabled: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('wait_for_cluster (phase=healthy)', async () => {
    await call(k8s, 'wait_for_cluster', { name: cluster, namespace: ns, timeoutSec: 420 });
  });

  // ---- observability on a single-instance cluster ----
  await step('get_cluster_pods (1 pod ready)', async () => {
    const text = await call(k8s, 'get_cluster_pods', { name: cluster, namespace: ns });
    if (!/"ready": true/.test(text)) throw new Error(`No ready pod\n${text}`);
  });

  await step('get_cluster_certificates (>= 3 secrets)', async () => {
    const text = await call(k8s, 'get_cluster_certificates', { clusterName: cluster, namespace: ns });
    const count = (text.match(/"name":/g) ?? []).length;
    if (count < 3) throw new Error(`Expected >=3 cert secrets, got ${count}\n${text}`);
  });

  await step('get_connection_info (rw/ro/r services + app secret)', async () => {
    const text = await call(k8s, 'get_connection_info', { clusterName: cluster, namespace: ns });
    if (!text.includes(`${cluster}-rw`)) throw new Error('Missing rw service');
    if (!text.includes(`${cluster}-ro`)) throw new Error('Missing ro service');
    if (!text.includes(`${cluster}-r`)) throw new Error('Missing r service');
  });

  await step('get_cluster (default: stripped of metadata noise)', async () => {
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (/managedFields/.test(text)) throw new Error('Default get_cluster should not include managedFields');
    if (!/spec/.test(text)) throw new Error('spec should still be present');
  });

  await step('get_cluster (fields projection)', async () => {
    const text = await call(k8s, 'get_cluster', {
      name: cluster,
      namespace: ns,
      fields: ['spec.instances', 'status.phase'],
    });
    if (/managedFields/.test(text)) throw new Error('Projected output must not include managedFields');
    if (/spec\.postgresql\.parameters|"resources":/.test(text)) {
      throw new Error('Projected output should not include unrequested paths');
    }
    if (!/"instances":\s*1/.test(text)) throw new Error('spec.instances projection failed');
    if (!/"phase":\s*"Cluster in healthy state"/.test(text)) throw new Error('status.phase projection failed');
  });

  await step('get_cluster (raw=true) keeps managedFields', async () => {
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns, raw: true });
    if (!/managedFields/.test(text)) throw new Error('raw=true should include managedFields');
  });

  await step('get_cluster_logs (postgres container, tail 50)', async () => {
    const text = await call(k8s, 'get_cluster_logs', {
      clusterName: cluster,
      namespace: ns,
      tailLines: 50,
    });
    if (!text.includes('## Pod:')) throw new Error('No pod logs returned');
  });

  await step('get_cluster_events', async () => {
    await call(k8s, 'get_cluster_events', { clusterName: cluster, namespace: ns, limit: 10 });
  });

  await step('get_cluster_pod_resources (1 pod)', async () => {
    const text = await call(k8s, 'get_cluster_pod_resources', { clusterName: cluster, namespace: ns });
    if (!text.includes('"totalPods": 1')) throw new Error(`Unexpected output\n${text}`);
  });

  await step('get_cluster_metrics scrapes :9187/metrics (filtered to cnpg_collector_up)', async () => {
    const text = await call(k8s, 'get_cluster_metrics', {
      clusterName: cluster,
      namespace: ns,
      metricNames: ['cnpg_collector_up'],
    });
    if (!text.includes('cnpg_collector_up')) {
      throw new Error(`Expected cnpg_collector_up metric line in output\n${text.slice(0, 500)}`);
    }
  });

  await step('get_replication_status', async () => {
    const text = await call(k8s, 'get_replication_status', { clusterName: cluster, namespace: ns });
    if (!text.includes('currentPrimary')) throw new Error(`Unexpected output\n${text}`);
  });

  // ---- declarative database ----
  await step('create_database mcptest-app', async () => {
    try {
      await call(k8s, 'create_database', {
        name: 'mcptest-app',
        namespace: ns,
        clusterName: cluster,
        owner: 'app',
        dbName: 'test_app',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('wait_for_database (applied=true)', async () => {
    await call(k8s, 'wait_for_database', { name: 'mcptest-app', namespace: ns, timeoutSec: 60 });
  });

  await step('get_database (full spec)', async () => {
    const text = await call(k8s, 'get_database', { name: 'mcptest-app', namespace: ns });
    if (!text.includes('mcptest-app')) throw new Error('get_database did not return our resource');
  });

  await step('manage_extensions add pgcrypto', async () => {
    await call(k8s, 'manage_extensions', {
      databaseName: 'mcptest-app',
      namespace: ns,
      extensions: [{ name: 'pgcrypto', ensure: 'present' }],
    });
  });

  await step('manage_schemas add reporting schema', async () => {
    await call(k8s, 'manage_schemas', {
      databaseName: 'mcptest-app',
      namespace: ns,
      schemas: [{ name: 'reporting', ensure: 'present' }],
    });
  });

  await step('list_databases sees mcptest-app', async () => {
    const text = await call(k8s, 'list_databases', { namespace: ns });
    if (!text.includes('mcptest-app')) throw new Error('Database not in list');
  });

  await step('get_cluster_overview returns aggregated state', async () => {
    const text = await call(k8s, 'get_cluster_overview', { clusterName: cluster, namespace: ns });
    for (const required of ['"phase"', '"pods"', '"latestEvents"', '"certificates"']) {
      if (!text.includes(required)) throw new Error(`overview missing ${required}: ${text.slice(0, 400)}`);
    }
    if (!/"server"/.test(text)) throw new Error('overview missing server cert info');
    if (!/"daysRemaining"/.test(text)) throw new Error('overview missing certificate expiry');
  });

  await step('hibernate_dump returns the cluster + secrets manifest', async () => {
    const text = await call(k8s, 'hibernate_dump', { clusterName: cluster, namespace: ns });
    if (!/"kind": "Cluster"/.test(text)) throw new Error('dump missing Cluster kind');
    if (!/"secrets":/.test(text)) throw new Error('dump missing secrets array');
    if (/"managedFields":/.test(text)) throw new Error('dump should strip managedFields');
  });

  await step('run_sql (read-only): SELECT 1+1', async () => {
    const text = await call(k8s, 'run_sql', {
      clusterName: cluster,
      namespace: ns,
      query: 'SELECT 1+1',
      database: 'test_app',
    });
    if (!/\b2\b/.test(text)) throw new Error(`Expected "2" in output: ${text}`);
    if (!/read-only/.test(text)) throw new Error(`Expected "read-only" tag in output: ${text}`);
  });

  await step('run_sql (read-only): rejects writes by default', async () => {
    let captured: unknown;
    try {
      await call(k8s, 'run_sql', {
        clusterName: cluster,
        namespace: ns,
        query: 'CREATE TABLE smoke_test_should_fail (x int)',
        database: 'test_app',
      });
    } catch (e) {
      captured = e;
    }
    if (!captured) throw new Error('Expected error: write in read-only mode should fail');
    const msg = captured instanceof Error ? captured.message : String(captured);
    if (!/read-only|cannot execute/i.test(msg)) {
      throw new Error(`Unexpected error (expected read-only rejection): ${msg.slice(0, 300)}`);
    }
  });

  await step('run_sql (readWrite=true): CREATE + DROP roundtrip', async () => {
    await call(k8s, 'run_sql', {
      clusterName: cluster,
      namespace: ns,
      query: 'CREATE TABLE smoke_test_writable (x int); DROP TABLE smoke_test_writable',
      database: 'test_app',
      readWrite: true,
    });
  });

  // ---- streaming replica (run while the source is stable, before any disruptive tests) ----
  await step('create_replica_cluster mcptest-replica from mcptest', async () => {
    try {
      await call(k8s, 'create_replica_cluster', {
        name: 'mcptest-replica',
        namespace: ns,
        sourceClusterName: cluster,
        sourceNamespace: ns,
        instances: 1,
        storageSize: '1Gi',
        postgresMajor: 16,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('wait_for_cluster (replica healthy)', async () => {
    await call(k8s, 'wait_for_cluster', { name: 'mcptest-replica', namespace: ns, timeoutSec: 300 });
  });

  await step('cleanup: delete replica cluster (before source mutates)', async () => {
    await call(k8s, 'delete_cluster', { name: 'mcptest-replica', namespace: ns });
  });

  // ---- cluster-level annotations / spec patches ----
  await step('reload_config sets cnpg.io/reloadedAt', async () => {
    const text = await call(k8s, 'reload_config', { clusterName: cluster, namespace: ns });
    if (!text.includes('Config reload triggered')) throw new Error('Bad output');
  });

  await step('restart_cluster sets cnpg.io/restartedAt', async () => {
    const text = await call(k8s, 'restart_cluster', { clusterName: cluster, namespace: ns });
    if (!text.includes('Rolling restart triggered')) throw new Error('Bad output');
    const cl = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!cl.includes('cnpg.io/restartedAt')) throw new Error('Annotation not present');
  });

  await step('patch_cluster_config sets max_connections', async () => {
    await call(k8s, 'patch_cluster_config', {
      clusterName: cluster,
      namespace: ns,
      parameters: { max_connections: '120' },
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!text.includes('"max_connections": "120"')) throw new Error('Param not applied');
  });

  await step('set_synchronous_replication (min=0, max=0 — no-op safe)', async () => {
    await call(k8s, 'set_synchronous_replication', {
      clusterName: cluster,
      namespace: ns,
      minSyncReplicas: 0,
      maxSyncReplicas: 0,
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!text.includes('"minSyncReplicas": 0')) throw new Error('minSyncReplicas not applied');
    if (!text.includes('"maxSyncReplicas": 0')) throw new Error('maxSyncReplicas not applied');
  });

  await step('upgrade_postgres_version 16 → 17 (sets imageName, no wait)', async () => {
    await call(k8s, 'upgrade_postgres_version', {
      clusterName: cluster,
      namespace: ns,
      postgresMajor: 17,
    });
    const after = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!after.includes('"imageName": "ghcr.io/cloudnative-pg/postgresql:17"')) {
      throw new Error('imageName not updated to 17');
    }
  });

  // ---- image catalogs ----
  await step('create_image_catalog mcptest-catalog', async () => {
    try {
      await call(k8s, 'create_image_catalog', {
        name: 'mcptest-catalog',
        namespace: ns,
        images: [
          { major: 16, image: 'ghcr.io/cloudnative-pg/postgresql:16' },
          { major: 17, image: 'ghcr.io/cloudnative-pg/postgresql:17' },
        ],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('list_image_catalogs (namespaced) sees the new catalog', async () => {
    const text = await call(k8s, 'list_image_catalogs', { namespace: ns, scope: 'namespaced' });
    if (!text.includes('mcptest-catalog')) throw new Error('Catalog not in list');
  });

  await step('use_image_catalog (switch cluster from imageName → catalog ref)', async () => {
    await call(k8s, 'use_image_catalog', {
      clusterName: cluster,
      namespace: ns,
      catalogName: 'mcptest-catalog',
      catalogScope: 'ImageCatalog',
      major: 17,
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!text.includes('imageCatalogRef')) throw new Error('imageCatalogRef not set');
    if (!text.includes('"name": "mcptest-catalog"')) throw new Error('catalog name not set');
  });

  await step('revert to imageName (so we can delete the catalog)', async () => {
    await call(k8s, 'upgrade_postgres_version', {
      clusterName: cluster,
      namespace: ns,
      postgresMajor: 17,
    });
  });

  await step('delete_image_catalog mcptest-catalog', async () => {
    await call(k8s, 'delete_image_catalog', { name: 'mcptest-catalog', namespace: ns });
  });

  // ---- pub/sub on a single cluster (publication only — subscription needs externalCluster) ----
  await step('create_publication mcptest-pub', async () => {
    try {
      await call(k8s, 'create_publication', {
        name: 'mcptest-pub',
        namespace: ns,
        clusterName: cluster,
        dbName: 'test_app',
        allTables: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('list_publications sees the new publication', async () => {
    const text = await call(k8s, 'list_publications', { namespace: ns });
    if (!text.includes('mcptest-pub')) throw new Error('Publication not in list');
  });

  await step('delete_publication', async () => {
    await call(k8s, 'delete_publication', { name: 'mcptest-pub', namespace: ns });
  });

  await step('list_subscriptions (empty)', async () => {
    await call(k8s, 'list_subscriptions', { namespace: ns });
  });

  // create_subscription requires externalClusterName referring to a spec.externalClusters
  // entry on the cluster. The CRD only validates that the field is a string —
  // operator reconciliation does the semantic check. We exercise the tool surface here;
  // the resource will sit in applied=false but the CR lifecycle works.
  await step('register_external_cluster (idempotent add)', async () => {
    await call(k8s, 'register_external_cluster', {
      clusterName: cluster,
      namespace: ns,
      externalCluster: {
        name: 'phantom-source',
        connectionParameters: { host: 'phantom.invalid', user: 'replicator', dbname: 'app' },
      },
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!text.includes('"name": "phantom-source"')) throw new Error('externalCluster not in spec');
  });

  await step('register_external_cluster again (update path)', async () => {
    await call(k8s, 'register_external_cluster', {
      clusterName: cluster,
      namespace: ns,
      externalCluster: {
        name: 'phantom-source',
        connectionParameters: { host: 'phantom-2.invalid', user: 'replicator', dbname: 'app' },
      },
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!text.includes('phantom-2.invalid')) throw new Error('externalCluster not updated');
  });

  await step('create_subscription (phantom externalClusterName, CR-level test)', async () => {
    try {
      await call(k8s, 'create_subscription', {
        name: 'mcptest-sub',
        namespace: ns,
        clusterName: cluster,
        dbName: 'test_app',
        externalClusterName: 'phantom-source',
        publicationName: 'phantom-pub',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
    const list = await call(k8s, 'list_subscriptions', { namespace: ns });
    if (!list.includes('mcptest-sub')) throw new Error('Subscription not in list');
  });

  await step('delete_subscription', async () => {
    await call(k8s, 'delete_subscription', { name: 'mcptest-sub', namespace: ns });
  });

  await step('unregister_external_cluster (removes phantom)', async () => {
    await call(k8s, 'unregister_external_cluster', {
      clusterName: cluster,
      namespace: ns,
      externalClusterName: 'phantom-source',
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (text.includes('"name": "phantom-source"')) throw new Error('externalCluster still present');
  });

  await step('unregister_external_cluster (idempotent no-op)', async () => {
    const text = await call(k8s, 'unregister_external_cluster', {
      clusterName: cluster,
      namespace: ns,
      externalClusterName: 'phantom-source',
    });
    if (!text.includes('not present')) throw new Error('Expected idempotent no-op message');
  });

  // ---- setup_logical_subscription end-to-end (separate consumer cluster) ----
  // CNPG's default pg_hba only allows streaming_replica on db=postgres. To unblock cert auth
  // for logical replication into test_app, append a permissive rule on the source.
  await step('extend mcptest pg_hba to allow streaming_replica on all dbs (test setup)', async () => {
    await call(k8s, 'patch_cluster_config', {
      clusterName: cluster,
      namespace: ns,
      pgHba: ['hostssl all streaming_replica all cert map=cnpg_streaming_replica'],
    });
    // Force a reload so the operator picks up the new line.
    await call(k8s, 'reload_config', { clusterName: cluster, namespace: ns });
    // Give the operator/postgres a moment to apply.
    await new Promise((r) => setTimeout(r, 10_000));
  });

  await step('create_publication for the e2e logical subscription test', async () => {
    try {
      await call(k8s, 'create_publication', {
        name: 'mcp-pub-for-sub',
        namespace: ns,
        clusterName: cluster,
        dbName: 'test_app',
        allTables: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('create_cluster mcpconsumer (subscriber side)', async () => {
    try {
      await call(k8s, 'create_cluster', {
        name: 'mcpconsumer',
        namespace: ns,
        instances: 1,
        storageSize: '1Gi',
        postgresMajor: 16,
        monitoringEnabled: false,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('wait_for_cluster (mcpconsumer healthy)', async () => {
    await call(k8s, 'wait_for_cluster', { name: 'mcpconsumer', namespace: ns, timeoutSec: 300 });
  });

  await step('create_database consumer-app on mcpconsumer', async () => {
    try {
      await call(k8s, 'create_database', {
        name: 'mcpconsumer-app',
        namespace: ns,
        clusterName: 'mcpconsumer',
        owner: 'app',
        dbName: 'consumer_db',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
    await call(k8s, 'wait_for_database', { name: 'mcpconsumer-app', namespace: ns, timeoutSec: 60 });
  });

  await step('setup_logical_subscription end-to-end (mcpconsumer ← mcptest)', async () => {
    const text = await call(k8s, 'setup_logical_subscription', {
      localCluster: 'mcpconsumer',
      namespace: ns,
      sourceCluster: cluster,
      sourceNamespace: ns,
      dbName: 'consumer_db',
      publicationName: 'mcp-pub-for-sub',
      publicationDBName: 'test_app',
      subscriptionName: 'mcpconsumer-sub',
      timeoutSec: 60,
    });
    if (!/applied/.test(text)) throw new Error(`Expected "applied" in output: ${text}`);
  });

  await step('list_subscriptions sees mcpconsumer-sub (applied)', async () => {
    const text = await call(k8s, 'list_subscriptions', { namespace: ns, clusterName: 'mcpconsumer' });
    if (!text.includes('mcpconsumer-sub')) throw new Error('Subscription not in list');
    if (!text.includes('"applied": true')) throw new Error('Subscription not applied');
  });

  await step('cleanup: delete_subscription mcpconsumer-sub', async () => {
    await call(k8s, 'delete_subscription', { name: 'mcpconsumer-sub', namespace: ns });
  });

  await step('cleanup: delete_database mcpconsumer-app', async () => {
    await call(k8s, 'delete_database', { name: 'mcpconsumer-app', namespace: ns });
  });

  await step('cleanup: delete mcpconsumer cluster', async () => {
    await call(k8s, 'delete_cluster', { name: 'mcpconsumer', namespace: ns });
  });

  await step('cleanup: delete_publication mcp-pub-for-sub', async () => {
    await call(k8s, 'delete_publication', { name: 'mcp-pub-for-sub', namespace: ns });
  });

  // ---- pooler ----
  await step('create_pooler / wait_for_pooler / get_pooler / list / delete', async () => {
    try {
      await call(k8s, 'create_pooler', {
        name: 'mcptest-pool',
        namespace: ns,
        clusterName: cluster,
        instances: 1,
        type: 'rw',
        poolMode: 'transaction',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
    await call(k8s, 'wait_for_pooler', { name: 'mcptest-pool', namespace: ns, timeoutSec: 60 });
    const got = await call(k8s, 'get_pooler', { name: 'mcptest-pool', namespace: ns });
    if (!got.includes('mcptest-pool')) throw new Error('get_pooler did not return our pooler');
    const list = await call(k8s, 'list_poolers', { namespace: ns, clusterName: cluster });
    if (!list.includes('mcptest-pool')) throw new Error('Pooler not in list');
    await call(k8s, 'delete_pooler', { name: 'mcptest-pool', namespace: ns });
  });

  // ---- backup CRUD that does NOT need a real object store ----
  await step('list_backups (empty)', async () => {
    const text = await call(k8s, 'list_backups', { namespace: ns });
    if (!text.includes('Found 0 backups') && !text.includes('Found ')) {
      throw new Error(`Unexpected output\n${text}`);
    }
  });

  await step('create_scheduled_backup / list / delete', async () => {
    try {
      await call(k8s, 'create_scheduled_backup', {
        name: 'mcptest-sched',
        namespace: ns,
        clusterName: cluster,
        schedule: '0 0 2 * * *',
        suspend: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
    const list = await call(k8s, 'list_scheduled_backups', { namespace: ns });
    if (!list.includes('mcptest-sched')) throw new Error('ScheduledBackup not in list');
    await call(k8s, 'delete_scheduled_backup', { name: 'mcptest-sched', namespace: ns });
  });

  // Need an object store before we can attempt a backup CR.

  // Real S3 endpoint? If credentials are available (S3_ENDPOINT_URL + S3_ACCESS_KEY + S3_SECRET_KEY +
  // S3_DESTINATION_PATH), we run the full backup/restore flow. Otherwise we just verify the spec write.
  const s3Env: Record<string, string> = {};
  const envFile = process.env.S3_ENV_FILE;
  if (envFile && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) s3Env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const S3_ENDPOINT = process.env.S3_ENDPOINT_URL ?? '';
  const S3_ACCESS = process.env.S3_ACCESS_KEY ?? s3Env.RUSTFS_ACCESS_KEY ?? s3Env.AWS_ACCESS_KEY_ID ?? '';
  const S3_SECRET = process.env.S3_SECRET_KEY ?? s3Env.RUSTFS_SECRET_KEY ?? s3Env.AWS_SECRET_ACCESS_KEY ?? '';
  const S3_DEST = process.env.S3_DESTINATION_PATH ?? '';
  const realS3 = !!(S3_ENDPOINT && S3_ACCESS && S3_SECRET && S3_DEST);

  await step(`configure_object_store (${realS3 ? `real S3 → ${S3_DEST}` : 'fake S3 — spec-only'})`, async () => {
    const secretName = 'mcptest-s3-creds';
    try {
      await k8s.core.createNamespacedSecret({
        namespace: ns,
        body: {
          metadata: { name: secretName, namespace: ns },
          type: 'Opaque',
          data: {
            ACCESS_KEY_ID: Buffer.from(realS3 ? S3_ACCESS : 'AKIAFAKE').toString('base64'),
            SECRET_ACCESS_KEY: Buffer.from(realS3 ? S3_SECRET : 'SECRETFAKE').toString('base64'),
          },
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
    await call(k8s, 'configure_object_store', {
      clusterName: cluster,
      namespace: ns,
      destinationPath: realS3 ? S3_DEST : 's3://mcptest-bucket/cluster',
      endpointURL: realS3 ? S3_ENDPOINT : 'http://fake.invalid:9000',
      s3CredentialsSecret: {
        name: secretName,
        accessKeyIdKey: 'ACCESS_KEY_ID',
        secretAccessKeyKey: 'SECRET_ACCESS_KEY',
      },
    });
    const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
    if (!text.includes('barmanObjectStore')) throw new Error('barmanObjectStore not in spec');
  });

  await step('configure_object_store again with replace=false (no-op)', async () => {
    const text = await call(k8s, 'configure_object_store', {
      clusterName: cluster,
      namespace: ns,
      destinationPath: realS3 ? S3_DEST : 's3://mcptest-bucket/cluster',
      endpointURL: realS3 ? S3_ENDPOINT : 'http://fake.invalid:9000',
      s3CredentialsSecret: {
        name: 'mcptest-s3-creds',
        accessKeyIdKey: 'ACCESS_KEY_ID',
        secretAccessKeyKey: 'SECRET_ACCESS_KEY',
      },
      replace: false,
    });
    if (!/already targets|skipped/.test(text)) throw new Error(`Expected no-op message, got: ${text}`);
  });

  // ---- backup CR lifecycle ----
  await step('create_backup', async () => {
    try {
      await call(k8s, 'create_backup', {
        clusterName: cluster,
        namespace: ns,
        backupName: 'mcptest-backup-1',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  });

  await step('list_backups sees mcptest-backup-1', async () => {
    const text = await call(k8s, 'list_backups', { namespace: ns });
    if (!text.includes('mcptest-backup-1')) throw new Error('Backup not in list');
  });

  await step('create_backup ifNotExists=true returns existing status', async () => {
    const text = await call(k8s, 'create_backup', {
      clusterName: cluster,
      namespace: ns,
      backupName: 'mcptest-backup-1',
      ifNotExists: true,
    });
    if (!/already exists/.test(text)) throw new Error(`Expected "already exists" message: ${text}`);
  });

  await step('get_backup_details', async () => {
    const text = await call(k8s, 'get_backup_details', { backupName: 'mcptest-backup-1', namespace: ns });
    if (!text.includes('mcptest-backup-1')) throw new Error('Bad output');
  });

  await step('get_backup_status', async () => {
    const text = await call(k8s, 'get_backup_status', { backupName: 'mcptest-backup-1', namespace: ns });
    if (!text.includes('mcptest-backup-1')) throw new Error('Bad output');
  });

  if (realS3) {
    await step('wait_for_backup (phase=completed)', async () => {
      await call(k8s, 'wait_for_backup', { backupName: 'mcptest-backup-1', namespace: ns, timeoutSec: 300 });
    });

    await step('restore_cluster mcptest-restored from backup', async () => {
      // Pin to the same major as the source cluster so the restore can replay
      // the WAL / base backup. mcptest was upgraded to PG 17 earlier.
      try {
        await call(k8s, 'restore_cluster', {
          newClusterName: 'mcptest-restored',
          namespace: ns,
          backupName: 'mcptest-backup-1',
          instances: 1,
          storageSize: '1Gi',
          postgresMajor: 17,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('already exists')) throw e;
      }
    });

    await step('wait_for_cluster (mcptest-restored healthy)', async () => {
      await call(k8s, 'wait_for_cluster', { name: 'mcptest-restored', namespace: ns, timeoutSec: 420 });
    });

    await step('cleanup: delete restored cluster', async () => {
      await call(k8s, 'delete_cluster', { name: 'mcptest-restored', namespace: ns });
    });
  }

  await step('delete_backup', async () => {
    await call(k8s, 'delete_backup', { backupName: 'mcptest-backup-1', namespace: ns });
  });

  if (realS3) {
    await step('wipe_object_store_path requires exact destinationPath confirm', async () => {
      let captured: unknown;
      try {
        await call(k8s, 'wipe_object_store_path', {
          clusterName: cluster,
          namespace: ns,
          confirm: 'wrong-path',
        });
      } catch (e) {
        captured = e;
      }
      if (!captured) throw new Error('Expected error on incorrect confirm token');
      const msg = captured instanceof Error ? captured.message : String(captured);
      if (!/confirm must match/.test(msg)) throw new Error(`Unexpected error: ${msg}`);
    });

    await step('wipe_object_store_path deletes WAL/backup objects', async () => {
      const text = await call(k8s, 'wipe_object_store_path', {
        clusterName: cluster,
        namespace: ns,
        confirm: S3_DEST,
      });
      const m = text.match(/deleted (\d+) object/);
      if (!m) throw new Error(`Could not parse delete count from: ${text}`);
      const deleted = parseInt(m[1], 10);
      if (deleted === 0) {
        throw new Error('Expected at least one object deleted (WAL archives) — got 0');
      }
    });
  }

  // ---- 2-instance flow: scale + switchover ----
  if (includeScale) {
    await step('scale_cluster 1 → 2 instances', async () => {
      await call(k8s, 'scale_cluster', { name: cluster, namespace: ns, instances: 2 });
    });

    await step('wait_for_cluster (readyInstances>=2)', async () => {
      await call(k8s, 'wait_for_cluster', {
        name: cluster,
        namespace: ns,
        readyInstances: 2,
        timeoutSec: 300,
      });
    });

    await step('switchover_primary (operator picks target)', async () => {
      const before = await call(k8s, 'get_cluster_status', { name: cluster, namespace: ns });
      const oldPrimaryMatch = before.match(/"currentPrimary": "([^"]+)"/);
      const oldPrimary = oldPrimaryMatch?.[1];
      await call(k8s, 'switchover_primary', { clusterName: cluster, namespace: ns });
      // Wait for primary to change OR for the switchover annotation to be set
      const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
      if (!text.includes('cnpg.io/triggerSwitchover')) {
        throw new Error('Switchover annotation not present');
      }
      if (!oldPrimary) throw new Error('Could not read currentPrimary before switchover');
    });

    await step('promote_replica (sets cnpg.io/forcePromote annotation)', async () => {
      const status = await call(k8s, 'get_cluster_status', { name: cluster, namespace: ns });
      const podsResp = await k8s.core.listNamespacedPod({
        namespace: ns,
        labelSelector: `cnpg.io/cluster=${cluster}`,
      });
      const pods = (podsResp as any).items ?? [];
      const replica = pods.find((p: any) => p.metadata?.labels?.['cnpg.io/instanceRole'] === 'replica');
      if (!replica) {
        // No replica role yet (switchover may have promoted ours), pick any pod that's not currentPrimary
        const m = status.match(/"currentPrimary": "([^"]+)"/);
        const currentPrimary = m?.[1];
        const candidate = pods.find((p: any) => p.metadata?.name && p.metadata.name !== currentPrimary);
        if (!candidate) throw new Error('No replica pod available for promote test');
        await call(k8s, 'promote_replica', {
          clusterName: cluster,
          namespace: ns,
          targetPod: candidate.metadata.name,
        });
      } else {
        await call(k8s, 'promote_replica', {
          clusterName: cluster,
          namespace: ns,
          targetPod: replica.metadata.name,
        });
      }
      const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
      if (!text.includes('cnpg.io/forcePromote')) throw new Error('forcePromote annotation not present');
    });
  }

  // ---- hibernate (slow: tears down pods then brings them back) ----
  if (includeHibernate) {
    await step('pause_cluster (hibernation=on)', async () => {
      await call(k8s, 'pause_cluster', { clusterName: cluster, namespace: ns });
      const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
      if (!text.includes('"cnpg.io/hibernation": "on"')) throw new Error('hibernation not on');
    });

    await step('resume_cluster (annotation removed)', async () => {
      await call(k8s, 'resume_cluster', { clusterName: cluster, namespace: ns });
      const text = await call(k8s, 'get_cluster', { name: cluster, namespace: ns });
      if (text.includes('"cnpg.io/hibernation": "on"')) throw new Error('hibernation still on');
    });
  }

  // ---- cleanup ----
  await step('cleanup: delete_database', async () => {
    await call(k8s, 'delete_database', { name: 'mcptest-app', namespace: ns });
  });

  await step('cleanup: delete_cluster', async () => {
    await call(k8s, 'delete_cluster', { name: cluster, namespace: ns });
  });

  // ---- coverage report ----
  const declaredNames = new Set(allTools.map((t) => t.name));
  const untested = [...declaredNames].filter((n) => !exercised.has(n)).sort();
  console.log(`\n# Result: ${pass} pass, ${fail} fail`);
  console.log(`# Coverage: ${exercised.size} / ${declaredNames.size} tools exercised`);
  if (untested.length > 0) {
    console.log(`# Untested tools (${untested.length}):`);
    for (const n of untested) console.log(`#   - ${n}`);
  }
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});

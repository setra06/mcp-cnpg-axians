import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as crypto from 'node:crypto';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  BACKUP_PLURAL,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asItems, asObject, podExec } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'get_cluster_overview',
    description: 'Aggregated, human-friendly overview of a cluster: phase + ready instances + primary, pod roles & restarts, last 10 events, latest backup phase + age, and certificate expiry windows. Replaces five round-trips with a single call.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'hibernate_dump',
    description: 'Export a cluster definition + bootstrap secrets in a way that can be re-applied later (declarative dump). Returns a JSON document containing the Cluster CR and its credential/CA secrets, with managedFields and resourceVersion stripped. Pairs with `pause_cluster` for a true offline state.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        includeSecrets: {
          type: 'boolean',
          default: true,
          description: 'Include the cluster\'s -ca, -server, -replication, -app, -superuser secrets in the dump.',
        },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'run_sql',
    description: 'Run a SQL query against the cluster\'s primary via kubectl exec → psql. Read-only by default (wraps the query in BEGIN READ ONLY; ...; COMMIT;). Pass `readWrite: true` to disable. Defaults to the cluster\'s `app` database via the local `peer`-mapped postgres user, so the query runs as superuser inside the pod (no password needed).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        query: { type: 'string', description: 'SQL to execute.' },
        database: { type: 'string', default: 'app', description: 'Database to connect to.' },
        readWrite: {
          type: 'boolean',
          default: false,
          description: 'When true, the query runs with default_transaction_read_only OFF (writes allowed). Use with care.',
        },
        timeoutSec: { type: 'number', default: 30 },
      },
      required: ['clusterName', 'namespace', 'query'],
    },
  },
];

function ageFromTimestamp(ts?: string): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return undefined;
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function parseCertNotAfter(pem: string): { notBefore?: Date; notAfter?: Date } {
  // Strip PEM markers and decode the base64 body.
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!m) return {};
  try {
    const x509 = new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----${m[1]}-----END CERTIFICATE-----`);
    return { notBefore: new Date(x509.validFrom), notAfter: new Date(x509.validTo) };
  } catch {
    return {};
  }
}

const handlers: Record<string, ToolHandler> = {
  async get_cluster_overview(args, k8s) {
    // 1. cluster CR
    const cResp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.clusterName,
    });
    const cluster: any = asObject(cResp);

    // 2. pods
    const podsResp = await k8s.core.listNamespacedPod({
      namespace: args.namespace,
      labelSelector: `cnpg.io/cluster=${args.clusterName}`,
    });
    const pods = asItems(podsResp).map((p: any) => ({
      name: p.metadata?.name,
      role: p.metadata?.labels?.['cnpg.io/instanceRole'] ?? 'unknown',
      ready: p.status?.containerStatuses?.every((cs: any) => cs.ready) ?? false,
      restarts: p.status?.containerStatuses?.[0]?.restartCount ?? 0,
      ageSec: p.status?.startTime
        ? Math.round((Date.now() - new Date(p.status.startTime).getTime()) / 1000)
        : undefined,
    }));

    // 3. recent events
    const eventsResp = await k8s.core.listNamespacedEvent({
      namespace: args.namespace,
      fieldSelector: `involvedObject.name=${args.clusterName}`,
    });
    const events = asItems(eventsResp)
      .map((e: any) => ({
        type: e.type,
        reason: e.reason,
        message: e.message,
        lastTime: e.lastTimestamp,
      }))
      .sort((a, b) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())
      .slice(0, 10);

    // 4. latest backup
    const backupsResp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
    });
    const backupsForCluster = asItems(backupsResp).filter(
      (b: any) => b.spec?.cluster?.name === args.clusterName,
    );
    backupsForCluster.sort((a: any, b: any) => {
      const ta = new Date(a.status?.startedAt ?? a.metadata?.creationTimestamp ?? 0).getTime();
      const tb = new Date(b.status?.startedAt ?? b.metadata?.creationTimestamp ?? 0).getTime();
      return tb - ta;
    });
    const latest = backupsForCluster[0];
    const lastBackup = latest
      ? {
          name: latest.metadata?.name,
          phase: latest.status?.phase,
          method: latest.spec?.method ?? 'barmanObjectStore',
          startedAt: latest.status?.startedAt,
          stoppedAt: latest.status?.stoppedAt,
          age: ageFromTimestamp(latest.status?.stoppedAt ?? latest.status?.startedAt),
        }
      : undefined;

    // 5. cert expiry — read the -server and -ca secrets, decode the cert, extract notAfter.
    const serverSecretName = `${args.clusterName}-server`;
    const caSecretName = `${args.clusterName}-ca`;
    const decode = (b64: string | undefined) => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
    const certs: any = {};
    for (const [secretName, label] of [
      [serverSecretName, 'server'],
      [caSecretName, 'ca'],
    ] as const) {
      try {
        const sResp = await k8s.core.readNamespacedSecret({ namespace: args.namespace, name: secretName });
        const s: any = asObject(sResp);
        const pem = decode(s.data?.['tls.crt'] ?? s.data?.['ca.crt']);
        if (pem) {
          const { notAfter, notBefore } = parseCertNotAfter(pem);
          certs[label] = {
            secret: secretName,
            notBefore: notBefore?.toISOString(),
            notAfter: notAfter?.toISOString(),
            daysRemaining: notAfter
              ? Math.round((notAfter.getTime() - Date.now()) / 86_400_000)
              : undefined,
          };
        }
      } catch {
        certs[label] = { secret: secretName, error: 'not found or unreadable' };
      }
    }

    return json(`Overview for ${args.namespace}/${args.clusterName}`, {
      phase: cluster.status?.phase,
      phaseReason: cluster.status?.phaseReason,
      hibernation: cluster.metadata?.annotations?.['cnpg.io/hibernation'] ?? 'off',
      instances: cluster.spec?.instances,
      readyInstances: cluster.status?.readyInstances,
      currentPrimary: cluster.status?.currentPrimary,
      targetPrimary: cluster.status?.targetPrimary,
      image: cluster.spec?.imageName ?? cluster.status?.image ?? 'operator-default',
      pods,
      latestEvents: events,
      lastBackup,
      certificates: certs,
    });
  },

  async hibernate_dump(args, k8s) {
    const includeSecrets = args.includeSecrets !== false;
    const cResp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.clusterName,
    });
    const cluster: any = asObject(cResp);
    // Strip non-portable metadata so the dump can be re-applied elsewhere.
    const cleanCluster = {
      apiVersion: cluster.apiVersion,
      kind: cluster.kind,
      metadata: {
        name: cluster.metadata?.name,
        namespace: cluster.metadata?.namespace,
        annotations: cluster.metadata?.annotations,
        labels: cluster.metadata?.labels,
      },
      spec: cluster.spec,
    };

    const dump: any = { cluster: cleanCluster };

    if (includeSecrets) {
      const secretsToFetch = ['ca', 'server', 'replication', 'app', 'superuser'].map(
        (suffix) => `${args.clusterName}-${suffix}`,
      );
      const secrets: any[] = [];
      for (const name of secretsToFetch) {
        try {
          const sResp = await k8s.core.readNamespacedSecret({ namespace: args.namespace, name });
          const s: any = asObject(sResp);
          secrets.push({
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: { name: s.metadata?.name, namespace: s.metadata?.namespace },
            type: s.type,
            data: s.data,
          });
        } catch {
          // Secret may not exist (e.g. -superuser if the cluster doesn't enable it). Skip.
        }
      }
      dump.secrets = secrets;
    }

    return json(`Hibernate dump for ${args.namespace}/${args.clusterName}`, dump);
  },

  async run_sql(args, k8s) {
    // 1. find primary pod
    const cResp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.clusterName,
    });
    const cluster: any = asObject(cResp);
    const primaryPod: string | undefined = cluster.status?.currentPrimary;
    if (!primaryPod) {
      throw new Error(`Cluster ${args.namespace}/${args.clusterName} has no current primary (status.currentPrimary unset)`);
    }

    // 2. wrap the query for read-only mode unless readWrite=true.
    // BEGIN READ ONLY makes any DDL/DML in the body fail with "cannot execute X in a read-only transaction".
    const userQuery: string = args.query;
    const wrapped = args.readWrite
      ? userQuery
      : `BEGIN READ ONLY; ${userQuery.replace(/;\s*$/, '')}; COMMIT;`;

    // 3. exec psql in the postgres container
    const dbname: string = args.database ?? 'app';
    const result = await podExec(k8s.kc, {
      namespace: args.namespace,
      podName: primaryPod,
      container: 'postgres',
      // -A: unaligned, -t: tuples-only, -X: no .psqlrc, --csv could be added but plain text is fine
      command: ['psql', '-A', '-t', '-X', '-d', dbname, '-c', wrapped],
      timeoutMs: (args.timeoutSec ?? 30) * 1000,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `psql exit ${result.exitCode} on ${primaryPod}:\nstderr: ${result.stderr.trim()}\nstdout: ${result.stdout.trim()}`,
      );
    }
    const summary = `${args.readWrite ? 'read-write' : 'read-only'} query on ${args.namespace}/${args.clusterName} (db=${dbname}, primary=${primaryPod})`;
    if (!result.stdout && !result.stderr) {
      return ok(`${summary}\n(no rows)`);
    }
    return ok(
      `${summary}\n\n` +
        (result.stdout ? `stdout:\n\`\`\`\n${result.stdout}\n\`\`\`` : '') +
        (result.stderr ? `\n\nstderr:\n\`\`\`\n${result.stderr}\n\`\`\`` : ''),
    );
  },
};

export const operationsModule: ToolModule = { tools, handlers };

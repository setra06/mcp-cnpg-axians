import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asItems, asObject, podProxyGet } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'get_cluster_status',
    description: 'Concise health snapshot of a cluster: phase, instances, primary, conditions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'get_cluster_pods',
    description: 'List pods of a cluster with role label and readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'get_cluster_logs',
    description: 'Tail logs from cluster pods. Defaults to the postgres container, 100 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        podName: { type: 'string', description: 'Specific pod (otherwise all cluster pods)' },
        container: { type: 'string', enum: ['postgres', 'bootstrap-controller'], default: 'postgres' },
        tailLines: { type: 'number', default: 100 },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'get_cluster_events',
    description: 'Recent Kubernetes events whose involvedObject.name matches the cluster.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        limit: { type: 'number', default: 30 },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'get_cluster_pod_resources',
    description: 'Pod-level resource info from Kubernetes (requests/limits/restarts/role/readiness). Replaces the v3.0 get_cluster_metrics, which was misleadingly named: that tool never scraped Prometheus. For actual metrics, use get_cluster_metrics.',
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
    name: 'get_cluster_metrics',
    description: 'Scrape the CNPG Prometheus exporter (:9187/metrics) for each cluster pod via the K8s API server pods/proxy subresource. Returns the raw exposition or, if metricNames is given, only the matching lines. Requires monitoring to be enabled on the cluster.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        port: { type: 'number', default: 9187, description: 'Exporter port (default: 9187 for cnpg)' },
        path: { type: 'string', default: '/metrics' },
        metricNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of metric names to filter. If omitted, returns the full /metrics body.',
        },
        podName: { type: 'string', description: 'Specific pod (defaults to all cluster pods)' },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'get_cluster_certificates',
    description: 'List CNPG-managed cert secrets (server, ca, replication, client) for a cluster.',
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
    name: 'get_connection_info',
    description: 'Return rw/ro/r service hostnames for a cluster, plus the names of credential secrets (does NOT return secret values — fetch them with kubectl if needed).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        includeCredentials: {
          type: 'boolean',
          default: false,
          description: 'If true, decode and return user/password from the cluster app secret. WARNING: secrets in the response.',
        },
      },
      required: ['clusterName', 'namespace'],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async get_cluster_status(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.name,
    });
    const c: any = asObject(resp);
    return json(`Status for ${args.namespace}/${args.name}`, {
      phase: c.status?.phase,
      phaseReason: c.status?.phaseReason,
      instances: c.spec?.instances,
      readyInstances: c.status?.readyInstances,
      currentPrimary: c.status?.currentPrimary,
      targetPrimary: c.status?.targetPrimary,
      hibernation: c.metadata?.annotations?.['cnpg.io/hibernation'] ?? 'off',
      image: c.spec?.imageName ?? c.status?.image ?? 'operator-default',
      conditions: c.status?.conditions,
      instancesStatus: c.status?.instancesStatus,
    });
  },

  async get_cluster_pods(args, k8s) {
    const resp = await k8s.core.listNamespacedPod({
      namespace: args.namespace,
      labelSelector: `cnpg.io/cluster=${args.name}`,
    });
    const pods = asItems(resp).map((p: any) => ({
      name: p.metadata?.name,
      role: p.metadata?.labels?.['cnpg.io/instanceRole'],
      phase: p.status?.phase,
      ready: p.status?.containerStatuses?.every((cs: any) => cs.ready) ?? false,
      restarts: p.status?.containerStatuses?.[0]?.restartCount ?? 0,
      node: p.spec?.nodeName,
      ip: p.status?.podIP,
    }));
    return json(`Pods for ${args.namespace}/${args.name}`, pods);
  },

  async get_cluster_logs(args, k8s) {
    const container = args.container ?? 'postgres';
    const tailLines = args.tailLines ?? 100;
    let podNames: string[] = [];
    if (args.podName) {
      podNames = [args.podName];
    } else {
      const resp = await k8s.core.listNamespacedPod({
        namespace: args.namespace,
        labelSelector: `cnpg.io/cluster=${args.clusterName}`,
      });
      podNames = asItems(resp).map((p: any) => p.metadata?.name).filter(Boolean);
    }
    if (podNames.length === 0) {
      return ok(`No pods found for cluster ${args.namespace}/${args.clusterName}`);
    }
    const sections = await Promise.all(
      podNames.map(async (name) => {
        try {
          const log = await k8s.core.readNamespacedPodLog({
            name,
            namespace: args.namespace,
            container,
            tailLines,
          });
          const text = typeof log === 'string' ? log : (log as any)?.body ?? JSON.stringify(log);
          return `## Pod: ${name}\n\n\`\`\`\n${text}\n\`\`\``;
        } catch (e) {
          return `## Pod: ${name}\n\nError: ${e instanceof Error ? e.message : String(e)}`;
        }
      }),
    );
    return ok(`Logs for ${args.namespace}/${args.clusterName} (container=${container}, tail=${tailLines}):\n\n${sections.join('\n\n')}`);
  },

  async get_cluster_events(args, k8s) {
    const resp = await k8s.core.listNamespacedEvent({
      namespace: args.namespace,
      fieldSelector: `involvedObject.name=${args.clusterName}`,
    });
    const events = asItems(resp)
      .map((e: any) => ({
        type: e.type,
        reason: e.reason,
        message: e.message,
        firstTime: e.firstTimestamp,
        lastTime: e.lastTimestamp,
        count: e.count,
        component: e.source?.component,
      }))
      .sort((a: any, b: any) => new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime())
      .slice(0, args.limit ?? 30);
    return json(`Events for ${args.namespace}/${args.clusterName} (${events.length})`, events);
  },

  async get_cluster_pod_resources(args, k8s) {
    const resp = await k8s.core.listNamespacedPod({
      namespace: args.namespace,
      labelSelector: `cnpg.io/cluster=${args.clusterName}`,
    });
    const pods = asItems(resp).map((p: any) => ({
      name: p.metadata?.name,
      role: p.metadata?.labels?.['cnpg.io/instanceRole'],
      ready: p.status?.containerStatuses?.every((cs: any) => cs.ready) ?? false,
      restarts: p.status?.containerStatuses?.[0]?.restartCount ?? 0,
      cpuRequests: p.spec?.containers?.[0]?.resources?.requests?.cpu,
      memoryRequests: p.spec?.containers?.[0]?.resources?.requests?.memory,
      cpuLimits: p.spec?.containers?.[0]?.resources?.limits?.cpu,
      memoryLimits: p.spec?.containers?.[0]?.resources?.limits?.memory,
    }));
    return json(`Pod resources for ${args.namespace}/${args.clusterName}`, {
      totalPods: pods.length,
      readyPods: pods.filter((p) => p.ready).length,
      pods,
    });
  },

  async get_cluster_metrics(args, k8s) {
    const port: number = args.port ?? 9187;
    const path: string = args.path ?? '/metrics';
    const metricNames: string[] | undefined = Array.isArray(args.metricNames) ? args.metricNames : undefined;

    let podNames: string[] = [];
    if (args.podName) {
      podNames = [args.podName];
    } else {
      const resp = await k8s.core.listNamespacedPod({
        namespace: args.namespace,
        labelSelector: `cnpg.io/cluster=${args.clusterName}`,
      });
      podNames = asItems(resp).map((p: any) => p.metadata?.name).filter(Boolean);
    }
    if (podNames.length === 0) {
      return ok(`No pods found for cluster ${args.namespace}/${args.clusterName}`);
    }

    const sections: string[] = [];
    for (const podName of podNames) {
      try {
        const body = await podProxyGet(k8s.kc, {
          namespace: args.namespace,
          podName,
          port,
          path,
          timeoutMs: 8_000,
        });
        const filtered = metricNames
          ? body
              .split('\n')
              .filter((line) => {
                if (!line || line.startsWith('#')) return false;
                const name = line.split('{')[0].split(' ')[0];
                return metricNames.includes(name);
              })
              .join('\n')
          : body;
        const text = filtered || '(no matching metrics)';
        sections.push(`## ${podName}\n\n\`\`\`\n${text}\n\`\`\``);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        sections.push(`## ${podName}\n\nError: ${msg}`);
      }
    }
    const header = metricNames
      ? `Metrics for ${args.namespace}/${args.clusterName} (filtered to ${metricNames.length} names, port ${port}${path}):`
      : `Metrics for ${args.namespace}/${args.clusterName} (port ${port}${path}):`;
    return ok(`${header}\n\n${sections.join('\n\n')}`);
  },

  async get_cluster_certificates(args, k8s) {
    const resp = await k8s.core.listNamespacedSecret({ namespace: args.namespace });
    const items = asItems(resp);
    const prefix = `${args.clusterName}-`;
    const filtered = items.filter((s: any) => {
      const name: string = s.metadata?.name ?? '';
      if (!name.startsWith(prefix)) return false;
      const suffix = name.slice(prefix.length);
      return ['ca', 'server', 'replication', 'streaming-replica'].includes(suffix) || suffix.endsWith('-cert');
    });
    return json(`Certificate-bearing secrets for ${args.namespace}/${args.clusterName}`,
      filtered.map((s: any) => ({
        name: s.metadata?.name,
        type: s.type,
        keys: Object.keys(s.data ?? {}),
        creationTimestamp: s.metadata?.creationTimestamp,
      })),
    );
  },

  async get_connection_info(args, k8s) {
    const services = await k8s.core.listNamespacedService({ namespace: args.namespace });
    const svcPrefix = `${args.clusterName}-`;
    const svcs = asItems(services)
      .filter((s: any) => {
        const name: string = s.metadata?.name ?? '';
        return name.startsWith(svcPrefix) && ['rw', 'ro', 'r'].includes(name.slice(svcPrefix.length));
      })
      .map((s: any) => ({
        name: s.metadata?.name,
        role: inferRoleFromName(s.metadata?.name, args.clusterName),
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: (s.spec?.ports ?? []).map((p: any) => ({ name: p.name, port: p.port, target: p.targetPort })),
        hostname: `${s.metadata?.name}.${args.namespace}.svc`,
      }));

    const secrets = await k8s.core.listNamespacedSecret({ namespace: args.namespace });
    const credSecrets = asItems(secrets)
      .filter((s: any) => {
        const name: string = s.metadata?.name ?? '';
        if (!name.startsWith(svcPrefix)) return false;
        const suffix = name.slice(svcPrefix.length);
        return ['app', 'superuser', 'replication'].includes(suffix);
      })
      .map((s: any) => ({
        name: s.metadata?.name,
        type: s.type,
        keys: Object.keys(s.data ?? {}),
      }));

    const result: any = {
      services: svcs,
      credentialSecrets: credSecrets,
      hint: 'Use the rw service for writes, ro for reads from any replica, r for reads explicitly excluding the primary.',
    };

    if (args.includeCredentials) {
      const appSecret = asItems(secrets).find((s: any) => s.metadata?.name === `${args.clusterName}-app`);
      if (appSecret) {
        result.appCredentials = {
          username: appSecret.data?.username ? Buffer.from(appSecret.data.username, 'base64').toString() : undefined,
          password: appSecret.data?.password ? Buffer.from(appSecret.data.password, 'base64').toString() : undefined,
          dbname: appSecret.data?.dbname ? Buffer.from(appSecret.data.dbname, 'base64').toString() : undefined,
          host: appSecret.data?.host ? Buffer.from(appSecret.data.host, 'base64').toString() : undefined,
          port: appSecret.data?.port ? Buffer.from(appSecret.data.port, 'base64').toString() : undefined,
        };
        result.warning = 'Credentials included in plaintext. Treat the response as sensitive.';
      }
    }
    return json(`Connection info for ${args.namespace}/${args.clusterName}`, result);
  },
};

function inferRoleFromName(svcName: string | undefined, cluster: string): string | undefined {
  if (!svcName) return undefined;
  if (svcName === `${cluster}-rw`) return 'rw';
  if (svcName === `${cluster}-ro`) return 'ro';
  if (svcName === `${cluster}-r`) return 'r';
  return undefined;
}

export const observabilityModule: ToolModule = { tools, handlers };

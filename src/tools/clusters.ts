import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  DEFAULT_CNPG_IMAGE_REPO,
  PROJECTION_SCHEMA_PROPERTIES,
  projectOrStrip,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asItems, asObject, mutateCustomObject } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'list_clusters',
    description: 'List all PostgreSQL clusters across all namespaces or filtered by namespace',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Optional: filter by specific namespace' },
      },
    },
  },
  {
    name: 'get_cluster',
    description: 'Get the spec and status of a specific PostgreSQL cluster. Returns the object stripped of metadata noise (managedFields, resourceVersion, etc.) by default. Pass `fields: ["spec.instances", "status.currentPrimary"]` for a focused projection, or `raw: true` for the full object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the cluster' },
        namespace: { type: 'string', description: 'Namespace of the cluster' },
        ...PROJECTION_SCHEMA_PROPERTIES,
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'create_cluster',
    description: 'Create a new PostgreSQL cluster. Defaults to a 3-instance cluster running the operator default PostgreSQL major version.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        instances: { type: 'number', default: 3 },
        storageSize: { type: 'string', default: '1Gi' },
        storageClass: { type: 'string' },
        postgresMajor: {
          type: 'number',
          description: 'PostgreSQL major version (e.g. 16, 17). Translated to ghcr.io/cloudnative-pg/postgresql:<major>. Optional — operator default applies if omitted.',
        },
        imageName: {
          type: 'string',
          description: 'Full container image (overrides postgresMajor). Use the CNPG-distributed images for compatibility.',
        },
        bootstrapDatabase: { type: 'string', default: 'app' },
        bootstrapOwner: { type: 'string', default: 'app' },
        monitoringEnabled: { type: 'boolean', default: true },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'delete_cluster',
    description: 'Delete a PostgreSQL cluster. PVCs are retained or deleted based on the cluster reclaim policy.',
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
    name: 'scale_cluster',
    description: 'Scale a PostgreSQL cluster to a different number of instances',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        instances: { type: 'number' },
      },
      required: ['name', 'namespace', 'instances'],
    },
  },
  {
    name: 'patch_cluster_config',
    description: 'Patch a cluster configuration: PostgreSQL parameters, pod resource requests/limits, and/or pg_hba.conf user-defined rules. Triggers a rolling update or reload as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        parameters: {
          type: 'object',
          description: 'Map of postgresql.conf parameters, e.g. {"max_connections": "200"}',
          additionalProperties: { type: 'string' },
        },
        resources: {
          type: 'object',
          description: 'Pod resources block, e.g. {"requests": {"cpu": "1", "memory": "2Gi"}, "limits": {...}}',
        },
        pgHba: {
          type: 'array',
          items: { type: 'string' },
          description: 'User-defined pg_hba.conf lines to append (e.g. ["hostssl all streaming_replica all cert map=cnpg_streaming_replica"]). Replaces any existing user-defined rules.',
        },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'switchover_primary',
    description: 'Trigger a planned switchover by setting the cnpg.io/targetPrimary annotation. The operator will gracefully demote the current primary and promote the target. If targetPrimary is omitted, the operator chooses an eligible replica.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        targetPrimary: { type: 'string', description: 'Pod name to promote (e.g. cluster-2). Optional.' },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'promote_replica',
    description: 'Force-promote a replica pod to primary. Used in emergency / data-loss-recovery scenarios. Sets cnpg.io/forcePromote annotation. Use switchover_primary for planned operations.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        targetPod: { type: 'string', description: 'Pod name to promote' },
      },
      required: ['clusterName', 'namespace', 'targetPod'],
    },
  },
  {
    name: 'pause_cluster',
    description: 'Hibernate a cluster (cnpg.io/hibernation=on). Pods are removed but PVCs and config are preserved.',
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
    name: 'resume_cluster',
    description: 'Resume a hibernated cluster by removing the hibernation annotation.',
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
    name: 'restart_cluster',
    description: 'Trigger a rolling restart of all instances by setting cnpg.io/restartedAt to the current timestamp.',
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
    name: 'reload_config',
    description: 'Trigger a reload of PostgreSQL config across all instances (cnpg.io/reloadedAt annotation). Lighter than restart — only re-reads SIGHUP-able parameters.',
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
    name: 'upgrade_postgres_version',
    description: 'Update the cluster image to the requested PostgreSQL major version. Uses ghcr.io/cloudnative-pg/postgresql:<major> by default. CNPG handles the rolling minor-version upgrade. Major-version jumps require a separate procedure (see in-place vs new-cluster strategies in CNPG docs).',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        postgresMajor: { type: 'number', description: 'Target major version (e.g. 17)' },
        imageName: {
          type: 'string',
          description: 'Full image override. If both postgresMajor and imageName are given, imageName wins.',
        },
      },
      required: ['clusterName', 'namespace'],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async list_clusters(args, k8s) {
    const ns: string | undefined = args?.namespace;
    const resp = ns
      ? await k8s.custom.listNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: ns,
          plural: CLUSTER_PLURAL,
        })
      : await k8s.custom.listClusterCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          plural: CLUSTER_PLURAL,
        });
    const items = asItems(resp);
    if (items.length === 0) {
      return ok(ns ? `No clusters in namespace "${ns}"` : 'No clusters found in any namespace');
    }
    const summary = items.map((c: any) => ({
      name: c.metadata?.name,
      namespace: c.metadata?.namespace,
      instances: c.spec?.instances,
      image: c.spec?.imageName ?? c.status?.image ?? 'operator-default',
      phase: c.status?.phase ?? 'Unknown',
      readyInstances: c.status?.readyInstances ?? 0,
      currentPrimary: c.status?.currentPrimary,
      hibernation: c.metadata?.annotations?.['cnpg.io/hibernation'] ?? 'off',
    }));
    return json(`Found ${items.length} clusters:`, summary);
  },

  async get_cluster(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.name,
    });
    const projected = projectOrStrip(asObject(resp), { fields: args.fields, raw: args.raw });
    return json(`## Cluster ${args.namespace}/${args.name}`, projected);
  },

  async create_cluster(args, k8s) {
    const {
      name,
      namespace,
      instances = 3,
      storageSize = '1Gi',
      storageClass,
      postgresMajor,
      imageName,
      bootstrapDatabase = 'app',
      bootstrapOwner = 'app',
      monitoringEnabled = true,
    } = args;

    const image = imageName ?? (postgresMajor ? `${DEFAULT_CNPG_IMAGE_REPO}:${postgresMajor}` : undefined);

    const spec: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: { name, namespace },
      spec: {
        instances,
        ...(image && { imageName: image }),
        bootstrap: {
          initdb: {
            database: bootstrapDatabase,
            owner: bootstrapOwner,
          },
        },
        storage: {
          size: storageSize,
          ...(storageClass && { storageClass }),
        },
        monitoring: { enablePodMonitor: monitoringEnabled },
      },
    };

    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace,
      plural: CLUSTER_PLURAL,
      body: spec,
    });
    return ok(`Created cluster ${namespace}/${name} (${instances} instances, image=${image ?? 'operator-default'})`);
  },

  async delete_cluster(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.name,
    });
    return ok(`Deleted cluster ${args.namespace}/${args.name}`);
  },

  async scale_cluster(args, k8s) {
    await mutateCluster(k8s, args.name, args.namespace, (c) => {
      c.spec.instances = args.instances;
    });
    return ok(`Scaled ${args.namespace}/${args.name} to ${args.instances} instances`);
  },

  async patch_cluster_config(args, k8s) {
    const { clusterName, namespace, parameters, resources, pgHba } = args;
    if (!parameters && !resources && !pgHba) {
      throw new Error('patch_cluster_config requires at least one of: parameters, resources, pgHba');
    }
    await mutateCluster(k8s, clusterName, namespace, (c) => {
      if (parameters) {
        c.spec.postgresql ??= {};
        c.spec.postgresql.parameters ??= {};
        Object.assign(c.spec.postgresql.parameters, parameters);
      }
      if (resources) {
        c.spec.resources = resources;
      }
      if (pgHba) {
        c.spec.postgresql ??= {};
        c.spec.postgresql.pg_hba = pgHba;
      }
    });
    const changes = [
      parameters && `parameters: ${Object.keys(parameters).join(', ')}`,
      resources && 'resources updated',
      pgHba && `pg_hba: ${pgHba.length} rule(s)`,
    ]
      .filter(Boolean)
      .join('; ');
    return ok(`Patched ${namespace}/${clusterName} (${changes}). Rolling update or reload will apply changes.`);
  },

  async switchover_primary(args, k8s) {
    const { clusterName, namespace, targetPrimary } = args;
    await mutateCluster(k8s, clusterName, namespace, (c) => {
      c.metadata.annotations ??= {};
      if (targetPrimary) {
        c.metadata.annotations['cnpg.io/targetPrimary'] = targetPrimary;
      } else {
        c.metadata.annotations['cnpg.io/triggerSwitchover'] = new Date().toISOString();
      }
    });
    return ok(
      targetPrimary
        ? `Switchover requested on ${namespace}/${clusterName} → targetPrimary=${targetPrimary}`
        : `Switchover requested on ${namespace}/${clusterName} (operator picks the target)`,
    );
  },

  async promote_replica(args, k8s) {
    const { clusterName, namespace, targetPod } = args;
    await mutateCluster(k8s, clusterName, namespace, (c) => {
      c.metadata.annotations ??= {};
      c.metadata.annotations['cnpg.io/forcePromote'] = targetPod;
    });
    return ok(
      `Force-promote requested on ${namespace}/${clusterName} → ${targetPod}. WARNING: bypasses replication-lag checks; use switchover_primary for planned ops.`,
    );
  },

  async pause_cluster(args, k8s) {
    await mutateCluster(k8s, args.clusterName, args.namespace, (c) => {
      c.metadata.annotations ??= {};
      c.metadata.annotations['cnpg.io/hibernation'] = 'on';
    });
    return ok(`Hibernation enabled on ${args.namespace}/${args.clusterName}. Pods will be removed; PVCs preserved.`);
  },

  async resume_cluster(args, k8s) {
    await mutateCluster(k8s, args.clusterName, args.namespace, (c) => {
      delete c.metadata.annotations?.['cnpg.io/hibernation'];
    });
    return ok(`Hibernation removed on ${args.namespace}/${args.clusterName}. Cluster will resume.`);
  },

  async restart_cluster(args, k8s) {
    const ts = new Date().toISOString();
    await mutateCluster(k8s, args.clusterName, args.namespace, (c) => {
      c.metadata.annotations ??= {};
      c.metadata.annotations['cnpg.io/restartedAt'] = ts;
    });
    return ok(`Rolling restart triggered on ${args.namespace}/${args.clusterName} at ${ts}`);
  },

  async reload_config(args, k8s) {
    const ts = new Date().toISOString();
    await mutateCluster(k8s, args.clusterName, args.namespace, (c) => {
      c.metadata.annotations ??= {};
      c.metadata.annotations['cnpg.io/reloadedAt'] = ts;
    });
    return ok(`Config reload triggered on ${args.namespace}/${args.clusterName} at ${ts}`);
  },

  async upgrade_postgres_version(args, k8s) {
    const { clusterName, namespace, postgresMajor, imageName } = args;
    if (!postgresMajor && !imageName) {
      throw new Error('upgrade_postgres_version requires postgresMajor or imageName');
    }
    const target = imageName ?? `${DEFAULT_CNPG_IMAGE_REPO}:${postgresMajor}`;
    await mutateCluster(k8s, clusterName, namespace, (c) => {
      c.spec.imageName = target;
      delete c.spec.imageCatalogRef;
    });
    return ok(
      `Cluster ${namespace}/${clusterName} image set to ${target}. CNPG will roll instances. Note: major version jumps may require pg_upgrade — check cluster events after.`,
    );
  },
};

async function mutateCluster(
  k8s: { custom: any },
  name: string,
  namespace: string,
  mutate: (c: any) => void,
) {
  await mutateCustomObject(
    k8s.custom,
    { group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: CLUSTER_PLURAL, name },
    mutate,
  );
}

export const clustersModule: ToolModule = { tools, handlers };

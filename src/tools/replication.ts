import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  PUBLICATION_PLURAL,
  SUBSCRIPTION_PLURAL,
  DEFAULT_CNPG_IMAGE_REPO,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asItems, asObject, mutateCustomObject } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'create_replica_cluster',
    description: 'Create a streaming replica cluster from another cluster. The source cluster is registered as an externalCluster.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the new replica cluster' },
        namespace: { type: 'string' },
        sourceClusterName: { type: 'string', description: 'Name of the upstream cluster' },
        sourceNamespace: { type: 'string', description: 'Namespace of the upstream cluster (defaults to same as new replica)' },
        instances: { type: 'number', default: 1 },
        storageSize: { type: 'string', default: '1Gi' },
        storageClass: { type: 'string' },
        postgresMajor: { type: 'number', description: 'Must match the source cluster major version' },
        imageName: { type: 'string', description: 'Override container image' },
      },
      required: ['name', 'namespace', 'sourceClusterName'],
    },
  },
  {
    name: 'set_synchronous_replication',
    description: 'Configure synchronous replication via spec.minSyncReplicas and spec.maxSyncReplicas. CNPG generates synchronous_standby_names automatically — do not set the postgres parameters by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        minSyncReplicas: { type: 'number', description: 'Minimum number of synchronous replicas (0 to disable)' },
        maxSyncReplicas: { type: 'number', description: 'Maximum number of synchronous replicas. Cluster instances must be > maxSyncReplicas to keep one async copy.' },
      },
      required: ['clusterName', 'namespace', 'minSyncReplicas', 'maxSyncReplicas'],
    },
  },
  {
    name: 'list_publications',
    description: 'List Publication resources (CNPG 1.24+ logical replication).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        clusterName: { type: 'string', description: 'Optional: filter by cluster' },
      },
      required: ['namespace'],
    },
  },
  {
    name: 'create_publication',
    description: 'Create a Publication resource for logical replication.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the Publication resource (and SQL publication name unless overridden)' },
        namespace: { type: 'string' },
        clusterName: { type: 'string' },
        publicationName: { type: 'string', description: 'Override SQL publication name (defaults to "name")' },
        dbName: { type: 'string', description: 'Database the publication lives in' },
        allTables: { type: 'boolean', description: 'Publish all tables (cannot mix with objects)' },
        objects: {
          type: 'array',
          description: 'List of {table: {name, columns?, only?}} entries. Cannot mix with allTables.',
        },
        parameters: { type: 'object', description: 'Publication parameters (e.g. publish: "insert,update,delete")' },
      },
      required: ['name', 'namespace', 'clusterName', 'dbName'],
    },
  },
  {
    name: 'delete_publication',
    description: 'Delete a Publication resource.',
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
    name: 'list_subscriptions',
    description: 'List Subscription resources (CNPG 1.24+ logical replication).',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        clusterName: { type: 'string', description: 'Optional: filter by cluster' },
      },
      required: ['namespace'],
    },
  },
  {
    name: 'create_subscription',
    description: 'Create a Subscription resource consuming a publication on an external cluster.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the Subscription resource (and SQL subscription name unless overridden)' },
        namespace: { type: 'string' },
        clusterName: { type: 'string', description: 'The local cluster receiving the subscription' },
        subscriptionName: { type: 'string', description: 'Override SQL subscription name (defaults to "name")' },
        dbName: { type: 'string', description: 'Database to attach the subscription in' },
        externalClusterName: { type: 'string', description: 'Reference to spec.externalClusters[].name on the local cluster' },
        publicationName: { type: 'string' },
        publicationDBName: { type: 'string', description: 'Database name on the upstream where the publication exists' },
        parameters: { type: 'object', description: 'Subscription parameters (e.g. {"copy_data": "true"})' },
      },
      required: ['name', 'namespace', 'clusterName', 'dbName', 'externalClusterName', 'publicationName'],
    },
  },
  {
    name: 'delete_subscription',
    description: 'Delete a Subscription resource.',
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
    name: 'get_replication_status',
    description: 'Report instance roles, ready/lag info from the cluster status, plus pod-level role labels.',
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
    name: 'register_external_cluster',
    description: 'Add (or update) an entry in spec.externalClusters on a Cluster. Idempotent on the entry name. Use before create_subscription so the Subscription\'s externalClusterName resolves.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string', description: 'Local cluster to register the externalCluster on' },
        namespace: { type: 'string' },
        externalCluster: {
          type: 'object',
          description: 'Full externalClusters[] entry: name, connectionParameters, sslKey/sslCert/sslRootCert (or password), etc.',
        },
      },
      required: ['clusterName', 'namespace', 'externalCluster'],
    },
  },
  {
    name: 'unregister_external_cluster',
    description: 'Remove an entry from spec.externalClusters by name. No-op if not present.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        externalClusterName: { type: 'string' },
      },
      required: ['clusterName', 'namespace', 'externalClusterName'],
    },
  },
  {
    name: 'setup_logical_subscription',
    description: 'Composite tool that wires logical replication between two CNPG clusters in a single call: registers the source as an externalCluster on the local cluster (using its TLS replication secrets), creates the Subscription CR, and waits for applied=true. Cross-namespace requires allowSecretCopy=true (copies the source\'s -ca and -replication secrets into the local namespace under copied-<source>-* names).',
    inputSchema: {
      type: 'object',
      properties: {
        localCluster: { type: 'string' },
        namespace: { type: 'string', description: 'Namespace of the local cluster (and where the Subscription is created)' },
        sourceCluster: { type: 'string' },
        sourceNamespace: { type: 'string', description: 'Defaults to the local cluster\'s namespace' },
        dbName: { type: 'string', description: 'Database on the local cluster receiving the subscription' },
        publicationName: { type: 'string' },
        publicationDBName: {
          type: 'string',
          description: 'Database on the source where the publication exists. Defaults to dbName.',
        },
        subscriptionName: { type: 'string', description: 'K8s resource name. Defaults to "<localCluster>-from-<sourceCluster>". May contain hyphens (the SQL name is derived separately).' },
        sqlSubscriptionName: {
          type: 'string',
          description: 'PostgreSQL subscription name (must match [a-z0-9_]+). Defaults to subscriptionName with hyphens replaced by underscores.',
        },
        externalClusterName: { type: 'string', description: 'Defaults to sourceCluster' },
        allowSecretCopy: {
          type: 'boolean',
          default: false,
          description: 'When sourceNamespace differs, copy the upstream\'s -ca and -replication secrets into the local namespace.',
        },
        timeoutSec: {
          type: 'number',
          default: 60,
          description: 'How long to wait for the Subscription to reach applied=true.',
        },
      },
      required: ['localCluster', 'namespace', 'sourceCluster', 'dbName', 'publicationName'],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async create_replica_cluster(args, k8s) {
    const sourceNamespace = args.sourceNamespace ?? args.namespace;
    const externalName = args.sourceClusterName;
    const image = args.imageName ?? (args.postgresMajor ? `${DEFAULT_CNPG_IMAGE_REPO}:${args.postgresMajor}` : undefined);

    const replicaSecretBase = `${args.sourceClusterName}-replication`;
    const caSecret = `${args.sourceClusterName}-ca`;

    const cluster: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: { name: args.name, namespace: args.namespace },
      spec: {
        instances: args.instances ?? 1,
        ...(image && { imageName: image }),
        bootstrap: {
          pg_basebackup: {
            source: externalName,
          },
        },
        replica: {
          enabled: true,
          source: externalName,
        },
        externalClusters: [
          {
            name: externalName,
            connectionParameters: {
              host: `${args.sourceClusterName}-rw.${sourceNamespace}.svc`,
              user: 'streaming_replica',
              dbname: 'postgres',
              sslmode: 'verify-full',
            },
            sslKey: { name: replicaSecretBase, key: 'tls.key' },
            sslCert: { name: replicaSecretBase, key: 'tls.crt' },
            sslRootCert: { name: caSecret, key: 'ca.crt' },
          },
        ],
        storage: {
          size: args.storageSize ?? '1Gi',
          ...(args.storageClass && { storageClass: args.storageClass }),
        },
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      body: cluster,
    });
    return ok(
      `Replica cluster ${args.namespace}/${args.name} created from ${sourceNamespace}/${args.sourceClusterName}. Note: assumes the upstream's TLS secrets ${replicaSecretBase} and ${caSecret} are reachable in this namespace; for cross-namespace replicas you may need to copy/recreate them.`,
    );
  },

  async set_synchronous_replication(args, k8s) {
    const { clusterName, namespace, minSyncReplicas, maxSyncReplicas } = args;
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: CLUSTER_PLURAL, name: clusterName },
      (cluster: any) => {
        cluster.spec.minSyncReplicas = minSyncReplicas;
        cluster.spec.maxSyncReplicas = maxSyncReplicas;
        if (cluster.spec.postgresql?.parameters) {
          delete cluster.spec.postgresql.parameters['synchronous_commit'];
          delete cluster.spec.postgresql.parameters['synchronous_standby_names'];
        }
      },
    );
    return ok(
      `Sync replication set on ${namespace}/${clusterName}: min=${minSyncReplicas}, max=${maxSyncReplicas}. CNPG manages synchronous_standby_names automatically.`,
    );
  },

  async list_publications(args, k8s) {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: PUBLICATION_PLURAL,
    });
    let items = asItems(resp);
    if (args.clusterName) {
      items = items.filter((p: any) => p.spec?.cluster?.name === args.clusterName);
    }
    const summary = items.map((p: any) => ({
      name: p.metadata?.name,
      cluster: p.spec?.cluster?.name,
      dbName: p.spec?.dbname,
      sqlName: p.spec?.name,
      target: p.spec?.target?.allTables ? 'allTables' : `${(p.spec?.target?.objects ?? []).length} object(s)`,
      applied: p.status?.applied,
      message: p.status?.message,
    }));
    return json(`Found ${items.length} Publications`, summary);
  },

  async create_publication(args, k8s) {
    const target: any = args.allTables
      ? { allTables: true }
      : { objects: args.objects ?? [] };
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Publication',
      metadata: { name: args.name, namespace: args.namespace },
      spec: {
        cluster: { name: args.clusterName },
        dbname: args.dbName,
        name: args.publicationName ?? args.name,
        target,
        ...(args.parameters && { parameters: args.parameters }),
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: PUBLICATION_PLURAL,
      body,
    });
    return ok(`Publication ${args.namespace}/${args.name} created on ${args.clusterName}/${args.dbName}`);
  },

  async delete_publication(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: PUBLICATION_PLURAL,
      name: args.name,
    });
    return ok(`Deleted Publication ${args.namespace}/${args.name}`);
  },

  async list_subscriptions(args, k8s) {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: SUBSCRIPTION_PLURAL,
    });
    let items = asItems(resp);
    if (args.clusterName) {
      items = items.filter((s: any) => s.spec?.cluster?.name === args.clusterName);
    }
    const summary = items.map((s: any) => ({
      name: s.metadata?.name,
      cluster: s.spec?.cluster?.name,
      dbName: s.spec?.dbname,
      sqlName: s.spec?.name,
      externalCluster: s.spec?.externalClusterName,
      publication: s.spec?.publicationName,
      applied: s.status?.applied,
      message: s.status?.message,
    }));
    return json(`Found ${items.length} Subscriptions`, summary);
  },

  async create_subscription(args, k8s) {
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Subscription',
      metadata: { name: args.name, namespace: args.namespace },
      spec: {
        cluster: { name: args.clusterName },
        dbname: args.dbName,
        name: args.subscriptionName ?? args.name,
        externalClusterName: args.externalClusterName,
        publicationName: args.publicationName,
        ...(args.publicationDBName && { publicationDBName: args.publicationDBName }),
        ...(args.parameters && { parameters: args.parameters }),
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: SUBSCRIPTION_PLURAL,
      body,
    });
    return ok(
      `Subscription ${args.namespace}/${args.name} created on ${args.clusterName}/${args.dbName} ← ${args.externalClusterName}.${args.publicationName}`,
    );
  },

  async delete_subscription(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: SUBSCRIPTION_PLURAL,
      name: args.name,
    });
    return ok(`Deleted Subscription ${args.namespace}/${args.name}`);
  },

  async get_replication_status(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.clusterName,
    });
    const cluster: any = asObject(resp);
    const podsResp = await k8s.core.listNamespacedPod({
      namespace: args.namespace,
      labelSelector: `cnpg.io/cluster=${args.clusterName}`,
    });
    const pods = asItems(podsResp).map((p: any) => ({
      name: p.metadata?.name,
      role: p.metadata?.labels?.['cnpg.io/instanceRole'],
      ready: p.status?.containerStatuses?.every((cs: any) => cs.ready) ?? false,
    }));
    return json(`Replication status for ${args.namespace}/${args.clusterName}`, {
      currentPrimary: cluster.status?.currentPrimary,
      targetPrimary: cluster.status?.targetPrimary,
      instances: cluster.spec?.instances,
      readyInstances: cluster.status?.readyInstances,
      minSyncReplicas: cluster.spec?.minSyncReplicas,
      maxSyncReplicas: cluster.spec?.maxSyncReplicas,
      instancesStatus: cluster.status?.instancesStatus,
      conditions: cluster.status?.conditions,
      pods,
    });
  },

  async register_external_cluster(args, k8s) {
    const newEntry = args.externalCluster;
    if (!newEntry?.name) throw new Error('externalCluster.name is required');
    let action: 'added' | 'updated' = 'added';
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: CLUSTER_PLURAL, name: args.clusterName },
      (cluster: any) => {
        cluster.spec.externalClusters ??= [];
        const existingIdx = cluster.spec.externalClusters.findIndex((e: any) => e.name === newEntry.name);
        if (existingIdx >= 0) {
          cluster.spec.externalClusters[existingIdx] = newEntry;
          action = 'updated';
        } else {
          cluster.spec.externalClusters.push(newEntry);
        }
      },
    );
    return ok(`externalCluster "${newEntry.name}" ${action} on ${args.namespace}/${args.clusterName}`);
  },

  async unregister_external_cluster(args, k8s) {
    let removed = false;
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: CLUSTER_PLURAL, name: args.clusterName },
      (cluster: any) => {
        const list = cluster.spec.externalClusters ?? [];
        const before = list.length;
        cluster.spec.externalClusters = list.filter((e: any) => e.name !== args.externalClusterName);
        removed = cluster.spec.externalClusters.length < before;
      },
    );
    return ok(
      removed
        ? `externalCluster "${args.externalClusterName}" removed from ${args.namespace}/${args.clusterName}`
        : `externalCluster "${args.externalClusterName}" not present on ${args.namespace}/${args.clusterName}; no-op`,
    );
  },

  async setup_logical_subscription(args, k8s) {
    const sourceNs: string = args.sourceNamespace ?? args.namespace;
    const externalClusterName: string = args.externalClusterName ?? args.sourceCluster;
    const subscriptionName: string =
      args.subscriptionName ?? `${args.localCluster}-from-${args.sourceCluster}`;
    // PostgreSQL replication slot/subscription names allow only lowercase, digits, underscore.
    // Default the SQL name to the K8s name with hyphens replaced; let callers override explicitly.
    const sqlSubscriptionName: string =
      args.sqlSubscriptionName ?? subscriptionName.replace(/-/g, '_').toLowerCase();
    if (!/^[a-z0-9_]+$/.test(sqlSubscriptionName)) {
      throw new Error(
        `sqlSubscriptionName "${sqlSubscriptionName}" is invalid. PostgreSQL replication slot/subscription names must match /^[a-z0-9_]+$/.`,
      );
    }
    const publicationDBName: string = args.publicationDBName ?? args.dbName;
    const timeoutMs: number = (args.timeoutSec ?? 60) * 1000;

    // Step 1: ensure the upstream's -ca and -replication secrets are reachable in the local namespace.
    const sourceCaName = `${args.sourceCluster}-ca`;
    const sourceReplName = `${args.sourceCluster}-replication`;
    let caRef = { name: sourceCaName, key: 'ca.crt' };
    let replRef = { keyRef: { name: sourceReplName, key: 'tls.key' }, certRef: { name: sourceReplName, key: 'tls.crt' } };

    if (sourceNs !== args.namespace) {
      if (!args.allowSecretCopy) {
        throw new Error(
          `Cross-namespace subscription requires the upstream's TLS secrets in ${args.namespace}. Pass allowSecretCopy: true to copy "${sourceCaName}" and "${sourceReplName}" from ${sourceNs}.`,
        );
      }
      const copiedCaName = `copied-${sourceCaName}`;
      const copiedReplName = `copied-${sourceReplName}`;
      for (const [src, dest] of [
        [sourceCaName, copiedCaName],
        [sourceReplName, copiedReplName],
      ]) {
        const fromResp = await k8s.core.readNamespacedSecret({ namespace: sourceNs, name: src });
        const fromSecret: any = asObject(fromResp);
        const body: any = {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: dest, namespace: args.namespace },
          type: fromSecret.type,
          data: fromSecret.data,
        };
        try {
          await k8s.core.createNamespacedSecret({ namespace: args.namespace, body });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes('"code":409') && !msg.includes('AlreadyExists')) throw e;
          // Already exists — replace to keep contents in sync.
          await k8s.core.replaceNamespacedSecret({ namespace: args.namespace, name: dest, body });
        }
      }
      caRef = { name: copiedCaName, key: 'ca.crt' };
      replRef = {
        keyRef: { name: copiedReplName, key: 'tls.key' },
        certRef: { name: copiedReplName, key: 'tls.crt' },
      };
    }

    // Step 2: register the externalCluster on the local cluster (idempotent).
    const externalCluster = {
      name: externalClusterName,
      connectionParameters: {
        host: `${args.sourceCluster}-rw.${sourceNs}.svc`,
        user: 'streaming_replica',
        dbname: publicationDBName,
        sslmode: 'verify-full',
      },
      sslKey: replRef.keyRef,
      sslCert: replRef.certRef,
      sslRootCert: caRef,
    };
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: CLUSTER_PLURAL, name: args.localCluster },
      (cluster: any) => {
        cluster.spec.externalClusters ??= [];
        const idx = cluster.spec.externalClusters.findIndex((e: any) => e.name === externalClusterName);
        if (idx >= 0) cluster.spec.externalClusters[idx] = externalCluster;
        else cluster.spec.externalClusters.push(externalCluster);
      },
    );

    // Step 3: create the Subscription (or no-op if it already exists).
    const subBody: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Subscription',
      metadata: { name: subscriptionName, namespace: args.namespace },
      spec: {
        cluster: { name: args.localCluster },
        dbname: args.dbName,
        name: sqlSubscriptionName,
        externalClusterName,
        publicationName: args.publicationName,
        ...(publicationDBName && { publicationDBName }),
      },
    };
    try {
      await k8s.custom.createNamespacedCustomObject({
        group: CNPG_GROUP,
        version: CNPG_VERSION,
        namespace: args.namespace,
        plural: SUBSCRIPTION_PLURAL,
        body: subBody,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('"code":409') && !msg.includes('AlreadyExists')) throw e;
    }

    // Step 4: poll until applied=true (or timeout).
    const start = Date.now();
    let lastApplied: boolean | undefined;
    let lastMessage: string | undefined;
    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: SUBSCRIPTION_PLURAL,
          name: subscriptionName,
        });
        const sub: any = asObject(resp);
        lastApplied = sub.status?.applied;
        lastMessage = sub.status?.message;
        if (lastApplied === true) {
          return json(
            `Subscription ${args.namespace}/${subscriptionName} applied`,
            {
              externalClusterName,
              publicationName: args.publicationName,
              publicationDBName,
              dbName: args.dbName,
              applied: lastApplied,
              message: lastMessage,
            },
          );
        }
      } catch {
        /* fall through to retry */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(
      `Subscription ${args.namespace}/${subscriptionName} did not reach applied=true (last observed: applied=${lastApplied}${lastMessage ? `, message="${lastMessage}"` : ''})`,
    );
  },
};

export const replicationModule: ToolModule = { tools, handlers };

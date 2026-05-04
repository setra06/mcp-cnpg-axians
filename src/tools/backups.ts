import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  BACKUP_PLURAL,
  SCHEDULED_BACKUP_PLURAL,
  DEFAULT_CNPG_IMAGE_REPO,
  PROJECTION_SCHEMA_PROPERTIES,
  projectOrStrip,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { Buffer } from 'node:buffer';
import { asItems, asObject, mutateCustomObject } from '../k8s.js';
import { s3DeletePrefix } from '../s3.js';

const tools: Tool[] = [
  {
    name: 'create_backup',
    description: 'Trigger an on-demand backup. Cluster must have a backup target configured (barmanObjectStore or volumeSnapshot). If ifNotExists=true and a Backup with backupName already exists, return its current status instead of erroring.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        backupName: { type: 'string', description: 'Optional backup name (auto-generated if omitted; required when ifNotExists is true)' },
        method: {
          type: 'string',
          enum: ['barmanObjectStore', 'volumeSnapshot', 'plugin'],
          description: 'Backup method (default: barmanObjectStore)',
          default: 'barmanObjectStore',
        },
        ifNotExists: {
          type: 'boolean',
          default: false,
          description: 'If true, do not error when a Backup with backupName already exists; report its status instead.',
        },
      },
      required: ['clusterName', 'namespace'],
    },
  },
  {
    name: 'list_backups',
    description: 'List backups in a namespace, optionally filtered by cluster.',
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
    name: 'get_backup_details',
    description: 'Get the spec and status of a specific Backup. Returns the object stripped of metadata noise by default; pass `fields` to project or `raw: true` for the full object.',
    inputSchema: {
      type: 'object',
      properties: {
        backupName: { type: 'string' },
        namespace: { type: 'string' },
        ...PROJECTION_SCHEMA_PROPERTIES,
      },
      required: ['backupName', 'namespace'],
    },
  },
  {
    name: 'get_backup_status',
    description: 'Get a concise status snapshot of a specific backup (phase, started/stopped, error). For all backups, use list_backups.',
    inputSchema: {
      type: 'object',
      properties: {
        backupName: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['backupName', 'namespace'],
    },
  },
  {
    name: 'delete_backup',
    description: 'Delete a Backup resource. Storage objects are deleted or retained based on the cluster reclaim policy.',
    inputSchema: {
      type: 'object',
      properties: {
        backupName: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['backupName', 'namespace'],
    },
  },
  {
    name: 'restore_cluster',
    description: 'Create a new cluster bootstrapped from a backup (point-in-time recovery if recoveryTarget is provided). For PostgreSQL major-version compatibility, pass postgresMajor or imageName matching the backup source — otherwise the operator-default image is used and may not match.',
    inputSchema: {
      type: 'object',
      properties: {
        newClusterName: { type: 'string' },
        namespace: { type: 'string' },
        backupName: { type: 'string' },
        instances: { type: 'number', default: 3 },
        storageSize: { type: 'string', default: '1Gi' },
        storageClass: { type: 'string' },
        postgresMajor: {
          type: 'number',
          description: 'Major version for the restored cluster image. Should match the backup source major.',
        },
        imageName: {
          type: 'string',
          description: 'Full container image override.',
        },
        recoveryTarget: {
          type: 'object',
          description: 'Optional PITR target, e.g. {"targetTime": "2026-01-01T12:00:00Z"} or {"targetLSN": "0/1A2B3C4"}',
        },
      },
      required: ['newClusterName', 'namespace', 'backupName'],
    },
  },
  {
    name: 'create_scheduled_backup',
    description: 'Create a ScheduledBackup with a cron schedule and optional retention.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        clusterName: { type: 'string' },
        schedule: { type: 'string', description: 'Cron with seconds, e.g. "0 0 2 * * *"' },
        backupRetentionPolicy: { type: 'string', description: 'e.g. "30d", "12w"' },
        suspend: { type: 'boolean', default: false },
        method: {
          type: 'string',
          enum: ['barmanObjectStore', 'volumeSnapshot', 'plugin'],
          default: 'barmanObjectStore',
        },
      },
      required: ['name', 'namespace', 'clusterName', 'schedule'],
    },
  },
  {
    name: 'list_scheduled_backups',
    description: 'List ScheduledBackup configs in a namespace.',
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
    name: 'delete_scheduled_backup',
    description: 'Delete a ScheduledBackup configuration.',
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
    name: 'configure_object_store',
    description: 'Configure barmanObjectStore for backups on a cluster (S3-compatible). By default replaces any existing config. Set replace=false to skip the write when a config already targets the same destinationPath.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        destinationPath: { type: 'string', description: 'e.g. s3://my-bucket/cluster-name' },
        endpointURL: { type: 'string', description: 'Optional S3-compatible endpoint URL' },
        s3CredentialsSecret: {
          type: 'object',
          description: 'Existing Secret with keys for access/secret. Format: {"accessKeyIdKey": "ACCESS_KEY_ID", "secretAccessKeyKey": "SECRET_ACCESS_KEY", "name": "secret-name"}',
        },
        wal: {
          type: 'object',
          description: 'Optional WAL settings, e.g. {"compression": "gzip", "maxParallel": 8}',
        },
        retentionPolicy: { type: 'string', description: 'e.g. "30d"' },
        replace: {
          type: 'boolean',
          default: true,
          description: 'If false and the cluster already has a barmanObjectStore with the same destinationPath, return OK without rewriting.',
        },
      },
      required: ['clusterName', 'namespace', 'destinationPath'],
    },
  },
  {
    name: 'wipe_object_store_path',
    description: 'Delete every object under the cluster\'s barmanObjectStore destination path on the configured S3 endpoint. Foot-gun protected: pass the same destinationPath as confirm. Used as a clean-slate aid for tests / lab runs. Reads S3 credentials from the cluster\'s configured s3Credentials secret.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        confirm: {
          type: 'string',
          description: 'Must match the cluster\'s spec.backup.barmanObjectStore.destinationPath exactly. Prevents accidental wipes.',
        },
      },
      required: ['clusterName', 'namespace', 'confirm'],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async create_backup(args, k8s) {
    const name = args.backupName || `${args.clusterName}-${Date.now()}`;
    if (args.ifNotExists && !args.backupName) {
      throw new Error('ifNotExists=true requires an explicit backupName so the lookup is deterministic');
    }
    if (args.ifNotExists) {
      try {
        const existing = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: BACKUP_PLURAL,
          name,
        });
        const b: any = asObject(existing);
        return json(`Backup ${args.namespace}/${name} already exists (ifNotExists=true)`, {
          phase: b.status?.phase,
          cluster: b.spec?.cluster?.name,
          backupId: b.status?.backupId,
          startedAt: b.status?.startedAt,
          stoppedAt: b.status?.stoppedAt,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Not-found: fall through and create.
        if (!msg.includes('"code":404') && !/NotFound/.test(msg)) throw e;
      }
    }
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Backup',
      metadata: { name, namespace: args.namespace },
      spec: {
        cluster: { name: args.clusterName },
        ...(args.method && { method: args.method }),
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
      body,
    });
    return ok(`Backup ${args.namespace}/${name} requested for cluster ${args.clusterName}`);
  },

  async list_backups(args, k8s) {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
    });
    let items = asItems(resp);
    if (args.clusterName) {
      items = items.filter((b: any) => b.spec?.cluster?.name === args.clusterName);
    }
    const summary = items.map((b: any) => ({
      name: b.metadata?.name,
      cluster: b.spec?.cluster?.name,
      phase: b.status?.phase,
      method: b.spec?.method ?? 'barmanObjectStore',
      startedAt: b.status?.startedAt,
      stoppedAt: b.status?.stoppedAt,
      backupId: b.status?.backupId,
    }));
    return json(`Found ${items.length} backups`, summary);
  },

  async get_backup_details(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
      name: args.backupName,
    });
    const projected = projectOrStrip(asObject(resp), { fields: args.fields, raw: args.raw });
    return json(`## Backup ${args.namespace}/${args.backupName}`, projected);
  },

  async get_backup_status(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
      name: args.backupName,
    });
    const b: any = asObject(resp);
    return json(`Backup status ${args.namespace}/${args.backupName}`, {
      phase: b.status?.phase,
      cluster: b.spec?.cluster?.name,
      method: b.spec?.method,
      startedAt: b.status?.startedAt,
      stoppedAt: b.status?.stoppedAt,
      backupId: b.status?.backupId,
      error: b.status?.error,
    });
  },

  async delete_backup(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
      name: args.backupName,
    });
    return ok(`Deleted backup ${args.namespace}/${args.backupName}`);
  },

  async restore_cluster(args, k8s) {
    await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: BACKUP_PLURAL,
      name: args.backupName,
    });
    const image: string | undefined =
      args.imageName ?? (args.postgresMajor ? `${DEFAULT_CNPG_IMAGE_REPO}:${args.postgresMajor}` : undefined);
    const cluster: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: { name: args.newClusterName, namespace: args.namespace },
      spec: {
        instances: args.instances ?? 3,
        ...(image && { imageName: image }),
        bootstrap: {
          recovery: {
            backup: { name: args.backupName },
            ...(args.recoveryTarget && { recoveryTarget: args.recoveryTarget }),
          },
        },
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
      `Restoring cluster ${args.namespace}/${args.newClusterName} from backup ${args.backupName}` +
        (image ? ` (image=${image})` : ' (image=operator-default — ensure it matches the backup source major)') +
        (args.recoveryTarget ? ` (PITR target: ${JSON.stringify(args.recoveryTarget)})` : ''),
    );
  },

  async create_scheduled_backup(args, k8s) {
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'ScheduledBackup',
      metadata: { name: args.name, namespace: args.namespace },
      spec: {
        schedule: args.schedule,
        backupOwnerReference: 'self',
        cluster: { name: args.clusterName },
        suspend: args.suspend ?? false,
        ...(args.method && { method: args.method }),
        ...(args.backupRetentionPolicy && { retentionPolicy: args.backupRetentionPolicy }),
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: SCHEDULED_BACKUP_PLURAL,
      body,
    });
    return ok(`Scheduled backup ${args.namespace}/${args.name} → ${args.clusterName} (cron: ${args.schedule})`);
  },

  async list_scheduled_backups(args, k8s) {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: SCHEDULED_BACKUP_PLURAL,
    });
    let items = asItems(resp);
    if (args.clusterName) {
      items = items.filter((s: any) => s.spec?.cluster?.name === args.clusterName);
    }
    const summary = items.map((s: any) => ({
      name: s.metadata?.name,
      cluster: s.spec?.cluster?.name,
      schedule: s.spec?.schedule,
      suspended: s.spec?.suspend ?? false,
      method: s.spec?.method ?? 'barmanObjectStore',
      retentionPolicy: s.spec?.retentionPolicy,
      lastScheduledTime: s.status?.lastScheduledTime,
    }));
    return json(`Found ${items.length} scheduled backups`, summary);
  },

  async delete_scheduled_backup(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: SCHEDULED_BACKUP_PLURAL,
      name: args.name,
    });
    return ok(`Deleted scheduled backup ${args.namespace}/${args.name}`);
  },

  async configure_object_store(args, k8s) {
    const shouldReplace = args.replace !== false; // default true
    if (!shouldReplace) {
      // Read first; if a barmanObjectStore already targets the same path, skip the write.
      try {
        const resp = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: CLUSTER_PLURAL,
          name: args.clusterName,
        });
        const cluster: any = asObject(resp);
        const existing = cluster.spec?.backup?.barmanObjectStore?.destinationPath;
        if (existing === args.destinationPath) {
          return ok(
            `barmanObjectStore on ${args.namespace}/${args.clusterName} already targets ${args.destinationPath}; skipped (replace=false).`,
          );
        }
      } catch (e) {
        // Fall through to write attempt; if cluster doesn't exist the write will surface a clearer error.
      }
    }
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: CLUSTER_PLURAL, name: args.clusterName },
      (cluster: any) => {
        const barman: any = {
          destinationPath: args.destinationPath,
          ...(args.endpointURL && { endpointURL: args.endpointURL }),
          ...(args.wal && { wal: args.wal }),
          ...(args.s3CredentialsSecret && {
            s3Credentials: {
              accessKeyId: {
                name: args.s3CredentialsSecret.name,
                key: args.s3CredentialsSecret.accessKeyIdKey,
              },
              secretAccessKey: {
                name: args.s3CredentialsSecret.name,
                key: args.s3CredentialsSecret.secretAccessKeyKey,
              },
            },
          }),
        };
        cluster.spec.backup = {
          barmanObjectStore: barman,
          ...(args.retentionPolicy && { retentionPolicy: args.retentionPolicy }),
        };
      },
    );
    return ok(`Configured barmanObjectStore on ${args.namespace}/${args.clusterName} → ${args.destinationPath}`);
  },

  async wipe_object_store_path(args, k8s) {
    // Look up the cluster's existing barman config and S3 credentials.
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: CLUSTER_PLURAL,
      name: args.clusterName,
    });
    const cluster: any = asObject(resp);
    const barman = cluster.spec?.backup?.barmanObjectStore;
    if (!barman) {
      throw new Error(
        `Cluster ${args.namespace}/${args.clusterName} has no spec.backup.barmanObjectStore. Configure one first.`,
      );
    }
    const destinationPath: string = barman.destinationPath;
    if (args.confirm !== destinationPath) {
      throw new Error(
        `confirm must match the cluster's destinationPath exactly. Expected "${destinationPath}", got "${args.confirm}".`,
      );
    }
    const endpointURL: string | undefined = barman.endpointURL;
    if (!endpointURL) {
      throw new Error(
        'wipe_object_store_path currently only supports clusters with an explicit endpointURL (S3-compatible).',
      );
    }
    const s3Creds = barman.s3Credentials;
    if (!s3Creds?.accessKeyId?.name) {
      throw new Error('wipe_object_store_path requires the cluster to use a Secret-backed s3Credentials.');
    }

    // Read access keys out of the K8s Secret.
    const secretResp = await k8s.core.readNamespacedSecret({
      namespace: args.namespace,
      name: s3Creds.accessKeyId.name,
    });
    const secret: any = asObject(secretResp);
    const decode = (b64: string | undefined) => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
    const accessKey = decode(secret.data?.[s3Creds.accessKeyId.key]);
    const secretKey = decode(secret.data?.[s3Creds.secretAccessKey.key]);
    if (!accessKey || !secretKey) {
      throw new Error(
        `Secret ${args.namespace}/${s3Creds.accessKeyId.name} is missing keys ${s3Creds.accessKeyId.key} / ${s3Creds.secretAccessKey.key}.`,
      );
    }

    const m = destinationPath.match(/^s3:\/\/([^/]+)(?:\/(.*))?$/);
    if (!m) throw new Error(`Unexpected destinationPath: ${destinationPath}. Expected s3://bucket[/prefix].`);
    const bucket = m[1];
    const prefix = m[2] ?? '';

    const deleted = await s3DeletePrefix({
      endpointURL,
      accessKey,
      secretKey,
      bucket,
      prefix,
    });
    return ok(
      `wipe_object_store_path deleted ${deleted} object(s) under ${destinationPath} via ${endpointURL}.`,
    );
  },
};

export const backupsModule: ToolModule = { tools, handlers };

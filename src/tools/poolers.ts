import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  POOLER_PLURAL,
  PROJECTION_SCHEMA_PROPERTIES,
  projectOrStrip,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asItems, asObject } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'list_poolers',
    description: 'List PgBouncer Pooler resources.',
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
    name: 'get_pooler',
    description: 'Get a specific Pooler resource. Stripped of metadata noise by default; use `fields` to project or `raw: true` for the full object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        ...PROJECTION_SCHEMA_PROPERTIES,
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'create_pooler',
    description: 'Deploy a PgBouncer Pooler in front of a cluster.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        clusterName: { type: 'string' },
        instances: { type: 'number', default: 1 },
        type: { type: 'string', enum: ['rw', 'ro'], default: 'rw', description: 'Whether the pooler points at the rw or ro service' },
        poolMode: { type: 'string', enum: ['session', 'transaction', 'statement'], default: 'transaction' },
        maxClientConn: { type: 'number', default: 1000, description: 'PgBouncer max_client_conn' },
        defaultPoolSize: { type: 'number', default: 20 },
        pgbouncerParameters: { type: 'object', description: 'Additional PgBouncer parameters as a string→string map' },
      },
      required: ['name', 'namespace', 'clusterName'],
    },
  },
  {
    name: 'delete_pooler',
    description: 'Delete a Pooler resource.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
      },
      required: ['name', 'namespace'],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async list_poolers(args, k8s) {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: POOLER_PLURAL,
    });
    let items = asItems(resp);
    if (args.clusterName) {
      items = items.filter((p: any) => p.spec?.cluster?.name === args.clusterName);
    }
    const summary = items.map((p: any) => ({
      name: p.metadata?.name,
      cluster: p.spec?.cluster?.name,
      type: p.spec?.type,
      instances: p.spec?.instances,
      poolMode: p.spec?.pgbouncer?.poolMode,
      readyInstances: p.status?.instances,
    }));
    return json(`Found ${items.length} Poolers`, summary);
  },

  async get_pooler(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: POOLER_PLURAL,
      name: args.name,
    });
    const projected = projectOrStrip(asObject(resp), { fields: args.fields, raw: args.raw });
    return json(`## Pooler ${args.namespace}/${args.name}`, projected);
  },

  async create_pooler(args, k8s) {
    const params: Record<string, string> = {
      max_client_conn: String(args.maxClientConn ?? 1000),
      default_pool_size: String(args.defaultPoolSize ?? 20),
      ...(args.pgbouncerParameters ?? {}),
    };
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Pooler',
      metadata: { name: args.name, namespace: args.namespace },
      spec: {
        cluster: { name: args.clusterName },
        instances: args.instances ?? 1,
        type: args.type ?? 'rw',
        pgbouncer: {
          poolMode: args.poolMode ?? 'transaction',
          parameters: params,
        },
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: POOLER_PLURAL,
      body,
    });
    return ok(`Pooler ${args.namespace}/${args.name} created (${args.type ?? 'rw'}, ${args.poolMode ?? 'transaction'})`);
  },

  async delete_pooler(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: POOLER_PLURAL,
      name: args.name,
    });
    return ok(`Deleted Pooler ${args.namespace}/${args.name}`);
  },
};

export const poolersModule: ToolModule = { tools, handlers };

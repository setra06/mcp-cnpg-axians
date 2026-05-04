import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  DATABASE_PLURAL,
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
    name: 'list_databases',
    description: 'List Database resources (CNPG declarative DB management). Available since CNPG 1.24+.',
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
    name: 'get_database',
    description: 'Get the spec and status of a specific Database resource. Returns the object stripped of metadata noise by default. Pass `fields: [...]` to project, or `raw: true` to disable stripping.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the Database resource' },
        namespace: { type: 'string' },
        ...PROJECTION_SCHEMA_PROPERTIES,
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'create_database',
    description: 'Declaratively create a PostgreSQL database via the Database CRD. Replaces the old create_database_declarative tool, which was a no-op on existing clusters. Owner is required by the CRD.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the Database resource (and the SQL database name unless overridden via dbName)' },
        namespace: { type: 'string' },
        clusterName: { type: 'string' },
        dbName: { type: 'string', description: 'Override SQL database name (defaults to "name")' },
        owner: { type: 'string', description: 'Database owner role (must exist on cluster)' },
        encoding: { type: 'string', default: 'UTF8' },
        locale: { type: 'string' },
        template: { type: 'string', description: 'Template database (default: template1)' },
        isTemplate: { type: 'boolean' },
        allowConnections: { type: 'boolean' },
        connectionLimit: { type: 'number' },
        databaseReclaimPolicy: { type: 'string', enum: ['delete', 'retain'], default: 'retain' },
      },
      required: ['name', 'namespace', 'clusterName', 'owner'],
    },
  },
  {
    name: 'delete_database',
    description: 'Delete a Database resource. The underlying SQL database is dropped or kept based on databaseReclaimPolicy.',
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
    name: 'manage_extensions',
    description: 'Add or remove PostgreSQL extensions on an existing Database resource (CNPG 1.24+ Database CRD). Replaces the old extensions tool which was a no-op on existing clusters.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseName: { type: 'string', description: 'Name of the Database resource' },
        namespace: { type: 'string' },
        extensions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              ensure: { type: 'string', enum: ['present', 'absent'], default: 'present' },
              version: { type: 'string' },
              schema: { type: 'string' },
            },
            required: ['name'],
          },
          description: 'List of extensions to install (ensure=present) or remove (ensure=absent)',
        },
      },
      required: ['databaseName', 'namespace', 'extensions'],
    },
  },
  {
    name: 'manage_schemas',
    description: 'Add or remove schemas on an existing Database resource.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseName: { type: 'string' },
        namespace: { type: 'string' },
        schemas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              ensure: { type: 'string', enum: ['present', 'absent'], default: 'present' },
              owner: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
      required: ['databaseName', 'namespace', 'schemas'],
    },
  },
];

const handlers: Record<string, ToolHandler> = {
  async list_databases(args, k8s) {
    const resp = await k8s.custom.listNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: DATABASE_PLURAL,
    });
    let items = asItems(resp);
    if (args.clusterName) {
      items = items.filter((d: any) => d.spec?.cluster?.name === args.clusterName);
    }
    const summary = items.map((d: any) => ({
      name: d.metadata?.name,
      cluster: d.spec?.cluster?.name,
      dbName: d.spec?.name,
      owner: d.spec?.owner,
      encoding: d.spec?.encoding,
      ensure: d.spec?.ensure ?? 'present',
      extensions: (d.spec?.extensions ?? []).map((e: any) => `${e.name}${e.version ? '@' + e.version : ''}`),
      schemas: (d.spec?.schemas ?? []).map((s: any) => s.name),
      applied: d.status?.applied,
      message: d.status?.message,
    }));
    return json(`Found ${items.length} Database resources`, summary);
  },

  async get_database(args, k8s) {
    const resp = await k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: DATABASE_PLURAL,
      name: args.name,
    });
    const projected = projectOrStrip(asObject(resp), { fields: args.fields, raw: args.raw });
    return json(`## Database ${args.namespace}/${args.name}`, projected);
  },

  async create_database(args, k8s) {
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Database',
      metadata: { name: args.name, namespace: args.namespace },
      spec: {
        cluster: { name: args.clusterName },
        name: args.dbName ?? args.name,
        owner: args.owner,
        ...(args.encoding && { encoding: args.encoding }),
        ...(args.locale && { locale: args.locale }),
        ...(args.template && { template: args.template }),
        ...(args.isTemplate !== undefined && { isTemplate: args.isTemplate }),
        ...(args.allowConnections !== undefined && { allowConnections: args.allowConnections }),
        ...(args.connectionLimit !== undefined && { connectionLimit: args.connectionLimit }),
        databaseReclaimPolicy: args.databaseReclaimPolicy ?? 'retain',
      },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: DATABASE_PLURAL,
      body,
    });
    return ok(
      `Created Database ${args.namespace}/${args.name} (db=${args.dbName ?? args.name}, owner=${args.owner}, cluster=${args.clusterName})`,
    );
  },

  async delete_database(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: DATABASE_PLURAL,
      name: args.name,
    });
    return ok(`Deleted Database ${args.namespace}/${args.name}`);
  },

  async manage_extensions(args, k8s) {
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: DATABASE_PLURAL, name: args.databaseName },
      (db: any) => {
        const existing: any[] = db.spec.extensions ?? [];
        const map = new Map(existing.map((e: any) => [e.name, e]));
        for (const ext of args.extensions) {
          map.set(ext.name, { ...map.get(ext.name), ...ext, ensure: ext.ensure ?? 'present' });
        }
        db.spec.extensions = Array.from(map.values());
      },
    );
    const summary = args.extensions.map((e: any) => `${e.ensure ?? 'present'}:${e.name}`).join(', ');
    return ok(`Updated extensions on Database ${args.namespace}/${args.databaseName}: ${summary}`);
  },

  async manage_schemas(args, k8s) {
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: DATABASE_PLURAL, name: args.databaseName },
      (db: any) => {
        const existing: any[] = db.spec.schemas ?? [];
        const map = new Map(existing.map((s: any) => [s.name, s]));
        for (const sc of args.schemas) {
          map.set(sc.name, { ...map.get(sc.name), ...sc, ensure: sc.ensure ?? 'present' });
        }
        db.spec.schemas = Array.from(map.values());
      },
    );
    const summary = args.schemas.map((s: any) => `${s.ensure ?? 'present'}:${s.name}`).join(', ');
    return ok(`Updated schemas on Database ${args.namespace}/${args.databaseName}: ${summary}`);
  },
};

export const databasesModule: ToolModule = { tools, handlers };

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  IMAGE_CATALOG_PLURAL,
  CLUSTER_IMAGE_CATALOG_PLURAL,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asItems, asObject, mutateCustomObject } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'list_image_catalogs',
    description: 'List ImageCatalog (namespaced) and ClusterImageCatalog (cluster-scoped) resources. CNPG 1.29+.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Optional: limit namespaced catalogs to one namespace' },
        scope: { type: 'string', enum: ['namespaced', 'cluster', 'both'], default: 'both' },
      },
    },
  },
  {
    name: 'create_image_catalog',
    description: 'Create a namespaced ImageCatalog mapping major versions to images.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              major: { type: 'number' },
              image: { type: 'string', description: 'Full image reference, e.g. ghcr.io/cloudnative-pg/postgresql:17.5-bookworm' },
            },
            required: ['major', 'image'],
          },
        },
      },
      required: ['name', 'namespace', 'images'],
    },
  },
  {
    name: 'use_image_catalog',
    description: 'Switch a cluster from imageName to an ImageCatalog reference. Requires postgresMajor on the catalog.',
    inputSchema: {
      type: 'object',
      properties: {
        clusterName: { type: 'string' },
        namespace: { type: 'string' },
        catalogName: { type: 'string' },
        catalogScope: { type: 'string', enum: ['ImageCatalog', 'ClusterImageCatalog'], default: 'ImageCatalog' },
        major: { type: 'number', description: 'PostgreSQL major version to pull from the catalog' },
      },
      required: ['clusterName', 'namespace', 'catalogName', 'major'],
    },
  },
  {
    name: 'delete_image_catalog',
    description: 'Delete a namespaced ImageCatalog.',
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
  async list_image_catalogs(args, k8s) {
    const scope = args.scope ?? 'both';
    const out: any = {};
    if (scope !== 'cluster') {
      const resp = args.namespace
        ? await k8s.custom.listNamespacedCustomObject({
            group: CNPG_GROUP,
            version: CNPG_VERSION,
            namespace: args.namespace,
            plural: IMAGE_CATALOG_PLURAL,
          })
        : await k8s.custom.listClusterCustomObject({
            group: CNPG_GROUP,
            version: CNPG_VERSION,
            plural: IMAGE_CATALOG_PLURAL,
          });
      out.namespaced = asItems(resp).map((c: any) => ({
        name: c.metadata?.name,
        namespace: c.metadata?.namespace,
        images: c.spec?.images,
      }));
    }
    if (scope !== 'namespaced') {
      const resp = await k8s.custom.listClusterCustomObject({
        group: CNPG_GROUP,
        version: CNPG_VERSION,
        plural: CLUSTER_IMAGE_CATALOG_PLURAL,
      });
      out.clusterScoped = asItems(resp).map((c: any) => ({
        name: c.metadata?.name,
        images: c.spec?.images,
      }));
    }
    return json('Image catalogs', out);
  },

  async create_image_catalog(args, k8s) {
    const body: any = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'ImageCatalog',
      metadata: { name: args.name, namespace: args.namespace },
      spec: { images: args.images },
    };
    await k8s.custom.createNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: IMAGE_CATALOG_PLURAL,
      body,
    });
    return ok(`ImageCatalog ${args.namespace}/${args.name} created (${args.images.length} entries)`);
  },

  async use_image_catalog(args, k8s) {
    await mutateCustomObject(
      k8s.custom,
      { group: CNPG_GROUP, version: CNPG_VERSION, namespace: args.namespace, plural: CLUSTER_PLURAL, name: args.clusterName },
      (cluster: any) => {
        delete cluster.spec.imageName;
        cluster.spec.imageCatalogRef = {
          apiGroup: CNPG_GROUP,
          kind: args.catalogScope ?? 'ImageCatalog',
          name: args.catalogName,
          major: args.major,
        };
      },
    );
    return ok(
      `Cluster ${args.namespace}/${args.clusterName} now references ${args.catalogScope ?? 'ImageCatalog'}/${args.catalogName} (major=${args.major}).`,
    );
  },

  async delete_image_catalog(args, k8s) {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CNPG_GROUP,
      version: CNPG_VERSION,
      namespace: args.namespace,
      plural: IMAGE_CATALOG_PLURAL,
      name: args.name,
    });
    return ok(`Deleted ImageCatalog ${args.namespace}/${args.name}`);
  },
};

export const imageCatalogsModule: ToolModule = { tools, handlers };

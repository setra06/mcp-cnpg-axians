import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

export const CNPG_GROUP = 'postgresql.cnpg.io';
export const CNPG_VERSION = 'v1';

export const CLUSTER_PLURAL = 'clusters';
export const BACKUP_PLURAL = 'backups';
export const SCHEDULED_BACKUP_PLURAL = 'scheduledbackups';
export const POOLER_PLURAL = 'poolers';
export const DATABASE_PLURAL = 'databases';
export const PUBLICATION_PLURAL = 'publications';
export const SUBSCRIPTION_PLURAL = 'subscriptions';
export const IMAGE_CATALOG_PLURAL = 'imagecatalogs';
export const CLUSTER_IMAGE_CATALOG_PLURAL = 'clusterimagecatalogs';

export const DEFAULT_CNPG_IMAGE_REPO = 'ghcr.io/cloudnative-pg/postgresql';

export interface K8sClients {
  core: CoreV1Api;
  custom: CustomObjectsApi;
  kc: KubeConfig;
}

export type ToolResult = {
  content: { type: 'text'; text: string }[];
};

export type ToolHandler = (args: any, k8s: K8sClients) => Promise<ToolResult>;

export interface ToolModule {
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function json<T>(label: string, value: T): ToolResult {
  return ok(`${label}\n\n${JSON.stringify(value, null, 2)}`);
}

/**
 * Tools whose name starts with one of these prefixes are considered mutating
 * and are excluded when the server is started in READ_ONLY mode.
 */
export const MUTATING_PREFIXES = [
  'create_',
  'delete_',
  'patch_',
  'set_',
  'manage_',
  'restart_',
  'reload_',
  'pause_',
  'resume_',
  'restore_',
  'scale_',
  'switchover_',
  'promote_',
  'upgrade_',
  'configure_',
  'use_',
] as const;

export function isMutating(toolName: string): boolean {
  return MUTATING_PREFIXES.some((p) => toolName.startsWith(p));
}

/**
 * Project an object to a set of dot-separated JSON paths.
 *
 *   project({a: 1, b: {c: 2, d: 3}}, ['a', 'b.c'])
 *     → {a: 1, b: {c: 2}}
 *
 * Missing paths are silently skipped (the result simply doesn't carry them).
 * Paths drilling into arrays project the same key out of every element.
 */
export function project(obj: unknown, paths: string[]): unknown {
  if (obj === null || obj === undefined) return obj;
  const out: any = {};
  for (const path of paths) {
    const segments = path.split('.');
    setProjectedPath(obj, segments, out);
  }
  return out;
}

function setProjectedPath(src: any, segments: string[], dest: any): void {
  if (segments.length === 0 || src === null || src === undefined) return;
  const [head, ...rest] = segments;
  if (Array.isArray(src)) {
    // Project the same path across each array element.
    const projected = src.map((el) => {
      const sub: any = {};
      setProjectedPath(el, segments, sub);
      return sub;
    });
    if (Array.isArray(dest._arr)) dest._arr.push(...projected);
    else if (dest.length !== undefined) dest.push(...projected);
    else Object.assign(dest, { ...projected });
    return;
  }
  if (rest.length === 0) {
    if (head in src) dest[head] = src[head];
    return;
  }
  if (head in src) {
    const child = src[head];
    if (Array.isArray(child)) {
      // Drill into each element with the remaining path.
      const projected = child.map((el) => {
        const sub: any = {};
        setProjectedPath(el, rest, sub);
        return sub;
      });
      dest[head] = projected;
    } else if (typeof child === 'object' && child !== null) {
      dest[head] ??= {};
      setProjectedPath(child, rest, dest[head]);
    } else {
      // Path was longer than the actual depth — nothing to project.
    }
  }
}

/**
 * Strip the noisy bits of metadata that are rarely useful to a calling agent.
 * Returns a shallow copy with managedFields, resourceVersion, uid, generation, finalizers,
 * and ownerReferences removed from metadata. The rest of the object is unchanged.
 */
export function stripMetadataNoise<T extends Record<string, any>>(obj: T): T {
  if (!obj || typeof obj !== 'object' || !obj.metadata) return obj;
  const md = { ...obj.metadata };
  delete md.managedFields;
  delete md.resourceVersion;
  delete md.uid;
  delete md.generation;
  delete md.finalizers;
  delete md.ownerReferences;
  delete md.selfLink;
  return { ...obj, metadata: md };
}

/**
 * Apply the standard projection convention to a full Kubernetes object before returning it
 * from a get_* tool:
 *
 *   - args.fields = ['a.b.c', 'spec.instances'] → project to those paths
 *   - args.raw = true                            → return as-is
 *   - default                                    → strip metadata noise (managedFields, etc.)
 *
 * The schema for fields/raw is identical across the get_* tools — see PROJECTION_SCHEMA below.
 */
export function projectOrStrip<T>(obj: T, args: { fields?: string[]; raw?: boolean }): unknown {
  if (Array.isArray(args.fields) && args.fields.length > 0) {
    return project(obj, args.fields);
  }
  if (args.raw === true) return obj;
  return stripMetadataNoise(obj as any);
}

/** JSON-schema fragment to merge into get_* tool inputSchemas. */
export const PROJECTION_SCHEMA_PROPERTIES = {
  fields: {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional projection: dot-separated JSON paths to keep (e.g. ["spec.instances", "status.currentPrimary"]). When omitted, the full object minus metadata noise is returned.',
  },
  raw: {
    type: 'boolean',
    default: false,
    description: 'If true, return the full Kubernetes object including metadata.managedFields and other low-value fields. Default false.',
  },
} as const;

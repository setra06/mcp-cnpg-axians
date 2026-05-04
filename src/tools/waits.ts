import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  CNPG_GROUP,
  CNPG_VERSION,
  CLUSTER_PLURAL,
  BACKUP_PLURAL,
  DATABASE_PLURAL,
  POOLER_PLURAL,
  type ToolHandler,
  type ToolModule,
  ok,
  json,
} from '../types.js';
import { asObject } from '../k8s.js';

const tools: Tool[] = [
  {
    name: 'wait_for_cluster',
    description: 'Server-side poll until a cluster matches the requested condition. By default waits for phase="Cluster in healthy state". Pass readyInstances to wait until at least N instances are ready (useful after scaling). Both can be combined.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        phase: {
          type: 'string',
          description: 'Target phase. Defaults to "Cluster in healthy state" unless readyInstances is given alone.',
        },
        readyInstances: {
          type: 'number',
          description: 'Wait until status.readyInstances >= this value.',
        },
        timeoutSec: { type: 'number', default: 300 },
        intervalSec: { type: 'number', default: 3 },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'wait_for_backup',
    description: 'Server-side poll until a Backup CR reaches the requested phase (default: "completed"). Other valid phases: "running", "failed".',
    inputSchema: {
      type: 'object',
      properties: {
        backupName: { type: 'string' },
        namespace: { type: 'string' },
        phase: { type: 'string', default: 'completed' },
        timeoutSec: { type: 'number', default: 600 },
        intervalSec: { type: 'number', default: 3 },
      },
      required: ['backupName', 'namespace'],
    },
  },
  {
    name: 'wait_for_database',
    description: 'Server-side poll until a Database CR has status.applied = true (or false if "applied" is set to false explicitly).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        applied: { type: 'boolean', default: true },
        timeoutSec: { type: 'number', default: 120 },
        intervalSec: { type: 'number', default: 2 },
      },
      required: ['name', 'namespace'],
    },
  },
  {
    name: 'wait_for_pooler',
    description: 'Server-side poll until a Pooler has at least the requested number of ready instances (default: 1).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        namespace: { type: 'string' },
        readyInstances: { type: 'number', default: 1 },
        timeoutSec: { type: 'number', default: 120 },
        intervalSec: { type: 'number', default: 2 },
      },
      required: ['name', 'namespace'],
    },
  },
];

async function pollUntil<T>(
  poll: () => Promise<T | undefined>,
  describeFailure: () => string,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await poll();
      if (result !== undefined) return result;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const elapsed = Math.round((Date.now() - start) / 1000);
  const tail = lastError instanceof Error ? `; last error: ${lastError.message}` : '';
  throw new Error(`Timed out after ${elapsed}s: ${describeFailure()}${tail}`);
}

const handlers: Record<string, ToolHandler> = {
  async wait_for_cluster(args, k8s) {
    const targetPhase: string | undefined =
      args.phase ?? (args.readyInstances === undefined ? 'Cluster in healthy state' : undefined);
    const targetReady: number | undefined = args.readyInstances;
    const timeoutMs = (args.timeoutSec ?? 300) * 1000;
    const intervalMs = (args.intervalSec ?? 3) * 1000;
    let lastSeenPhase: string | undefined;
    let lastSeenReady: number | undefined;

    const finalCluster = await pollUntil(
      async () => {
        const resp = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: CLUSTER_PLURAL,
          name: args.name,
        });
        const c: any = asObject(resp);
        lastSeenPhase = c.status?.phase;
        lastSeenReady = c.status?.readyInstances;
        const phaseOk = targetPhase === undefined || lastSeenPhase === targetPhase;
        const readyOk = targetReady === undefined || (lastSeenReady ?? 0) >= targetReady;
        if (phaseOk && readyOk) return c;
        return undefined;
      },
      () => {
        const wants: string[] = [];
        if (targetPhase !== undefined) wants.push(`phase="${targetPhase}"`);
        if (targetReady !== undefined) wants.push(`readyInstances>=${targetReady}`);
        const observed: string[] = [];
        observed.push(`phase="${lastSeenPhase ?? 'no status yet'}"`);
        if (lastSeenReady !== undefined) observed.push(`readyInstances=${lastSeenReady}`);
        return `cluster ${args.namespace}/${args.name} did not reach ${wants.join(' AND ')} (last observed: ${observed.join(', ')})`;
      },
      timeoutMs,
      intervalMs,
    );
    const conditions: string[] = [];
    if (targetPhase !== undefined) conditions.push(`phase="${targetPhase}"`);
    if (targetReady !== undefined) conditions.push(`readyInstances>=${targetReady}`);
    return json(`Cluster ${args.namespace}/${args.name} reached ${conditions.join(' AND ')}`, {
      phase: finalCluster.status?.phase,
      readyInstances: finalCluster.status?.readyInstances,
      currentPrimary: finalCluster.status?.currentPrimary,
      conditions: finalCluster.status?.conditions,
    });
  },

  async wait_for_backup(args, k8s) {
    const targetPhase: string = args.phase ?? 'completed';
    const timeoutMs = (args.timeoutSec ?? 600) * 1000;
    const intervalMs = (args.intervalSec ?? 3) * 1000;
    let lastSeenPhase: string | undefined;
    let lastError: string | undefined;

    const finalBackup = await pollUntil(
      async () => {
        const resp = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: BACKUP_PLURAL,
          name: args.backupName,
        });
        const b: any = asObject(resp);
        lastSeenPhase = b.status?.phase;
        lastError = b.status?.error;
        if (lastSeenPhase === targetPhase) return b;
        if (lastSeenPhase === 'failed' && targetPhase !== 'failed') {
          throw new Error(`backup transitioned to "failed"${lastError ? `: ${lastError}` : ''}`);
        }
        return undefined;
      },
      () => `backup ${args.namespace}/${args.backupName} did not reach phase="${targetPhase}" (last observed: "${lastSeenPhase ?? 'no status yet'}")`,
      timeoutMs,
      intervalMs,
    );
    return json(`Backup ${args.namespace}/${args.backupName} reached phase="${targetPhase}"`, {
      phase: finalBackup.status?.phase,
      cluster: finalBackup.spec?.cluster?.name,
      backupId: finalBackup.status?.backupId,
      startedAt: finalBackup.status?.startedAt,
      stoppedAt: finalBackup.status?.stoppedAt,
    });
  },

  async wait_for_database(args, k8s) {
    const target: boolean = args.applied !== undefined ? args.applied : true;
    const timeoutMs = (args.timeoutSec ?? 120) * 1000;
    const intervalMs = (args.intervalSec ?? 2) * 1000;
    let lastSeenApplied: boolean | undefined;
    let lastSeenMessage: string | undefined;

    const finalDb = await pollUntil(
      async () => {
        const resp = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: DATABASE_PLURAL,
          name: args.name,
        });
        const d: any = asObject(resp);
        lastSeenApplied = d.status?.applied;
        lastSeenMessage = d.status?.message;
        if (lastSeenApplied === target) return d;
        return undefined;
      },
      () => `database ${args.namespace}/${args.name} did not reach applied=${target} (last observed: applied=${lastSeenApplied}${lastSeenMessage ? `, message="${lastSeenMessage}"` : ''})`,
      timeoutMs,
      intervalMs,
    );
    return json(`Database ${args.namespace}/${args.name} reached applied=${target}`, {
      applied: finalDb.status?.applied,
      message: finalDb.status?.message,
      observedGeneration: finalDb.status?.observedGeneration,
    });
  },

  async wait_for_pooler(args, k8s) {
    const targetReady: number = args.readyInstances ?? 1;
    const timeoutMs = (args.timeoutSec ?? 120) * 1000;
    const intervalMs = (args.intervalSec ?? 2) * 1000;
    let lastSeen: number | undefined;

    const finalPooler = await pollUntil(
      async () => {
        const resp = await k8s.custom.getNamespacedCustomObject({
          group: CNPG_GROUP,
          version: CNPG_VERSION,
          namespace: args.namespace,
          plural: POOLER_PLURAL,
          name: args.name,
        });
        const p: any = asObject(resp);
        lastSeen = p.status?.instances;
        if (typeof lastSeen === 'number' && lastSeen >= targetReady) return p;
        return undefined;
      },
      () => `pooler ${args.namespace}/${args.name} did not reach readyInstances >= ${targetReady} (last observed: ${lastSeen ?? 'no status yet'})`,
      timeoutMs,
      intervalMs,
    );
    return ok(`Pooler ${args.namespace}/${args.name} ready: ${finalPooler.status?.instances} instance(s)`);
  },
};

export const waitsModule: ToolModule = { tools, handlers };

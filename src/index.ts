#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { formatK8sError } from './k8s.js';
import { isMutating, ok } from './types.js';
import type { K8sClients, ToolHandler, ToolModule } from './types.js';
import { ContextRegistry } from './contexts.js';

import { clustersModule } from './tools/clusters.js';
import { backupsModule } from './tools/backups.js';
import { databasesModule } from './tools/databases.js';
import { replicationModule } from './tools/replication.js';
import { poolersModule } from './tools/poolers.js';
import { observabilityModule } from './tools/observability.js';
import { imageCatalogsModule } from './tools/image_catalogs.js';
import { waitsModule } from './tools/waits.js';
import { operationsModule } from './tools/operations.js';
import { buildMetaModule } from './tools/meta.js';

const SERVER_VERSION = '3.6.0';

const moduleList: ToolModule[] = [
  clustersModule,
  backupsModule,
  databasesModule,
  replicationModule,
  poolersModule,
  observabilityModule,
  imageCatalogsModule,
  waitsModule,
  operationsModule,
];

function aggregate(modules: ToolModule[]): { tools: Tool[]; handlers: Record<string, ToolHandler> } {
  const tools: Tool[] = [];
  const handlers: Record<string, ToolHandler> = {};
  for (const m of modules) {
    tools.push(...m.tools);
    for (const [name, h] of Object.entries(m.handlers)) {
      if (handlers[name]) {
        throw new Error(`Duplicate tool handler: ${name}`);
      }
      handlers[name] = h;
    }
  }
  const declaredNames = new Set(tools.map((t) => t.name));
  for (const name of Object.keys(handlers)) {
    if (!declaredNames.has(name)) {
      throw new Error(`Handler "${name}" has no matching tool declaration`);
    }
  }
  for (const t of tools) {
    if (!handlers[t.name]) {
      throw new Error(`Tool "${t.name}" has no handler`);
    }
  }
  return { tools, handlers };
}

/**
 * Augment a tool's input schema with an optional `context` property, so callers can target a
 * named cluster from K8S_CONTEXTS. Idempotent: leaves the tool alone if `context` is already there.
 */
function withContextProperty(tool: Tool): Tool {
  const props: any = (tool.inputSchema as any)?.properties ?? {};
  if (props.context) return tool;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...props,
        context: {
          type: 'string',
          description: 'Optional named context from K8S_CONTEXTS. Falls back to the default context when omitted.',
        },
      },
    },
  };
}

/**
 * Build the full server surface: aggregate all modules, optionally filter mutating tools, add the
 * meta module, and inject the optional `context` argument into every tool. Exposed as a function
 * so tests can call it without constructing the MCP server.
 */
export function buildServerSurface(opts: { readOnly: boolean; version: string; contexts?: ContextRegistry }): {
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
  excludedMutating: string[];
} {
  const aggregated = aggregate(moduleList);
  let tools: Tool[];
  let handlers: Record<string, ToolHandler>;
  let excludedMutating: string[];
  if (opts.readOnly) {
    excludedMutating = aggregated.tools.filter((t) => isMutating(t.name)).map((t) => t.name);
    tools = aggregated.tools.filter((t) => !isMutating(t.name));
    handlers = Object.fromEntries(
      Object.entries(aggregated.handlers).filter(([name]) => !isMutating(name)),
    );
  } else {
    excludedMutating = [];
    tools = [...aggregated.tools];
    handlers = { ...aggregated.handlers };
  }
  const meta = buildMetaModule({ version: opts.version, readOnly: opts.readOnly, excludedMutating });
  tools.push(...meta.tools);
  Object.assign(handlers, meta.handlers);

  // list_contexts tool — meta-level. Always exposed.
  if (opts.contexts) {
    const ctxList: Tool = {
      name: 'list_contexts',
      description: 'List configured Kubernetes contexts (from K8S_CONTEXTS) and which one is the default. Pass any returned name as the `context` argument on other tools.',
      inputSchema: { type: 'object', properties: {} },
    };
    tools.push(ctxList);
    const registry = opts.contexts;
    handlers.list_contexts = async () =>
      ok(
        JSON.stringify(
          {
            multiContext: registry.multiContext,
            default: registry.defaultContext(),
            contexts: registry.describe(),
          },
          null,
          2,
        ),
      );
  }

  // Inject `context` into every tool's input schema so it's discoverable.
  tools = tools.map(withContextProperty);
  return { tools, handlers, excludedMutating };
}

export const SERVER_NAME = 'cnpg-mcp-server';
export { SERVER_VERSION };

/**
 * Runtime shared by every transport: the tool surface, the readOnly flag, the
 * configured context registry. Built once at startup; the same instance is reused
 * for every stdio call or every HTTP session.
 */
export interface ServerRuntime {
  readOnly: boolean;
  contexts: ContextRegistry;
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
  excludedMutating: string[];
}

export function buildRuntime(): ServerRuntime {
  const readOnly = process.env.READ_ONLY === 'true';
  const contexts = ContextRegistry.fromEnv();
  const surface = buildServerSurface({ readOnly, version: SERVER_VERSION, contexts });
  return {
    readOnly,
    contexts,
    tools: surface.tools,
    handlers: surface.handlers,
    excludedMutating: surface.excludedMutating,
  };
}

/**
 * Build a fresh MCP `Server` instance wired against the shared runtime. Each HTTP
 * session creates its own Server (so per-session state stays isolated); stdio uses
 * a single one. The Server itself is stateless wrt the runtime — all state lives
 * on the transport.
 */
export function createMcpServer(runtime: ServerRuntime): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = runtime.handlers[name];
    if (!handler) {
      if (runtime.readOnly && runtime.excludedMutating.includes(name)) {
        return {
          content: [
            {
              type: 'text',
              text: `Tool "${name}" is a mutating operation and has been excluded by READ_ONLY mode. Set READ_ONLY=false to enable.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const ctxName: string | undefined = (args as any)?.context;
      const k8s: K8sClients = runtime.contexts.resolve(ctxName);
      const cleaned: Record<string, any> = { ...(args ?? {}) };
      delete cleaned.context;
      return await handler(cleaned, k8s);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${formatK8sError(error)}` }],
        isError: true,
      };
    }
  });
  return server;
}

function describeMode(runtime: ServerRuntime): string {
  const modeStr = runtime.readOnly
    ? `READ-ONLY (${runtime.excludedMutating.length} mutating tools excluded)`
    : 'full';
  const ctxStr = runtime.contexts.multiContext
    ? `multi-context [${runtime.contexts.contextNames().join(', ')}], default=${runtime.contexts.defaultContext()}`
    : `single-context (${runtime.contexts.defaultContext()})`;
  return `${runtime.tools.length} tools, mode=${modeStr}, ${ctxStr}`;
}

async function runStdio(runtime: ServerRuntime): Promise<void> {
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `CloudNativePG MCP server v${SERVER_VERSION} running on stdio (${describeMode(runtime)})`,
  );
}

async function runHttp(runtime: ServerRuntime): Promise<void> {
  // Dynamic import: avoids loading the HTTP transport (and the `node:http` cost) when
  // running in stdio mode, and sidesteps a circular import between index.ts and http.ts.
  const { startHttpServer } = await import('./http.js');
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  const port = Number(process.env.MCP_HTTP_PORT || '3000');
  const token = process.env.MCP_HTTP_TOKEN || undefined;
  const path = process.env.MCP_HTTP_PATH || '/mcp';
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT: ${process.env.MCP_HTTP_PORT}`);
  }
  await startHttpServer(runtime, { host, port, token, path });
  console.error(
    `CloudNativePG MCP server v${SERVER_VERSION} running on http://${host}:${port}${path} ` +
      `(${describeMode(runtime)}, auth=${token ? 'bearer' : 'none'})`,
  );
}

// Start the server only when this file is the entrypoint. Importing it from a test file
// (to reuse buildServerSurface) does not trigger the listener.
const isMainEntry = (() => {
  if (typeof process === 'undefined') return false;
  if (!process.argv[1]) return false;
  try {
    const mainUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === mainUrl;
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  const transportName = (process.env.TRANSPORT || 'stdio').toLowerCase();
  const runtime = buildRuntime();
  const runner =
    transportName === 'http'
      ? runHttp(runtime)
      : transportName === 'stdio'
        ? runStdio(runtime)
        : Promise.reject(new Error(`Unknown TRANSPORT=${process.env.TRANSPORT}. Use "stdio" or "http".`));
  runner.catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { type ToolHandler, type ToolModule, ok } from '../types.js';

/**
 * Server-level meta tools (mode, version, configured contexts, etc.).
 * The handlers here close over server-level state (read-only mode, version)
 * via the factory function `buildMetaModule(state)`.
 */
export interface MetaState {
  version: string;
  readOnly: boolean;
  excludedMutating: string[];
}

export function buildMetaModule(state: MetaState): ToolModule {
  const tools: Tool[] = [
    {
      name: 'get_server_mode',
      description: 'Report whether the MCP server is running in full or read-only mode, and list mutating tools that have been excluded.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  const handlers: Record<string, ToolHandler> = {
    async get_server_mode() {
      return ok(
        JSON.stringify(
          {
            mode: state.readOnly ? 'readonly' : 'full',
            version: state.version,
            mutatingExcluded: state.excludedMutating,
          },
          null,
          2,
        ),
      );
    },
  };
  return { tools, handlers };
}

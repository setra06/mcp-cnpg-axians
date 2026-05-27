import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createMcpServer, type ServerRuntime } from './index.js';

export interface HttpServerOptions {
  host: string;
  port: number;
  path: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function startHttpServer(runtime: ServerRuntime, opts: HttpServerOptions): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer((req, res) => {
    handleRequest(req, res, runtime, opts, transports).catch((err) => {
      console.error('Unhandled HTTP error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      } else {
        try { res.end(); } catch { /* socket already closed */ }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down HTTP server...`);
    for (const [sid, transport] of transports) {
      try {
        await transport.close();
      } catch {
        /* ignore — best effort */
      }
      transports.delete(sid);
    }
    httpServer.close(() => process.exit(0));
    // Force-exit if close hangs on lingering keep-alives.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: ServerRuntime,
  opts: HttpServerOptions,
  transports: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== opts.path) {
    writeJson(res, 404, { error: 'Not Found', expected: opts.path });
    return;
  }

  if (opts.token && !checkBearer(req, opts.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mcp-cnpg-axians"');
    writeJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const headerSid = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(headerSid) ? headerSid[0] : headerSid;

  if (req.method === 'POST') {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
        id: null,
      });
      return;
    }

    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          if (transport) transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) transports.delete(sid);
      };
      const mcpServer = createMcpServer(runtime);
      await mcpServer.connect(transport);
    } else {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: sessionId
            ? `Unknown session ID: ${sessionId}`
            : 'Bad Request: missing session ID and request is not an initialize call',
        },
        id: null,
      });
      return;
    }

    await transport!.handleRequest(req, res, body);
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!sessionId || !transports.has(sessionId)) {
      writeJson(res, 400, { error: 'Invalid or missing Mcp-Session-Id header' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
  writeJson(res, 405, { error: `Method ${req.method} not allowed` });
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    String(
      req.headers['access-control-request-headers'] ??
        'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    ),
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function checkBearer(req: IncomingMessage, expected: string): boolean {
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !header.startsWith('Bearer ')) return false;
  return timingSafeEqualStr(header.slice('Bearer '.length).trim(), expected);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Payload too large (> ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

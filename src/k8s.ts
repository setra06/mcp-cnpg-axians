import * as fs from 'node:fs';
import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { Writable, Readable } from 'node:stream';
import { KubeConfig, CoreV1Api, CustomObjectsApi, Exec } from '@kubernetes/client-node';
import type { K8sClients } from './types.js';

export interface KubeClientsAndConfig {
  clients: K8sClients;
  kc: KubeConfig;
}

/** Read CA cert material from K8S_CA_CERT (file path or base64-encoded PEM). */
function loadCaCertMaterial(): { caData?: string; caFile?: string } | undefined {
  const raw = process.env.K8S_CA_CERT;
  if (!raw) return undefined;
  if (fs.existsSync(raw)) return { caFile: raw };
  // base64 PEM (whole file as base64)
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('BEGIN CERTIFICATE')) return { caData: raw };
  } catch {
    /* fall through */
  }
  // Inline PEM (rare, but allow it)
  if (raw.includes('BEGIN CERTIFICATE')) {
    return { caData: Buffer.from(raw).toString('base64') };
  }
  throw new Error(
    `K8S_CA_CERT must be a path to a CA file, a base64-encoded PEM, or an inline PEM. Got: ${raw.slice(0, 40)}...`,
  );
}

/**
 * Build Kubernetes clients.
 *
 * Auth resolution:
 *   1. K8S_API_URL + K8S_TOKEN  → bearer-token cluster, optionally with K8S_CA_CERT.
 *   2. Otherwise                → default kubeconfig (~/.kube/config).
 *
 * TLS verification is **on by default**. Opt out only for self-signed lab clusters by setting
 * `K8S_SKIP_TLS_VERIFY=true`. Prefer pinning a CA via `K8S_CA_CERT` when possible.
 */
export function buildKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  if (process.env.K8S_API_URL && process.env.K8S_TOKEN) {
    const skipTLS = process.env.K8S_SKIP_TLS_VERIFY === 'true';
    const caMaterial = loadCaCertMaterial();
    if (skipTLS && caMaterial) {
      throw new Error(
        'K8S_SKIP_TLS_VERIFY=true and K8S_CA_CERT are mutually exclusive — pick one.',
      );
    }
    kc.loadFromOptions({
      clusters: [
        {
          name: 'mcp-cluster',
          server: process.env.K8S_API_URL,
          skipTLSVerify: skipTLS,
          ...(caMaterial ?? {}),
        },
      ],
      users: [{ name: 'mcp-user', token: process.env.K8S_TOKEN }],
      contexts: [{ name: 'mcp-context', cluster: 'mcp-cluster', user: 'mcp-user' }],
      currentContext: 'mcp-context',
    });
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

export function buildKubeClients(): K8sClients {
  return clientsFromKubeConfig(buildKubeConfig());
}

export function clientsFromKubeConfig(kc: KubeConfig): K8sClients {
  return {
    core: kc.makeApiClient(CoreV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    kc,
  };
}

export function asItems(response: any): any[] {
  return response?.items ?? response?.body?.items ?? [];
}

export function asObject(response: any): any {
  if (response?.metadata) return response;
  if (response?.body?.metadata) return response.body;
  return response;
}

/**
 * Read-modify-write a CustomObject with optimistic-concurrency retry on 409.
 * Use whenever you need to patch a resource that the operator may concurrently update.
 */
export async function mutateCustomObject(
  custom: any,
  args: { group: string; version: string; namespace: string; plural: string; name: string },
  mutate: (obj: any) => void,
  maxAttempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await custom.getNamespacedCustomObject({
        group: args.group,
        version: args.version,
        namespace: args.namespace,
        plural: args.plural,
        name: args.name,
      });
      const obj = asObject(resp);
      mutate(obj);
      await custom.replaceNamespacedCustomObject({
        group: args.group,
        version: args.version,
        namespace: args.namespace,
        plural: args.plural,
        name: args.name,
        body: obj,
      });
      return;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('"code":409') || msg.includes('Conflict')) {
        const backoff = 50 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Format a Kubernetes API error into a single human-readable line.
 *
 * The kubernetes-client-node error wraps the API server's `Status` object inside a JSON-stringified
 * `body` field. The useful text — the webhook message or admission failure cause — is buried two
 * levels deep. This helper extracts it and produces something like:
 *   "422 Invalid: spec.imageName: can't downgrade from major 18 to 17 (admission webhook 'vcluster.cnpg.io')"
 *
 * For non-API errors, falls back to `error.message` or `String(error)`.
 */
export function formatK8sError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  const anyErr: any = err;

  // Try to extract a Status object from common locations.
  const statusFromBody = (() => {
    const body = anyErr.body ?? anyErr.response?.body ?? anyErr.response?.data;
    if (!body) return undefined;
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return undefined;
      }
    }
    if (typeof body === 'object') return body;
    return undefined;
  })();

  // The client also sometimes embeds the JSON inside the `message` field, surrounded by the
  // textual "Body:" prefix. Try that too as a last resort.
  const statusFromMessage = (() => {
    const msg: string | undefined = typeof anyErr.message === 'string' ? anyErr.message : undefined;
    if (!msg) return undefined;
    const match = msg.match(/Body:\s*"((?:\\.|[^"\\])*)"/);
    if (!match) return undefined;
    try {
      return JSON.parse(JSON.parse(`"${match[1]}"`));
    } catch {
      return undefined;
    }
  })();

  const status = statusFromBody ?? statusFromMessage;
  if (status && status.kind === 'Status') {
    const code: number | undefined = status.code ?? anyErr.statusCode ?? anyErr.response?.statusCode;
    const reason: string | undefined = status.reason;
    const message: string | undefined = status.message;
    const causes: any[] = status.details?.causes ?? [];
    const causeText = causes
      .map((c: any) => [c.field, c.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
    return [
      code ? `${code}` : undefined,
      reason,
      message,
      causeText && causeText !== message ? `(${causeText})` : undefined,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (typeof anyErr.message === 'string') {
    // Strip the verbose "HTTP-Code: ... Body: ... Headers: ..." pattern when no Status was parseable.
    const simple = anyErr.message.replace(/\bHeaders:\s*\{[\s\S]*$/, '').trim();
    if (simple) return simple;
  }
  return String(err);
}

/**
 * GET a path on a pod via the K8s API server's pods/proxy subresource.
 * Returns the response body as a string. Used to scrape Prometheus exporters.
 *
 * Uses Node's https.request with the auth/TLS options resolved by KubeConfig (ca/cert/key/token),
 * because Node's global fetch can't be configured with per-request CA bundles or client certs.
 */
export async function podProxyGet(
  kc: KubeConfig,
  args: { namespace: string; podName: string; port: number; path: string; timeoutMs?: number },
): Promise<string> {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No current cluster in KubeConfig');
  const baseUrl = cluster.server.replace(/\/$/, '');
  const path = args.path.startsWith('/') ? args.path : `/${args.path}`;
  const url = new URL(
    `${baseUrl}/api/v1/namespaces/${args.namespace}/pods/${args.podName}:${args.port}/proxy${path}`,
  );

  const tlsOpts: any = {};
  await kc.applyToHTTPSOptions(tlsOpts);

  const headers: Record<string, string> = {
    Accept: 'text/plain, */*',
    ...(tlsOpts.headers ?? {}),
  };
  // Some auth providers attach a bearer token via headers; others use client certs (k3s default).
  // applyToHTTPSOptions handles both transparently.

  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const reqOpts: https.RequestOptions = {
    method: 'GET',
    host: url.hostname,
    port: url.port ? Number(url.port) : isHttps ? 443 : 80,
    path: url.pathname + url.search,
    headers,
    timeout: args.timeoutMs ?? 10_000,
    ca: tlsOpts.ca,
    cert: tlsOpts.cert,
    key: tlsOpts.key,
    rejectUnauthorized: cluster.skipTLSVerify === true ? false : tlsOpts.rejectUnauthorized,
  };

  return new Promise<string>((resolve, reject) => {
    const req = transport.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) return resolve(body);
        reject(
          new Error(
            `pods/proxy GET ${args.podName}:${args.port}${path} → ${code} ${res.statusMessage ?? ''}${body ? `: ${body.slice(0, 300)}` : ''}`,
          ),
        );
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error(`pods/proxy GET ${args.podName}:${args.port}${path} timed out after ${args.timeoutMs ?? 10_000}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Run a command inside a pod container via the K8s API server's pods/exec subresource.
 * Collects stdout and stderr fully and returns them with the exit code.
 *
 *   const r = await podExec(kc, {namespace, podName, container: 'postgres', command: ['psql', '-c', 'SELECT 1']});
 *   if (r.exitCode !== 0) throw ...
 */
export async function podExec(
  kc: KubeConfig,
  args: {
    namespace: string;
    podName: string;
    container?: string;
    command: string[];
    stdin?: string;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const exec = new Exec(kc);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  const stdinStream: Readable | null = args.stdin ? Readable.from([Buffer.from(args.stdin, 'utf8')]) : null;
  let exitCode = -1;

  return new Promise((resolve, reject) => {
    const timer = args.timeoutMs
      ? setTimeout(() => reject(new Error(`podExec timed out after ${args.timeoutMs}ms`)), args.timeoutMs)
      : undefined;
    exec
      .exec(
        args.namespace,
        args.podName,
        args.container ?? 'postgres',
        args.command,
        stdout,
        stderr,
        stdinStream,
        false,
        (status: any) => {
          if (timer) clearTimeout(timer);
          if (status?.status === 'Success') {
            exitCode = 0;
          } else {
            const causes: any[] = status?.details?.causes ?? [];
            const exitCause = causes.find((c) => c.reason === 'ExitCode');
            exitCode = exitCause ? Number(exitCause.message) : 1;
          }
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode,
          });
        },
      )
      .catch((e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
  });
}

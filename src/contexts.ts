import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { KubeConfig, CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import type { K8sClients } from './types.js';

export interface ContextDescriptor {
  name: string;
  apiUrl?: string;
  tokenEnv?: string;
  caCertEnv?: string;
  skipTLSVerify?: boolean;
  /** Optional kubeconfig path; takes precedence over apiUrl/tokenEnv. */
  kubeconfigPath?: string;
  /** Optional named context within the kubeconfig file (defaults to current-context). */
  kubeconfigContext?: string;
}

export interface ContextEntry {
  name: string;
  descriptor: ContextDescriptor;
  /** Lazily-built clients. */
  clients?: K8sClients;
  buildError?: string;
}

const DEFAULT_CONTEXT_NAME = 'default';

function loadCaMaterial(envValue: string | undefined): { caData?: string; caFile?: string } | undefined {
  if (!envValue) return undefined;
  if (fs.existsSync(envValue)) return { caFile: envValue };
  try {
    const decoded = Buffer.from(envValue, 'base64').toString('utf8');
    if (decoded.includes('BEGIN CERTIFICATE')) return { caData: envValue };
  } catch {
    /* fall through */
  }
  if (envValue.includes('BEGIN CERTIFICATE')) {
    return { caData: Buffer.from(envValue).toString('base64') };
  }
  throw new Error(
    `CA cert env value must be a path, base64 PEM, or inline PEM. Got prefix: ${envValue.slice(0, 40)}...`,
  );
}

function buildKubeConfigForDescriptor(d: ContextDescriptor): KubeConfig {
  const kc = new KubeConfig();
  if (d.kubeconfigPath) {
    kc.loadFromFile(d.kubeconfigPath);
    if (d.kubeconfigContext) kc.setCurrentContext(d.kubeconfigContext);
    return kc;
  }
  if (d.apiUrl && d.tokenEnv) {
    const token = process.env[d.tokenEnv];
    if (!token) {
      throw new Error(`Token env var "${d.tokenEnv}" is not set for context "${d.name}"`);
    }
    const ca = d.caCertEnv ? loadCaMaterial(process.env[d.caCertEnv]) : undefined;
    if (d.skipTLSVerify && ca) {
      throw new Error(`Context "${d.name}": skipTLSVerify and caCertEnv are mutually exclusive`);
    }
    kc.loadFromOptions({
      clusters: [
        { name: `${d.name}-cluster`, server: d.apiUrl, skipTLSVerify: d.skipTLSVerify === true, ...(ca ?? {}) },
      ],
      users: [{ name: `${d.name}-user`, token }],
      contexts: [
        { name: `${d.name}-context`, cluster: `${d.name}-cluster`, user: `${d.name}-user` },
      ],
      currentContext: `${d.name}-context`,
    });
    return kc;
  }
  // Fallback: default kubeconfig (~/.kube/config)
  kc.loadFromDefault();
  return kc;
}

function clientsFromDescriptor(d: ContextDescriptor): K8sClients {
  const kc = buildKubeConfigForDescriptor(d);
  return {
    core: kc.makeApiClient(CoreV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    kc,
  };
}

/** Parse the K8S_CONTEXTS env var (JSON array of ContextDescriptor). Empty/missing → undefined. */
function parseContextsEnv(): ContextDescriptor[] | undefined {
  const raw = process.env.K8S_CONTEXTS;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`K8S_CONTEXTS is set but is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('K8S_CONTEXTS must be a JSON array of context descriptors');
  }
  for (const entry of parsed as any[]) {
    if (!entry?.name || typeof entry.name !== 'string') {
      throw new Error('Each K8S_CONTEXTS entry must have a string `name`');
    }
  }
  return parsed as ContextDescriptor[];
}

export class ContextRegistry {
  private entries: Map<string, ContextEntry>;
  private defaultName: string;
  /** True when K8S_CONTEXTS is set or there's more than one context. */
  public readonly multiContext: boolean;

  constructor(descriptors: ContextDescriptor[], defaultName: string, multiContext: boolean) {
    this.entries = new Map(descriptors.map((d) => [d.name, { name: d.name, descriptor: d } as ContextEntry]));
    this.defaultName = defaultName;
    this.multiContext = multiContext;
  }

  /** Build the registry from environment variables. */
  static fromEnv(): ContextRegistry {
    const explicit = parseContextsEnv();
    if (explicit && explicit.length > 0) {
      const defaultName = explicit[0].name;
      return new ContextRegistry(explicit, defaultName, true);
    }
    // Single-context fallback. If K8S_API_URL is set we treat it as one named context.
    const fallback: ContextDescriptor = process.env.K8S_API_URL
      ? {
          name: DEFAULT_CONTEXT_NAME,
          apiUrl: process.env.K8S_API_URL,
          tokenEnv: 'K8S_TOKEN',
          caCertEnv: process.env.K8S_CA_CERT ? 'K8S_CA_CERT' : undefined,
          skipTLSVerify: process.env.K8S_SKIP_TLS_VERIFY === 'true',
        }
      : { name: DEFAULT_CONTEXT_NAME };
    return new ContextRegistry([fallback], DEFAULT_CONTEXT_NAME, false);
  }

  contextNames(): string[] {
    return Array.from(this.entries.keys());
  }

  defaultContext(): string {
    return this.defaultName;
  }

  /** Resolve the K8sClients for a given context name (or default if undefined). Lazy build. */
  resolve(name?: string): K8sClients {
    const target = name ?? this.defaultName;
    const entry = this.entries.get(target);
    if (!entry) {
      const available = this.contextNames().join(', ');
      throw new Error(
        `Unknown context "${target}". Available context(s): ${available}. Pass one of these as the "context" argument.`,
      );
    }
    if (!entry.clients) {
      try {
        entry.clients = clientsFromDescriptor(entry.descriptor);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        entry.buildError = msg;
        throw new Error(`Failed to build clients for context "${target}": ${msg}`);
      }
    }
    return entry.clients;
  }

  /** Snapshot for `list_contexts` / `get_server_mode`. Does not force-build clients. */
  describe(): Array<{ name: string; default: boolean; available: boolean; error?: string }> {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.name,
      default: e.name === this.defaultName,
      available: e.buildError === undefined,
      error: e.buildError,
    }));
  }
}

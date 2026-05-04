import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';

interface S3Options {
  endpointURL: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function hash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signingKey(secretKey: string, datestamp: string, region: string, service: string): Buffer {
  const kDate = hmac('AWS4' + secretKey, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

interface SignedRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  path: string; // includes leading slash
  query?: Record<string, string>;
  body?: string;
}

function s3Request(
  opts: S3Options & { signedReq: SignedRequest },
): Promise<{ status: number; body: string }> {
  const { endpointURL, accessKey, secretKey, signedReq } = opts;
  const region = opts.region ?? 'us-east-1';
  const url = new URL(endpointURL);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const host = url.hostname + (url.port ? `:${url.port}` : '');

  const now = new Date();
  const amzdate =
    now.getUTCFullYear().toString().padStart(4, '0') +
    (now.getUTCMonth() + 1).toString().padStart(2, '0') +
    now.getUTCDate().toString().padStart(2, '0') +
    'T' +
    now.getUTCHours().toString().padStart(2, '0') +
    now.getUTCMinutes().toString().padStart(2, '0') +
    now.getUTCSeconds().toString().padStart(2, '0') +
    'Z';
  const datestamp = amzdate.slice(0, 8);

  const queryString = signedReq.query
    ? Object.entries(signedReq.query)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';

  const payload = signedReq.body ?? '';
  const payloadHash = hash(payload);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzdate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest =
    `${signedReq.method}\n${signedReq.path}\n${queryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credScope = `${datestamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzdate}\n${credScope}\n${hash(canonicalRequest)}`;
  const sig = crypto
    .createHmac('sha256', signingKey(secretKey, datestamp, region, 's3'))
    .update(stringToSign)
    .digest('hex');

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  const fullPath = signedReq.path + (queryString ? `?${queryString}` : '');
  const reqOpts: http.RequestOptions = {
    method: signedReq.method,
    host: url.hostname,
    port,
    path: fullPath,
    headers: {
      Host: host,
      'x-amz-date': amzdate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authHeader,
      ...(payload && { 'Content-Length': String(Buffer.byteLength(payload)) }),
    },
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function s3ListAllObjects(opts: S3Options & { prefix: string }): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  while (true) {
    const query: Record<string, string> = { 'list-type': '2', prefix: opts.prefix };
    if (continuationToken) query['continuation-token'] = continuationToken;
    const resp = await s3Request({
      ...opts,
      signedReq: {
        method: 'GET',
        path: `/${opts.bucket}`,
        query,
      },
    });
    if (resp.status !== 200) {
      throw new Error(`s3 list-objects-v2 → ${resp.status}: ${resp.body.slice(0, 300)}`);
    }
    const matches = resp.body.matchAll(/<Key>([^<]+)<\/Key>/g);
    for (const m of matches) keys.push(m[1]);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(resp.body);
    if (!truncated) break;
    const tokenMatch = resp.body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!tokenMatch) break;
    continuationToken = tokenMatch[1];
  }
  return keys;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function s3DeleteObjects(opts: S3Options & { keys: string[] }): Promise<number> {
  if (opts.keys.length === 0) return 0;
  let total = 0;
  // S3 DeleteObjects supports up to 1000 keys per request.
  for (let i = 0; i < opts.keys.length; i += 1000) {
    const batch = opts.keys.slice(i, i + 1000);
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Delete>' +
      batch.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('') +
      '<Quiet>true</Quiet>' +
      '</Delete>';
    const md5 = crypto.createHash('md5').update(xml).digest('base64');
    const resp = await s3Request({
      ...opts,
      signedReq: {
        method: 'POST',
        path: `/${opts.bucket}`,
        query: { delete: '' },
        body: xml,
      },
    });
    if (resp.status !== 200 && resp.status !== 204) {
      throw new Error(
        `s3 DeleteObjects (batch of ${batch.length}, md5=${md5}) → ${resp.status}: ${resp.body.slice(0, 300)}`,
      );
    }
    total += batch.length;
  }
  return total;
}

export async function s3DeletePrefix(opts: S3Options & { prefix: string }): Promise<number> {
  const keys = await s3ListAllObjects(opts);
  return s3DeleteObjects({ ...opts, keys });
}

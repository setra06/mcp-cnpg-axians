// Tiny e2e smoke for the HTTP transport. No live K8s required —
// initialize + tools/list don't touch the cluster.
const BASE = process.env.MCP_BASE || 'http://127.0.0.1:39817/mcp';

function post(body, headers = {}) {
  return fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

async function readResponse(res) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    const dataLines = text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    return dataLines.length ? JSON.parse(dataLines[dataLines.length - 1]) : null;
  }
  return text ? JSON.parse(text) : null;
}

const init = await post({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'http-e2e', version: '0.0.0' },
  },
});
if (!init.ok) throw new Error(`initialize HTTP ${init.status}: ${await init.text()}`);
const sid = init.headers.get('mcp-session-id');
if (!sid) throw new Error('no Mcp-Session-Id header on initialize response');
const initJson = await readResponse(init);
console.log('initialize OK, sessionId=' + sid + ', server=' + initJson?.result?.serverInfo?.name);

// notifications/initialized — required before further requests per the MCP spec.
const initd = await post(
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { 'Mcp-Session-Id': sid },
);
if (![200, 202, 204].includes(initd.status)) {
  throw new Error(`notifications/initialized HTTP ${initd.status}: ${await initd.text()}`);
}

const list = await post(
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { 'Mcp-Session-Id': sid },
);
if (!list.ok) throw new Error(`tools/list HTTP ${list.status}: ${await list.text()}`);
const listJson = await readResponse(list);
const count = listJson?.result?.tools?.length ?? 0;
console.log('tools/list OK, tool count=' + count);
if (count < 60) throw new Error('expected at least 60 tools, got ' + count);

// Cleanup: DELETE the session.
const del = await fetch(BASE, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } });
console.log('DELETE session status=' + del.status);

console.log('OK');

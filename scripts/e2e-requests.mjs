// A pinned user request reaches a connected MCP session in its next tool result, and resolve_request closes it.
// node scripts/e2e-requests.mjs <port>   (AI.cut running with AICUT_DEBUG=1 and a project open)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const port = process.argv[2] || '7788';
const client = new Client({ name: 'aicut-e2e-requests', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const text = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content.filter((c) => c.type === 'text').map((c) => c.text).join('\n---\n');
await text('get_project'); // marks older requests as seen
const ask = await fetch(`http://127.0.0.1:${port}/debug/eval`, { method: 'POST', body: JSON.stringify({ js: "window.aicut.call('ai:askHere', { text: 'Mets un zoom sur sa tête ici', time: 3.2, target: 'mcp' }).then((r) => r.request.id)" }) }).then((r) => r.json());
console.log('request', ask);
const next = await text('get_timeline', { format: 'compact' });
const got = next.includes('📌') && next.includes(ask.data);
console.log(got ? 'OK  the request was pushed with the next tool result' : 'FAIL no request note', '\n', next.split('---').pop().slice(0, 400));
const again = await text('list_requests');
console.log('list_requests', again.slice(0, 300));
const res = await text('resolve_request', { id: ask.data, reply: 'Zoom 1.2× ajouté à 3,2 s' });
console.log('resolve', res.slice(0, 200));
const after = await text('get_timeline', { format: 'compact' });
console.log(after.includes('📌') ? 'FAIL request pushed twice' : 'OK  not pushed twice');
await client.close();
process.exitCode = got ? 0 : 1;

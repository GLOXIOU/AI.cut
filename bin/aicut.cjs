#!/usr/bin/env node
// AI.cut command line (REST bridge) — for agents that can run shell commands but have no MCP support.
//   node bin/aicut.cjs tools                      → list tools
//   node bin/aicut.cjs call <tool> '<json args>'  → call a tool, prints the JSON result
//   node bin/aicut.cjs status
'use strict';
const BASE = process.env.AICUT_HTTP || `http://127.0.0.1:${process.env.AICUT_PORT || 7777}`;

async function main() {
  const [cmd, name, argJson] = process.argv.slice(2);
  try {
    if (!cmd || cmd === 'help') {
      console.log('usage: aicut tools | aicut call <tool> \'{"arg":1}\' | aicut status');
      return;
    }
    if (cmd === 'status') { console.log(JSON.stringify(await (await fetch(`${BASE}/health`)).json(), null, 2)); return; }
    if (cmd === 'tools') {
      const list = await (await fetch(`${BASE}/api/tools`)).json();
      for (const t of list) console.log(`${t.name.padEnd(24)} ${t.description.split('. ')[0]}`);
      return;
    }
    if (cmd === 'call') {
      const args = argJson ? JSON.parse(argJson) : {};
      const r = await fetch(`${BASE}/api/call/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aicut-client': 'aicut-cli' }, body: JSON.stringify(args) });
      const data = await r.json();
      if (!data.ok) { console.error(`Error: ${data.error}`); process.exit(1); }
      if (data.text) console.log(data.text);
      if (data.result !== undefined) console.log(JSON.stringify(data.result, null, 2));
      if (data.image) console.log(`image: ${data.image}`);
      return;
    }
    console.error(`unknown command ${cmd}`);
    process.exit(2);
  } catch (e) {
    console.error(e.cause?.code === 'ECONNREFUSED' ? 'AI.cut is not running — open the app first.' : e.message);
    process.exit(1);
  }
}
main();

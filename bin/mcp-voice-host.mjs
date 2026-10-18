#!/usr/bin/env node
// mcp-voice-host: serve the voice-first MCP Apps host locally and open it on an MCP server.
import { spawn } from 'node:child_process';
import { startHost } from '../server/serve.mjs';
import { startDemoServer } from '../examples/daybreak-coffee/server.mjs';

const HELP = `mcp-voice-host: test any MCP server as an Alexa+-style voice add-on.

Usage
  npx mcp-voice-host --server <url> [options]
  npx mcp-voice-host --demo

Options
  --server <url>        Streamable HTTP MCP endpoint, e.g. https://example.com/mcp
  --demo                also start the bundled Daybreak Coffee demo server and connect to it
  --port <n>            host port (default 4280, or any free port if taken)
  --sandbox-port <n>    sandbox origin port (default: any free port)
  --header "K: V"       add a header to every MCP request (repeatable)
  --bearer-env <NAME>   send "Authorization: Bearer $NAME" (the token never appears on screen)
  --tts-url <url>       TTS endpoint: POST {text, voice} returns audio (e.g. your Polly proxy)
  --brain-url <url>     replace the keyword matcher: POST {utterance, tools, context} returns
                        {tool, arguments} or {say} (plug any LLM, e.g. Bedrock)
  --no-proxy            browser talks to the server directly (the server must allow CORS)
  --no-open             do not open the browser
  -h, --help            this help

The page also works as a plain static site (any web server, no build step); the CLI adds the proxy and a
separate sandbox origin for MCP App Views.`;

function parse(argv) {
  const o = { headers: {}, open: true, proxy: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--server' || a === '-s') o.server = next();
    else if (a.startsWith('--server=')) o.server = a.slice(9);
    else if (a === '--demo') o.demo = true;
    else if (a === '--port') o.port = Number(next());
    else if (a === '--sandbox-port') o.sandboxPort = Number(next());
    else if (a === '--header' || a === '-H') { const h = next(); const i2 = h.indexOf(':'); if (i2 < 1) throw new Error(`Bad header "${h}" (use "Name: value")`); o.headers[h.slice(0, i2).trim().toLowerCase()] = h.slice(i2 + 1).trim(); }
    else if (a === '--bearer-env') { const n = next(); if (!process.env[n]) throw new Error(`Environment variable ${n} is empty`); o.headers.authorization = `Bearer ${process.env[n]}`; }
    else if (a === '--tts-url') o.ttsUrl = next();
    else if (a === '--brain-url') o.brainUrl = next();
    else if (a === '--no-proxy') o.proxy = false;
    else if (a === '--no-open') o.open = false;
    else if (!a.startsWith('-') && !o.server && /^https?:\/\//.test(a)) o.server = a;
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
}

async function main() {
  let o;
  try { o = parse(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n\n${HELP}`); process.exit(2); }
  if (o.help) { console.log(HELP); return; }
  const closers = [];
  if (o.demo) {
    const demo = await startDemoServer({ port: 0 });
    closers.push(demo.close);
    o.server = o.server || demo.url;
    console.log(`Daybreak Coffee demo MCP server  ${demo.url}`);
  }
  let host;
  try { host = await startHost({ ...o, port: o.port ?? 4280 }); }
  catch (e) { if (e.code === 'EADDRINUSE' && o.port === undefined) host = await startHost({ ...o, port: 0 }); else throw e; }
  closers.push(host.close);
  console.log(`mcp-voice-host                   ${host.url}`);
  console.log(`sandbox origin (MCP App views)   ${host.sandboxOrigin}`);
  if (o.server) console.log(`MCP server                       ${o.server}${o.proxy ? '  (through the local proxy)' : ''}`);
  if (Object.keys(o.headers).length) console.log(`extra headers                    ${Object.keys(o.headers).join(', ')}`);
  console.log('Press Ctrl+C to stop.');
  if (o.open) openBrowser(host.url);
  const stop = async () => { await Promise.allSettled(closers.map((c) => c())); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

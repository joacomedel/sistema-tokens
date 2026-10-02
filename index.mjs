import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './src/config.mjs';
import { buildServer } from './src/server.mjs';

const config = loadConfig(process.env, { defaultStoreDir: new URL('./store', import.meta.url).pathname });

// stdout es el canal JSON-RPC: los logs van por stderr.
const server = buildServer({ config, tools: [] });
await server.connect(new StdioServerTransport());
console.error('sistemaTokens-mcp listo');

#!/usr/bin/env node
// money-guard-mcp: the stdio entry point. One process serves one MCP client; serveStdio decides the
// protocol era per connection (2026-07-28 or the 2025 handshake) and builds the server from the factory.
// stdout carries the protocol and nothing else; this file writes only to stderr.

import process from 'node:process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { clip } from './echo.js';
import { NAME, VERSION, createServer } from './server.js';

const config = resolveConfig(process.env, process.cwd());
// Transport problems (a message over the SDK's 10 MiB stdio limit, which closes the connection, or a
// line that is not JSON) arrive here. Log the kind only: the content could quote a file or an argument.
const handle = serveStdio(() => createServer(config), { onerror: (err) => process.stderr.write(`${NAME}: transport error (${err.name})\n`) });

const root = config.root.ok ? `project folder "${clip(config.root.value.name, 80)}"` : 'no usable project folder (the tools answer ROOT_INVALID)';
const keys = config.auditKeys.ok ? `${config.auditKeys.value.ids.length} audit key id(s)` : 'no audit keys';
// The Node.js version helps when a host (Claude Desktop) runs the server with its own built-in Node.
process.stderr.write(`${NAME} ${VERSION} (Node.js ${process.version}) on stdio: ${root}; ${keys}.\n`);

// A failure no handler caught must not take the server down with it; it is logged without its message,
// which could quote a file.
process.on('uncaughtException', (err) => process.stderr.write(`${NAME}: uncaught ${err.name}\n`));
process.on('unhandledRejection', (reason) => process.stderr.write(`${NAME}: unhandled rejection (${reason instanceof Error ? reason.name : typeof reason})\n`));

const stop = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

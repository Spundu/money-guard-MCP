#!/usr/bin/env node
// money-guard-mcp: the stdio entry point. One process serves one MCP client; serveStdio decides the
// protocol era per connection (2026-07-28 or the 2025 handshake) and builds the server from the factory.
// stdout carries the protocol and nothing else; this file writes only to stderr.

import process from 'node:process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { NAME, VERSION, createServer } from './server.js';

const config = resolveConfig(process.env, process.cwd());
const handle = serveStdio(() => createServer(config));

const root = config.root.ok ? `project folder "${config.root.value.name}"` : 'no usable project folder (the tools answer ROOT_INVALID)';
const keys = config.auditKeys.ok ? `${config.auditKeys.value.ids.length} audit key id(s)` : 'no audit keys';
process.stderr.write(`${NAME} ${VERSION} on stdio: ${root}; ${keys}.\n`);

// A failure no handler caught must not take the server down with it; it is logged without its message,
// which could quote a file.
process.on('uncaughtException', (err) => process.stderr.write(`${NAME}: uncaught ${err.name}\n`));
process.on('unhandledRejection', (reason) => process.stderr.write(`${NAME}: unhandled rejection (${reason instanceof Error ? reason.name : typeof reason})\n`));

const stop = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

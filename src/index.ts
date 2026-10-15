#!/usr/bin/env node
// money-guard-mcp: the stdio entry point. One process serves one MCP client; serveStdio decides the
// protocol era per connection (2026-07-28 or the 2025 handshake) and builds the server from the factory.
// stdout carries the protocol and nothing else; this file writes only to stderr.

import process from 'node:process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { logLine } from './log.js';
import { NAME, VERSION, createServer, trace } from './server.js';

// The log is a convenience and never holds the server up (src/log.ts). process.stderr exists from the
// start (here at the latest; the server's start-up creates it anyway), and that matters on Linux:
// creating it makes a piped stderr non-blocking (libuv does), so a log write to a pipe that a host never
// reads fails at once and is dropped, instead of holding a thread of libuv's pool until the host reads
// (test/stdio.test.ts checks the flag). Node's own warnings go through process.stderr: once a host has
// closed it, a write fails with EPIPE, which is ignored here rather than reported as an uncaught error.
// Lost log lines are fine.
process.stderr.on('error', () => {});

const config = resolveConfig(process.env, process.cwd());
// Transport problems (a message over the SDK's 10 MiB stdio limit, which closes the connection, or valid
// JSON that is not a protocol message; the SDK skips a line that is not JSON) arrive here. Log the kind
// only: the content could quote a file or an argument.
const handle = serveStdio(() => createServer(config), { onerror: (err) => logLine(`${NAME}: transport error (${err.name})`) });

const root = config.root.ok ? `project folder "${config.root.value.name}"` : 'no usable project folder (the tools answer ROOT_INVALID)';
const keys = config.auditKeys.ok
  ? `${config.auditKeys.value.ids.length} audit key id(s)`
  : config.auditKeys.error.code === 'KEYS_INVALID'
    ? 'audit keys malformed (the audit tool answers KEYS_INVALID)'
    : 'no audit keys';
// The Node.js version helps when a host (Claude Desktop) runs the server with its own built-in Node.
logLine(`${NAME} ${VERSION} (Node.js ${process.version}) on stdio: ${root}; ${keys}.`);

// A failure no handler caught must not take the server down with it. It is logged as its type and code
// locations only (trace): never its message, which could quote a file.
process.on('uncaughtException', (err) => logLine(`${NAME}: uncaught ${trace(err)}`));
process.on('unhandledRejection', (reason) => logLine(`${NAME}: unhandled rejection ${trace(reason)}`));

const stop = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

#!/usr/bin/env node
// money-guard-mcp: the stdio entry point. One process serves one MCP client; serveStdio decides the
// protocol era per connection (2026-07-28 or the 2025 handshake) and builds the server from the factory.
// stdout carries the protocol and nothing else; this file writes only to stderr.

import process from 'node:process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { logLine, logWriting } from './log.js';
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
// only: the content could quote a file or an argument. The SDK's own sentence for an oversized message is
// fixed text, so it is named (review round 24: it showed as "Error", as a message that is no protocol does).
const OVERSIZED = /^ReadBuffer exceeded maximum size of \d+ bytes$/;
const kindOf = (err: Error) => (OVERSIZED.test(err.message) ? 'a message over the 10 MiB limit' : err.name);
const handle = serveStdio(() => createServer(config), { onerror: (err) => logLine(`${NAME}: transport error (${kindOf(err)}${typeof (err as NodeJS.ErrnoException).code === 'string' ? ` ${String((err as NodeJS.ErrnoException).code).slice(0, 24)}` : ''})`) });

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

// On Windows a log line waiting for a host that never reads stderr holds a thread of libuv's pool, and
// process.exit waits for that thread (review round 20: the server never exited). Then the process is
// ended at once instead (TerminateProcess, exit code 1): the line was lost anyway.
const exit = () => {
  if (process.platform === 'win32' && logWriting()) process.kill(process.pid, 'SIGKILL');
  process.exit(0);
};
const stop = () => {
  void handle.close().finally(exit);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// When the host closes stdin, the SDK closes the connection, and a server with nothing left to do exits by
// itself. One that is still alive after a short grace for its last answers and log lines exits anyway.
// 'end' as the SDK's transport listens for it (it then pauses stdin, which may never emit 'close'), or 'close'.
const EXIT_GRACE_MS = 2000;
let exiting = false;
const exitSoon = () => {
  if (exiting) return;
  exiting = true;
  setTimeout(exit, EXIT_GRACE_MS).unref();
};
process.stdin.once('end', exitSoon);
process.stdin.once('close', exitSoon);

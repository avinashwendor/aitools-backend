/**
 * Run an author's JavaScript with no way back into this process.
 *
 * The Code node exists because no fixed set of nodes ever reshapes every API's
 * response, and reaching for a model to rename two fields is absurd. But it
 * means running code a user wrote on our server, and the honest version of that
 * is a real isolation boundary rather than a comfortable-sounding one.
 *
 * `node:vm` is the tempting answer and it is not a sandbox. `this.constructor
 * .constructor('return process')()` walks straight out of a vm context back
 * into the host realm, and from there `process.env` hands over every provider
 * key we hold. Worker threads move the escape one level out and change nothing
 * about that ending — a worker shares the process, and therefore the env.
 *
 * So the boundary is a process boundary, and the thing that makes it worth the
 * ~40ms spawn is `env: {}`. A full escape from the vm lands in a Node process
 * that has no environment, no arguments, no open handles to our database, and
 * a `cwd` it was not told. There is nothing there to steal. The vm layer inside
 * is still worth keeping: it makes the common case (a typo, an infinite loop)
 * fail as a clean error rather than a killed process.
 *
 * Data crosses as JSON in both directions. Nothing structured is passed by
 * reference, which is also what makes the timeout safe to enforce by killing —
 * there is no half-mutated object on our side to reason about.
 */

import { spawn } from 'node:child_process';
import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agentic:sandbox');

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * The child program.
 *
 * Reads `{ script, context }` from stdin, evaluates the script as a function
 * body, and writes `{ ok, value }` or `{ ok: false, error }` to stdout. It
 * never throws out of the top level, because a non-zero exit tells the parent
 * nothing about which line the author got wrong.
 */
const RUNNER = `
const vm = require('node:vm');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  let out;
  try {
    const { script, context, timeoutMs } = JSON.parse(raw);

    /**
     * Deliberately almost empty. A fresh vm context already has its own
     * Object, Array, JSON and Promise, and handing it *ours* instead would put
     * a host constructor inside the sandbox — from which \`Object.constructor
     * ('return process')()\` reaches straight back out. Console is the one
     * addition, and it is a sink: an author's log line should not become a
     * line in our server logs.
     */
    const sandbox = vm.createContext({
      console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    });

    vm.runInContext('globalThis.__data = ' + JSON.stringify(context) + ';', sandbox);

    /**
     * Async, because half of what anyone writes here is a transform over data
     * that arrived from an await somewhere else, and a script that says
     * \`await\` failing to parse is a baffling error to receive.
     *
     * The vm timeout only bounds synchronous execution, which covers the
     * common accident (a runaway loop) with a clean error. A promise that
     * simply never settles is caught by the parent's kill timer instead.
     */
    const promise = vm.runInContext(
      '(async function(){ const { input, steps, trigger } = globalThis.__data;\\n' + script + '\\n})()',
      sandbox,
      { timeout: Math.max(500, timeoutMs - 500), displayErrors: true }
    );

    const value = await promise;

    // Serialised inside the context: a value built in there is not a host
    // object, and round-tripping it is what guarantees the parent only ever
    // sees plain JSON.
    sandbox.__result = value;
    const serialized = vm.runInContext('JSON.stringify(__result === undefined ? null : __result)', sandbox);

    out = { ok: true, value: serialized === undefined ? 'null' : serialized };
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err).slice(0, 500) };
  }
  process.stdout.write(JSON.stringify(out));
});
`;

/**
 * @param {string} script   the author's function body; may `await`, must `return`
 * @param {object} context  `{ input, steps, trigger }`, JSON-serialisable
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<any>}  the returned value, as plain JSON
 * @throws {Error} on a script error, a timeout, or unserialisable data
 */
export async function runScript(script, context, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!String(script).trim()) {
    throw new Error('This Code step has no script.');
  }

  const budget = Math.min(Math.max(Number(timeoutMs) || TIMEOUT_MS, 500), 30_000);

  let payload;
  try {
    payload = JSON.stringify({ script: String(script), context, timeoutMs: budget });
  } catch {
    throw new Error('The data reaching this step could not be serialised — it may contain a cycle.');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', RUNNER], {
      // The whole security argument, in one option. Also `cwd: '/'` so a
      // relative path resolves somewhere uninteresting.
      env: {},
      cwd: '/',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detached so the kill below reaches anything the script managed to spawn
      // rather than orphaning it.
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(new Error(`Script timed out after ${budget / 1000}s. Check for an endless loop.`));
    }, budget);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('Script returned too much data. Return a summary rather than everything.'));
      }
    });

    child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });

    child.on('error', err => {
      finish(new Error(`Could not start the sandbox: ${err.message}`));
    });

    child.on('close', code => {
      if (settled) return;

      if (!stdout) {
        log.warn('Sandbox produced no output', { code, stderr: stderr.slice(0, 300) });
        finish(new Error(
          code === null
            ? 'The script was stopped before it finished.'
            : `The script crashed (exit ${code}).`
        ));
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(new Error('The sandbox returned something unreadable.'));
        return;
      }

      if (!parsed.ok) {
        finish(new Error(parsed.error || 'The script threw.'));
        return;
      }

      try {
        finish(null, JSON.parse(parsed.value));
      } catch {
        finish(new Error('The script returned a value that is not JSON — return plain data.'));
      }
    });

    child.stdin.on('error', () => {
      // A child that died before reading stdin already reported through `close`.
    });
    child.stdin.end(payload);
  });
}

export const sandboxTimeoutMs = TIMEOUT_MS;

export default { runScript, sandboxTimeoutMs, maxNodes: config.agentic.maxNodes };

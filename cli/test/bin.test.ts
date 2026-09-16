// The `glcm` binary as a user starts it: a real process, tsx compiling the sources, and MCP over standard input and
// output. The in-process tests cannot see these: a bug in the binary once left every command silent.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'glcm.mjs');
let dataDir: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glcm-bin-test-'));
});

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function runBinary(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args, '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('the glcm binary', () => {
  it('runs a command and reports success', async () => {
    const result = await runBinary(['features', '--presets']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('haralick');
    expect(result.out).toContain('Haralick F1–F14');
  });

  it('exits with 2 and prints the reason for a command that cannot run', async () => {
    const result = await runBinary(['measure']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Name at least one image');
  });

  it('answers the MCP handshake on standard input and output', async () => {
    const child = spawn(process.execPath, [BIN, 'mcp', '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const answers = new Map<number, Record<string, unknown>>();
      const finished = new Promise<void>((resolve, reject) => {
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines.filter(Boolean)) {
            const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
            if (message.id !== undefined && message.result) {
              answers.set(message.id, message.result);
            }
          }
          if (answers.has(1) && answers.has(2)) {
            resolve();
          }
        });
        child.on('error', reject);
        child.on('close', () => reject(new Error(`the server stopped before answering: ${answers.size} answers`)));
      });

      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      await finished;

      expect((answers.get(1)!.serverInfo as { name: string }).name).toBe('texture-workbench');
      expect(answers.get(1)!.capabilities).toHaveProperty('tools');
      const tools = (answers.get(2)!.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(tools).toContain('measure');
      expect(tools).toContain('view_image');
    } finally {
      child.kill();
    }
  });
});

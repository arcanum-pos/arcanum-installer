import { describe, expect, it } from 'vitest';
import { saveState, type InstallerState } from '../src/state';
import type { Env } from '../src/env';

// KV: one write per second per key - a 429 for the next one.
function kv(failures: number, message = 'KV PUT failed: 429 Too Many Requests') {
  const puts: string[] = [];
  let left = failures;
  const env = {
    INSTALLER_STATE: {
      async put(key: string, value: string) {
        if (left-- > 0) throw new Error(message);
        puts.push(`${key}=${value}`);
      },
    },
  } as unknown as Env;
  return { env, puts };
}

const state = { steps: {} } as unknown as InstallerState;

describe('saveState', () => {
  it('writes again after a 429, waiting a little longer each time', async () => {
    const { env, puts } = kv(2);
    const waits: number[] = [];
    await saveState(env, state, async (ms) => void waits.push(ms));
    expect(puts).toEqual(['state={"steps":{}}']);
    expect(waits).toEqual([1100, 2200]);
  });

  it('gives up after five tries', async () => {
    const { env, puts } = kv(5);
    await expect(saveState(env, state, async () => {})).rejects.toThrow(/429/);
    expect(puts).toEqual([]);
  });

  it('never retries another error', async () => {
    const { env } = kv(1, 'KV PUT failed: 500 Internal Server Error');
    const waits: number[] = [];
    await expect(saveState(env, state, async (ms) => void waits.push(ms))).rejects.toThrow(/500/);
    expect(waits).toEqual([]);
  });
});

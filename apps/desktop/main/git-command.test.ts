import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit } from './git';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function command() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.emit('close', null); return true; }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('Git command deadlines', () => {
  it('retains the 15-second default for ordinary operations', async () => {
    const child = command();
    const result = expect(runGit('/repo', ['version'])).rejects.toThrow('Git timed out after 15 seconds');
    await vi.advanceTimersByTimeAsync(14999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a large scan to finish after 15 seconds and clears its longer deadline', async () => {
    const child = command();
    let output = '';
    const result = runGit('/repo', ['ls-files', '-z'], 1024, { timeoutMs: 60000, onStdout: chunk => { output += chunk.toString(); } });
    await vi.advanceTimersByTimeAsync(20000);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write(Buffer.from('complete.ts\0'));
    child.emit('close', 0);
    expect((await result).length).toBe(0);
    expect(output).toBe('complete.ts\0');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still stops a stuck large scan at its configured deadline', async () => {
    const child = command();
    const result = expect(runGit('/repo', ['status'], 1024, { timeoutMs: 60000 })).rejects.toThrow('Git timed out after 60 seconds');
    await vi.advanceTimersByTimeAsync(59999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a streamed command promptly without waiting for its extended deadline', async () => {
    const child = command();
    const controller = new AbortController();
    const result = expect(runGit('/repo', ['ls-files', '-z'], 1024, { timeoutMs: 60000, signal: controller.signal, onStdout: () => {} })).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await result;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

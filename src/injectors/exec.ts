import { spawn } from 'node:child_process';
import type { DeliverResult, Injector, Wake } from '../types.ts';
import { wakeText } from '../wake.ts';

export interface ExecOptions {
  /** Optional hard limit per run. When it passes, the command's process group
   * gets SIGTERM, then SIGKILL after `killGraceMs`, and the wake reports
   * `busy` (retried with backoff, not acknowledged). Off by default; if you
   * set it, make it generous (e.g. 30 minutes for an agent run). */
  timeoutMs?: number;
  killGraceMs?: number;
  /** The watcher's stop signal. When it fires during a run, the command's
   * process group gets SIGTERM (SIGKILL after `killGraceMs`) and the wake
   * reports `busy`, so the batch is not acknowledged and is redelivered on
   * the next start. A run that already exited 0 still counts. */
  signal?: AbortSignal;
}

/**
 * Runs a command per wake (headless hosts: `claude -p`, `codex exec`,
 * `agy -p`). The command string is fixed configuration; the wake reaches it
 * only through TILORI_WAKE_TEXT, TILORI_WAKE_JSON and stdin, and contains ids
 * only (or, for a reminder, your own configured text). `accepted` means the command exited 0; any other exit is `busy`, so
 * the batch is retried and acknowledged only after a successful run.
 */
export class ExecInjector implements Injector {
  readonly kind = 'exec';

  constructor(
    private readonly command: string,
    private readonly logger: (m: string) => void = () => {},
    private readonly options: ExecOptions = {},
  ) {
    if (!command.trim()) throw new Error('The exec injector needs a command.');
    const t = options.timeoutMs;
    if (t !== undefined && (!Number.isFinite(t) || t <= 0)) {
      throw new Error('Exec timeout must be a positive number of milliseconds.');
    }
  }

  deliver(wake: Wake): Promise<DeliverResult> {
    const text = wakeText(wake);
    const stopSignal = this.options.signal;
    if (stopSignal?.aborted) return Promise.resolve('busy');
    return new Promise((resolve) => {
      const env = { ...process.env, TILORI_WAKE_TEXT: text, TILORI_WAKE_JSON: JSON.stringify(wake), TILORI_AGENT: wake.agent };
      // Own process group, so a timeout or stop also ends whatever the command
      // spawned (and a terminal Ctrl-C doesn't reach it behind our back).
      const child = spawn('/bin/sh', ['-c', this.command], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env,
        detached: true,
      });
      let stopped = false;
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          // already gone
        }
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (why: string) => {
        if (stopped) return;
        stopped = true;
        this.logger(`exec injector ${why}; stopping it`);
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), this.options.killGraceMs ?? 5_000);
      };
      const timer =
        this.options.timeoutMs !== undefined
          ? setTimeout(() => stop(`timed out after ${this.options.timeoutMs} ms`), this.options.timeoutMs)
          : undefined;
      const onStop = () => stop('interrupted by stop signal');
      stopSignal?.addEventListener('abort', onStop, { once: true });
      const groupAlive = () => {
        try {
          if (child.pid) process.kill(-child.pid, 0);
          return Boolean(child.pid);
        } catch {
          return false;
        }
      };
      const finish = (r: DeliverResult) => {
        clearTimeout(timer);
        // After a stop or timeout, the shell can exit on SIGTERM while
        // something it started ignores SIGTERM. Keep the group SIGKILL armed
        // until the grace period ends unless the whole group is already gone.
        if (!stopped || !groupAlive()) clearTimeout(killTimer);
        stopSignal?.removeEventListener('abort', onStop);
        resolve(r);
      };
      child.on('error', () => finish('busy'));
      child.on('close', (code) => {
        if (stopped) return finish('busy');
        if (code !== 0) this.logger(`exec injector exited ${code}; will retry`);
        finish(code === 0 ? 'accepted' : 'busy');
      });
      child.stdin.on('error', () => {});
      child.stdin.end(text + '\n');
    });
  }
}

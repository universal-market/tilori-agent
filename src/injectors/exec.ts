import { spawn } from 'node:child_process';
import type { DeliverResult, Injector, Wake } from '../types.ts';
import { wakeText } from '../wake.ts';

/**
 * Runs a command per wake (headless hosts: `claude -p`, `codex exec`,
 * `agy -p`). The command string is fixed configuration; the wake reaches it
 * only through TILORI_WAKE_TEXT, TILORI_WAKE_JSON and stdin, and contains ids
 * only. `accepted` means the command exited 0; any other exit is `busy`, so
 * the batch is retried and acknowledged only after a successful run.
 */
export class ExecInjector implements Injector {
  readonly kind = 'exec';

  constructor(
    private readonly command: string,
    private readonly logger: (m: string) => void = () => {},
  ) {
    if (!command.trim()) throw new Error('The exec injector needs a command.');
  }

  deliver(wake: Wake): Promise<DeliverResult> {
    const text = wakeText(wake);
    return new Promise((resolve) => {
      const env = { ...process.env, TILORI_WAKE_TEXT: text, TILORI_WAKE_JSON: JSON.stringify(wake), TILORI_AGENT: wake.agent };
      const child = spawn('/bin/sh', ['-c', this.command], { stdio: ['pipe', 'inherit', 'inherit'], env });
      child.on('error', () => resolve('busy'));
      child.on('close', (code) => {
        if (code !== 0) this.logger(`exec injector exited ${code}; will retry`);
        resolve(code === 0 ? 'accepted' : 'busy');
      });
      child.stdin.on('error', () => {});
      child.stdin.end(text + '\n');
    });
  }
}

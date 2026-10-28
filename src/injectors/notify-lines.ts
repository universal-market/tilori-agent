import type { Writable } from 'node:stream';
import type { DeliverResult, Injector, Wake } from '../types.ts';
import type { UpdateNotice } from '../update-notice.ts';
import { wakeText } from '../wake.ts';

/**
 * Writes one fixed wake line per wake to a stream (stdout for a Claude Code
 * plugin monitor, where each line becomes a notification that starts a turn
 * in an idle session). `accepted` means the line was flushed to the OS.
 * Nothing else may be written to this stream: logs go to stderr.
 */
export class NotifyLinesInjector implements Injector {
  readonly kind = 'notify-lines';
  #gone = false;

  constructor(
    private readonly out: Writable = process.stdout,
    /** Called once when the stream breaks (the session is gone). */
    private readonly onGone: () => void = () => {},
    /** Adds a one-time "newer plugin installed" note to the next wake. It
     * lives here, in the session's own process, because a shared router
     * can't know which plugin version each session runs. */
    private readonly update?: UpdateNotice,
  ) {
    out.on('error', () => this.#markGone());
  }

  #markGone() {
    if (this.#gone) return;
    this.#gone = true;
    this.onGone();
  }

  deliver(wake: Wake): Promise<DeliverResult> {
    if (this.#gone) return Promise.resolve('gone');
    const update = this.update?.pending() ?? null;
    const line = wakeText(update ? { ...wake, plugin_update: update } : wake).replace(/[\r\n]+/g, ' ') + '\n';
    return new Promise((resolve) => {
      try {
        this.out.write(line, 'utf8', (err) => {
          if (err) this.#markGone();
          else if (update) this.update!.said(update);
          resolve(err ? 'gone' : 'accepted');
        });
      } catch {
        this.#markGone();
        resolve('gone');
      }
    });
  }
}

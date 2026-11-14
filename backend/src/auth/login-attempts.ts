import { Injectable } from '@nestjs/common';
import { now } from '../common/clock.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

interface Window {
  start: number;
  failures: number;
}

/**
 * Failed sign-ins per normalized email, in memory: 5 failures within 15
 * minutes block that email until the window ends. One backend process means
 * one counter, and a restart resets it.
 */
@Injectable()
export class LoginAttempts {
  private readonly windows = new Map<string, Window>();

  /** Seconds until the email may try again, or null when it isn't blocked. */
  retryAfterSeconds(email: string): number | null {
    const window = this.windows.get(email);
    const time = now().getTime();
    if (!window || window.failures < MAX_FAILURES || isExpired(window, time))
      return null;
    return Math.max(1, Math.ceil((window.start + WINDOW_MS - time) / 1000));
  }

  recordFailure(email: string): void {
    const time = now().getTime();
    this.sweep(time);
    const window = this.windows.get(email);
    if (window) window.failures++;
    else this.windows.set(email, { start: time, failures: 1 });
  }

  clear(email: string): void {
    this.windows.delete(email);
  }

  /** Drops expired windows, so the map can't grow without bound. */
  private sweep(time: number): void {
    for (const [email, window] of this.windows) {
      if (isExpired(window, time)) this.windows.delete(email);
    }
  }
}

function isExpired(window: Window, time: number): boolean {
  return time >= window.start + WINDOW_MS;
}

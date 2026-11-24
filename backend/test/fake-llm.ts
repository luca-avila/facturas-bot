import { randomUUID } from 'node:crypto';
import type { LlmFetch } from '../src/extraction/anthropic-client.js';

/** What the fake saw of one request. The key is never kept. */
export interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Answer = () => Promise<Response>;

const KEY_HEADERS = new Set(['x-api-key', 'authorization']);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': randomUUID() },
  });
}

function message(
  content: unknown[],
  stopReason: string,
  usage = { input_tokens: 1800, output_tokens: 900 },
): Response {
  return json(200, {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  });
}

const THINKING = { type: 'thinking', thinking: '', signature: 'sig' };

/**
 * A fake Messages API for the real SDK, through `LLM_FETCH`. Each request
 * takes the next answer from the queue, and an empty queue throws.
 */
export class FakeLlm {
  readonly requests: RecordedRequest[] = [];
  private readonly answers: Answer[] = [];

  readonly fetch: LlmFetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = KEY_HEADERS.has(name) ? '<key>' : value;
    });
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    this.requests.push({
      url,
      body: JSON.parse(raw) as Record<string, unknown>,
      headers,
    });
    const answer = this.answers.shift();
    if (answer === undefined) {
      throw new Error('FakeLlm got a request with no answer queued.');
    }
    return answer();
  };

  /** A real body: a thinking block, then the JSON as text, plus usage. */
  reply(
    output: unknown,
    { stopReason = 'end_turn' }: { stopReason?: string } = {},
  ): this {
    this.answers.push(() =>
      Promise.resolve(
        message(
          [THINKING, { type: 'text', text: JSON.stringify(output) }],
          stopReason,
        ),
      ),
    );
    return this;
  }

  /** Text that may not be JSON, such as a truncated object. */
  replyText(text: string, stopReason = 'end_turn'): this {
    this.answers.push(() =>
      Promise.resolve(message([THINKING, { type: 'text', text }], stopReason)),
    );
    return this;
  }

  /** Only a thinking block, or nothing. */
  replyEmpty(stopReason: string): this {
    this.answers.push(() => Promise.resolve(message([], stopReason)));
    return this;
  }

  /** An HTTP error with the API's JSON error body. */
  replyStatus(status: number): this {
    const type =
      status === 401
        ? 'authentication_error'
        : status === 529
          ? 'overloaded_error'
          : 'api_error';
    this.answers.push(() =>
      Promise.resolve(
        json(status, {
          type: 'error',
          error: { type, message: `fake ${type}` },
        }),
      ),
    );
    return this;
  }

  /** The connection fails. */
  failNetwork(): this {
    this.answers.push(() => Promise.reject(new TypeError('fetch failed')));
    return this;
  }

  /**
   * Holds the next request until `release()`, then answers with `output`.
   * `received` resolves once the request arrives.
   */
  hold(output: unknown): { received: Promise<void>; release: () => void } {
    let release!: () => void;
    let arrived!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const received = new Promise<void>((resolve) => (arrived = resolve));
    this.answers.push(async () => {
      arrived();
      await released;
      return message(
        [THINKING, { type: 'text', text: JSON.stringify(output) }],
        'end_turn',
      );
    });
    return { received, release };
  }

  /** Answers still queued. */
  get pending(): number {
    return this.answers.length;
  }
}

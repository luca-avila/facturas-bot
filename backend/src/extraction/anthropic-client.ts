import Anthropic from '@anthropic-ai/sdk';

/** Injection token for the `fetch` the SDK uses. Tests pass a fake. */
export const LLM_FETCH = Symbol('LLM_FETCH');
/** Injection token for the configured `Anthropic` client. */
export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

export type LlmFetch = typeof globalThis.fetch;

/** Each call gives up after 3 minutes, less than a lease. */
export const CALL_TIMEOUT_MS = 180_000;

/**
 * Every option the SDK would otherwise read from the environment is passed
 * explicitly:
 * - `apiKey`, so no other credential is picked up;
 * - `baseURL`, so `ANTHROPIC_BASE_URL` can't send the photos anywhere else;
 * - `logLevel`, so `ANTHROPIC_LOG=debug` can't print requests;
 * - `maxRetries: 0`, since the worker's retries are the only ones.
 */
export function createAnthropicClient({
  apiKey,
  fetch,
}: {
  apiKey: string;
  fetch: LlmFetch;
}): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    timeout: CALL_TIMEOUT_MS,
    logLevel: 'warn',
    fetch,
  });
}

import Anthropic, { AnthropicError, APIError } from '@anthropic-ai/sdk';
import {
  buildExtractionRequest,
  type PageImage,
} from './extraction-request.js';
import {
  EXTRACTION_EFFORT,
  type ExtractionEffort,
  type ExtractionOutput,
} from './prompt.js';

export type CallOutcome =
  | {
      ok: true;
      output: ExtractionOutput;
      /** The model's JSON as written, parsed before the schema. */
      rawOutput: unknown;
      usage: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; error: string };

/** `last_error` is cut to this many characters. */
const MAX_ERROR_LENGTH = 1_000;

/** Stop reasons that mean the output can't be trusted, even if it parsed. */
const FAILED_STOP_REASONS: ReadonlySet<string> = new Set([
  'max_tokens',
  'refusal',
  'model_context_window_exceeded',
]);

/** `<class> <status>: <message>`, cut to 1,000 characters. */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  const status =
    error instanceof APIError && error.status !== undefined
      ? ` ${error.status}`
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return `${name}${status}: ${message}`.slice(0, MAX_ERROR_LENGTH);
}

/** The only code that sends anything to Anthropic. */
export class ExtractionCall {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async run(
    pages: readonly PageImage[],
    effort: ExtractionEffort = EXTRACTION_EFFORT,
  ): Promise<CallOutcome> {
    const request = buildExtractionRequest({
      model: this.model,
      effort,
      pages,
    });
    let message;
    try {
      message = await this.client.messages.parse(request);
    } catch (error) {
      // HTTP and connection errors, and JSON that doesn't parse or breaks
      // the schema. Anything else is a bug and propagates.
      if (error instanceof AnthropicError) {
        return { ok: false, error: describeError(error) };
      }
      throw error;
    }
    // Before parsed_output: a refusal with valid JSON still parses.
    if (
      message.stop_reason !== null &&
      FAILED_STOP_REASONS.has(message.stop_reason)
    ) {
      return { ok: false, error: `stop_reason ${message.stop_reason}` };
    }
    if (message.parsed_output === null) {
      return { ok: false, error: 'no structured output' };
    }
    // The SDK only fills parsed_output from a text block.
    const text = message.content.find((block) => block.type === 'text');
    if (text === undefined) throw new Error('parsed_output with no text block');
    return {
      ok: true,
      output: message.parsed_output,
      rawOutput: JSON.parse(text.text) as unknown,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}

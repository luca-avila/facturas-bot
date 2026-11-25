import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  EXTRACTION_SCHEMA,
  type ExtractionEffort,
  MAX_TOKENS,
  PROMPT,
} from './prompt.js';

/** One stored page, as it's sent: the bytes as uploaded (E5). */
export interface PageImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Buffer;
}

/**
 * The whole request body: the pages in order, then the prompt. Nothing else,
 * so no `system`, `thinking` or sampling parameters. The worker and the
 * extraction test both send exactly this.
 */
export function buildExtractionRequest({
  model,
  effort,
  pages,
}: {
  model: string;
  effort: ExtractionEffort;
  pages: readonly PageImage[];
}) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    output_config: { effort, format: zodOutputFormat(EXTRACTION_SCHEMA) },
    messages: [
      {
        role: 'user' as const,
        content: [
          ...pages.map((page) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: page.mimeType,
              data: page.bytes.toString('base64'),
            },
          })),
          { type: 'text' as const, text: PROMPT },
        ],
      },
    ],
  };
}

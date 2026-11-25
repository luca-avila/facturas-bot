import { FakeLlm } from '../../test/fake-llm.js';
import { jpeg, png } from '../../test/photos.js';
import { createAnthropicClient } from './anthropic-client.js';
import { ExtractionCall } from './extraction-call.js';
import type { PageImage } from './extraction-request.js';
import { PROMPT } from './prompt.js';

const KEY = 'sk-ant-test-only-not-a-real-key';
const MODEL = 'claude-haiku-5-5';

/** A valid output with invented values. */
const OUTPUT = {
  isDocument: true,
  type: 'invoice',
  letter: 'A',
  number: '0003-00012345',
  issueDate: '2026-10-21',
  supplierCuit: null,
  supplierName: 'Distribuidora de prueba',
  recipientCuit: null,
  subtotal: '100.00',
  taxes: [
    {
      kind: 'iva',
      label: 'IVA 21%',
      rate: '21.00',
      base: '100.00',
      amount: '21.00',
    },
  ],
  total: '121.00',
  cae: null,
  caeDueDate: null,
  printedDueDate: null,
  printedTermDays: null,
  lines: [],
};

describe('ExtractionCall', () => {
  let fake: FakeLlm;
  let call: ExtractionCall;
  let pages: PageImage[];

  beforeEach(() => {
    fake = new FakeLlm();
    call = new ExtractionCall(
      createAnthropicClient({ apiKey: KEY, fetch: fake.fetch }),
      MODEL,
    );
    pages = [
      { mimeType: 'image/jpeg', bytes: jpeg() },
      { mimeType: 'image/png', bytes: png() },
    ];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the pages in order, each in base64 with its media type, then the instructions, with the model, effort, max_tokens and schema', async () => {
    fake.reply(OUTPUT);
    await call.run(pages, 'high');

    expect(fake.requests).toHaveLength(1);
    const [{ url, body }] = fake.requests;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(16_000);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: pages[0].bytes.toString('base64'),
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: pages[1].bytes.toString('base64'),
            },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ]);
    const config = body.output_config as {
      effort: string;
      format: { type: string; schema: { properties: Record<string, unknown> } };
    };
    expect(config.effort).toBe('high');
    expect(config.format.type).toBe('json_schema');
    expect(Object.keys(config.format.schema.properties)).toEqual(
      Object.keys(OUTPUT),
    );
  });

  it('uses the default effort when none is passed', async () => {
    fake.reply(OUTPUT);
    await call.run(pages);
    const config = fake.requests[0].body.output_config as { effort: string };
    expect(config.effort).toBe('medium');
  });

  it('sends exactly max_tokens, messages, model and output_config', async () => {
    fake.reply(OUTPUT);
    await call.run(pages);
    expect(Object.keys(fake.requests[0].body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
    ]);
  });

  it('asks an overloaded API once, not three times', async () => {
    fake.replyStatus(529).replyStatus(529).replyStatus(529);
    const outcome = await call.run(pages);
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/^OverloadedError 529: /) as unknown,
    });
    expect(fake.requests).toHaveLength(1);
  });

  it.each(['max_tokens', 'refusal', 'model_context_window_exceeded'])(
    'fails on stop_reason %s, even with valid JSON',
    async (stopReason) => {
      fake.reply(OUTPUT, { stopReason });
      await expect(call.run(pages)).resolves.toEqual({
        ok: false,
        error: `stop_reason ${stopReason}`,
      });
    },
  );

  it('fails on a response with no text', async () => {
    fake.replyEmpty('end_turn');
    await expect(call.run(pages)).resolves.toEqual({
      ok: false,
      error: 'no structured output',
    });
  });

  it('fails on truncated JSON', async () => {
    fake.replyText(JSON.stringify(OUTPUT).slice(0, 40));
    const outcome = await call.run(pages);
    expect(outcome.ok).toBe(false);
  });

  it('fails on JSON that breaks the schema', async () => {
    fake.reply({ ...OUTPUT, type: 'receipt' });
    const outcome = await call.run(pages);
    expect(outcome.ok).toBe(false);
  });

  it('fails on a rejected key, naming the class and 401, never the key', async () => {
    fake.replyStatus(401);
    const outcome = await call.run(pages);
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/^AuthenticationError 401: /) as unknown,
    });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it('fails on a network failure', async () => {
    fake.failNetwork();
    const outcome = await call.run(pages);
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/^APIConnectionError/) as unknown,
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('returns the output, the JSON as written and the token counts', async () => {
    fake.reply(OUTPUT);
    await expect(call.run(pages)).resolves.toEqual({
      ok: true,
      output: OUTPUT,
      rawOutput: OUTPUT,
      usage: { inputTokens: 1800, outputTokens: 900 },
    });
  });

  it('keeps the JSON exactly as written, including fields the schema drops', async () => {
    const written = { ...OUTPUT, extra: 'kept' };
    fake.replyText(JSON.stringify(written));
    const outcome = await call.run(pages);
    expect(outcome.ok && outcome.rawOutput).toEqual(written);
  });

  it('ignores ANTHROPIC_BASE_URL', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://elsewhere.example.com');
    const client = createAnthropicClient({ apiKey: KEY, fetch: fake.fetch });
    fake.reply(OUTPUT);
    await new ExtractionCall(client, MODEL).run(pages);
    expect(fake.requests[0].url).toBe('https://api.anthropic.com/v1/messages');
  });
});

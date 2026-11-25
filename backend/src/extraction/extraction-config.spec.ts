import { RESTAURANT_TEST_CUIT } from '../../test/test-cuits.js';
import { ExtractionConfig } from './extraction-config.js';

describe('ExtractionConfig', () => {
  const KEY = 'sk-ant-config-test-value';

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    vi.stubEnv('LLM_MODEL', 'claude-haiku-5-5');
    vi.stubEnv('RESTAURANT_CUIT', RESTAURANT_TEST_CUIT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads valid values', () => {
    expect({ ...new ExtractionConfig() }).toEqual({
      apiKey: KEY,
      model: 'claude-haiku-5-5',
      restaurantCuit: RESTAURANT_TEST_CUIT,
    });
  });

  it.each(['ANTHROPIC_API_KEY', 'LLM_MODEL'])(
    'refuses a missing or blank %s, naming it',
    (name) => {
      vi.stubEnv(name, undefined);
      expect(() => new ExtractionConfig()).toThrow(name);
      vi.stubEnv(name, '   ');
      expect(() => new ExtractionConfig()).toThrow(name);
    },
  );

  it('never puts the key in an error', () => {
    vi.stubEnv('LLM_MODEL', '');
    expect(() => new ExtractionConfig()).toThrow(
      expect.not.objectContaining({
        message: expect.stringContaining(KEY) as unknown,
      }) as Error,
    );
  });

  it('refuses a RESTAURANT_CUIT with a wrong check digit, naming it', () => {
    const wrong = `${RESTAURANT_TEST_CUIT.slice(0, 10)}${(Number(RESTAURANT_TEST_CUIT[10]) + 1) % 10}`;
    vi.stubEnv('RESTAURANT_CUIT', wrong);
    expect(() => new ExtractionConfig()).toThrow('RESTAURANT_CUIT');
  });

  it('refuses a RESTAURANT_CUIT with hyphens', () => {
    const c = RESTAURANT_TEST_CUIT;
    vi.stubEnv(
      'RESTAURANT_CUIT',
      `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`,
    );
    expect(() => new ExtractionConfig()).toThrow('RESTAURANT_CUIT');
  });

  it('refuses a missing RESTAURANT_CUIT', () => {
    vi.stubEnv('RESTAURANT_CUIT', undefined);
    expect(() => new ExtractionConfig()).toThrow('RESTAURANT_CUIT');
  });
});

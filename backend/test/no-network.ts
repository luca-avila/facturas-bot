/**
 * Vitest setup file: backend tests never reach the network. Worker specs
 * pass a `FakeLlm` through `LLM_FETCH` instead.
 */
globalThis.fetch = () => {
  throw new Error(
    'Tests never reach the network: pass a fake through LLM_FETCH.',
  );
};

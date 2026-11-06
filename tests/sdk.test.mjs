import assert from "node:assert/strict";
import test from "node:test";

test("plugin registers with the real OpenClaw SDK without network access", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("SDK smoke must not make network requests");
  });
  const { default: plugin } = await import("../index.js");
  const providers = [];
  plugin.register({ registerVideoGenerationProvider: (provider) => providers.push(provider) });
  assert.equal(providers.length, 1);
  const [provider] = providers;
  assert.equal(provider.id, "segmind");
  assert.equal(typeof provider.generateVideo, "function");
  assert.equal(provider.isConfigured({ cfg: { plugins: { entries: { segmind: { config: { apiKey: "synthetic-key" } } } } } }), true);
  assert.ok(provider.resolveModelCapabilities({ model: "seedance-2.0" }).generate.supportedDurationSeconds.includes(5));
});

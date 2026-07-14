import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../index.js";

function providerFromPlugin() {
  let registered;
  plugin.register({
    registerVideoGenerationProvider(provider) {
      registered = provider;
    },
  });
  return registered;
}

test("provider submits, polls, and saves a generated video without real credentials", async (t) => {
  const provider = providerFromPlugin();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/seedance-2.0")) {
      return new Response(JSON.stringify({ request_id: "request-1" }), {
        headers: { "content-type": "application/json", "x-remaining-credits": "12.5" },
      });
    }
    if (String(url).endsWith("/requests/request-1/status")) {
      return new Response(JSON.stringify({ status: "COMPLETED" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).endsWith("/requests/request-1")) {
      return new Response(new Uint8Array([0, 1, 2]), {
        headers: { "content-type": "video/mp4", "x-remaining-credits": "12" },
      });
    }
    throw new Error(`Unexpected mocked URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await provider.generateVideo({
    prompt: "A short test video",
    model: "seedance-2.0",
    durationSeconds: 5,
    cfg: { plugins: { entries: { segmind: { config: { apiKey: "test-key" } } } } },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers["x-api-key"], "test-key");
  assert.equal(JSON.parse(calls[0].options.body).duration, 5);
  assert.equal(result.videos[0].mimeType, "video/mp4");
  assert.equal(result.metadata.remainingCredits, 12);
});

test("provider rejects an unsupported model before issuing a request", () => {
  const provider = providerFromPlugin();
  assert.throws(() => provider.resolveModelCapabilities({ model: "segmind/unknown" }), /не поддерживается/u);
});

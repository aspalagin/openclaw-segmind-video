const mocks = {
  "openclaw/plugin-sdk/media-store": "export async function saveMediaBuffer(buffer, mimeType, source, maxBytes, fileName) { return { path: `/tmp/${fileName}`, contentType: mimeType, id: 'mock-media', size: buffer.byteLength }; }",
  "openclaw/plugin-sdk/secret-input": "export function coerceSecretRef() { return undefined; } export function hasConfiguredSecretInput(value) { return Boolean(value); }",
  "openclaw/plugin-sdk/secret-ref-runtime": "export async function resolveSecretRefValues() { return new Map(); }",
};

export async function resolve(specifier, context, nextResolve) {
  if (mocks[specifier]) {
    return {
      url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

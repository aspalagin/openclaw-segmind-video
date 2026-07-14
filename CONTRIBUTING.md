# Contributing

Please open an issue before substantial changes. Keep provider behaviour
compatible with OpenClaw's `videoGenerationProviders` contract and add a
mocked test for every changed request or response path.

Before opening a pull request, run:

```bash
npm run check
npm test
```

Never commit API keys, tokens, generated customer media, or `.env` files.

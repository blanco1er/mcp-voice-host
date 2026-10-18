# Contributing

Thanks for helping. The project stays small on purpose: no framework, no build step, no runtime dependency.

## Setup

```sh
git clone https://github.com/blanco1er/mcp-voice-host
cd mcp-voice-host
npm test                          # Node 20+, no install needed
node bin/mcp-voice-host.mjs --demo
```

## Ground rules

- **Zero dependencies** in `bin/`, `server/` and `web/`. Dev tools (Playwright for screenshots) stay optional and outside `package.json` dependencies.
- **Browser code is plain ES modules** in `web/`, served as is. Keep anything that can be pure (protocol, lint, routing) DOM-free so it runs under `node --test`.
- **Spec first.** Protocol behavior follows the [MCP spec 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) and the [MCP Apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). Quote the section in your pull request when you change it.
- **Lint rules need a source.** Each rule in `web/lib/lint.js` cites a public page (Amazon's Alexa+ add-on docs or the MCP specs), quotes the guideline, says whether it is a heuristic, and comes with tests that show it firing and staying quiet.
- **Be honest in the UI.** If the host approximates something Amazon does not publish, say so on screen or in the README.
- **Accessibility and design.** Keep targets at 44 px on touch, contrast at WCAG AA in both themes, `prefers-reduced-motion` respected, one accent color. Run `scripts/screenshots.mjs` and look at the result before opening a pull request that touches the UI.

## Good first contributions

- Lint rules for more of Amazon's functional requirements (disambiguation, pagination, sorting).
- A Polly or other TTS example endpoint for `--tts-url`, and a Bedrock example for `--brain-url`.
- `tool-input-partial` streaming and the `pip` display mode.
- Translations of the host UI.

## Pull requests

One topic per pull request, tests included, `npm test` green. Describe what you changed, how you checked it, and what you did not check.

By contributing you agree that your contribution is licensed under the MIT License of this repository.

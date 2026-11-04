# Third-party notices

## KaTeX 0.19.1

- Project: https://katex.org/
- Source: https://github.com/KaTeX/KaTeX
- License: MIT. The original notice and license are included in [vendor/katex/LICENSE](vendor/katex/LICENSE).
- Bundled file: `vendor/katex/katex.min.js`.
- Provenance, package integrity and file hashes: [vendor/katex/SOURCE.json](vendor/katex/SOURCE.json).

LitThread uses KaTeX's public `renderToString` API to produce MathML locally. The resulting tree is parsed and rebuilt through an allowlist before insertion into Zotero. KaTeX HTML stylesheets and fonts are not bundled or fetched at runtime.

## Project license

The project's own source remains under the [MIT License](LICENSE). The existing Research Companion contributors copyright notice is retained after the LitThread rename.

Zotero is the host application and is not included in this repository or its XPI. DeepSeek is an optional external API service; no credentials are included.

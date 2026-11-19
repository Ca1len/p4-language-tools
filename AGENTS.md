# AGENTS.md

[Русская версия](AGENTS.ru.md)

P4 Language Tools is a VS Code extension for P4₁₄ and P4₁₆. Run the commands below from the repository root. The main test suite uses the built-in test runner in Node.js 20 or later. Packaging requires Python 3.

## Where to make changes

- `extension/package.json` declares VS Code commands and settings. The command handlers and the LSP client live in `extension/src/extension.js`.
- `server/src/server.js` handles LSP requests. In the same directory, `indexer.js` indexes declarations and scopes, `signatures.js` handles signatures, and `docs.js` reads documentation comments. Check both client and server when changing a request or notification. The server uses stdout for JSON-RPC and stderr for debug messages.
- `extension/syntaxes/p4.tmLanguage.json` defines the TextMate grammar. `server/src/semantic.js` classifies identifiers using their declarations. Test both dialects when changing shared logic. The bundled ANTLR parser handles P4₁₆.
- `server/compiler.js` runs the external compiler and parses its output. `server/src/server.js` combines the results with editor diagnostics and publishes them to VS Code.

## Editor and compiler behavior

Navigation, hints, and diagnostics as you type use the current contents of open buffers. The compiler reads files from disk and uses the configured entry point. Run the external compiler only in a trusted workspace, passing arguments as an array with `shell: false`.

Report each diagnostic against the file named by the compiler. An included file may be closed in the editor. LSP line and character positions start at zero, and character offsets count UTF-16 code units. When adding a compiler output format, add a sample to `server/compiler.test.js` and check the exact text the diagnostic highlights. Messages without a source location remain in the **P4 Compiler** output channel.

## Testing

The main suite runs unit tests and starts a separate LSP process. Client tests mock the VS Code API. Compiler tests use a fixture executable.

```sh
node --test server/compiler.test.js server/test/*.test.js test/*.test.js extension/test/*.test.js
```

Choose additional checks based on the change.

- For TextMate grammar changes, run `(cd test/textmate && npm ci && npm test)`.
- To test diagnostics with real compilers, point `P4TEST_16` and `P4TEST_14` at the respective executables and run `node --test test/real-compiler.cjs`. The test skips each dialect whose variable is unset.
- To test the installed extension, build the VSIX and run the scenario for desktop VS Code or VS Code Server. [Instructions for both environments](test/vscode/README.md).

## Packaging and releases

Run `python3 build_vsix.py` to create a VSIX in the repository root. The script reads the version from `extension/package.json` and packages `extension/README.md`. When changing user-facing features, update the packaged README, the root `README.md`, and its Russian translation, `README.ru.md`. Attach the built VSIX to the GitHub Release for the corresponding tag. The `*.vsix` pattern in `.gitignore` keeps local builds out of commits.

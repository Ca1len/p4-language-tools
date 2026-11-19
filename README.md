# P4 Language Tools 0.3.2

[Русская версия](README.ru.md)

A VS Code extension for P4₁₄ and P4₁₆ with a language server that communicates over stdio. Open your project folder to navigate between files and get completions and signature help. The editor uses your configured SDK include paths even when compiler diagnostics are turned off.

## Installation

Download [p4-language-tools-0.3.2.vsix](https://github.com/Ca1len/p4-language-tools/releases/download/v0.3.2/p4-language-tools-0.3.2.vsix) and run the following command from the download directory. To build the extension from source, run `python3 build_vsix.py` from the repository root.

```sh
code --install-extension ./p4-language-tools-0.3.2.vsix
```

You can also choose **Extensions → … → Install from VSIX**. The package includes both the client and the server. It requires VS Code 1.75 or later and supports both desktop and remote extension hosts. If you are comparing P4 extensions, enable one at a time in the workspace so you can tell which one provides each suggestion.

## Syntax highlighting in 0.3

Highlighting starts as soon as you open a file. The TextMate grammar recognizes keywords, literals such as `16w0x0800`, directives, annotations, and comments in both dialects. Semantic highlighting uses declarations in the current file and its included headers to classify names. For example, `tag` in `frame.tag` is a `property`, and an action name at a call site is a `function`. Tables and parser states have their own token types, `p4Table` and `p4ParserState`.

Your theme sets the colors. Run **Developer: Inspect Editor Tokens and Scopes** to see the token type under the cursor. If some colors are hard to tell apart, you can override them just for P4. This example uses colors for a dark theme.

```json
{
  "editor.semanticTokenColorCustomizations": {
    "rules": {
      "property:p4": "#6DD9CB",
      "parameter:p4": "#F1AE79",
      "function:p4": "#DCDCAA",
      "p4Table:p4": "#BB9AF7",
      "p4ParserState:p4": "#82AAFF"
    }
  }
}
```

If you are switching from another P4 extension, select **Disable (Workspace)** on that extension so that only one extension supplies the grammar and definitions for `p4`. The syntax grammar is adapted from the Apache-licensed [zhanghanwang.p4-lang](https://github.com/RabbitWhite1/p4-lang-vscode). The P4₁₆ ANTLR parser and table snippet come from [fattaholmanan/p4-vscode-extension](https://github.com/fattaholmanan/p4-vscode-extension). Hovering over an enum member shows its explicitly assigned value, a feature implemented independently following the example of [LivingThings.p4](https://github.com/zznobodyzz/vscode-p4-extention). The package includes upstream revisions and licenses.

## Editor features

| Feature | How to use it |
|---|---|
| Signature help | Type `set_port(` or press **Ctrl+Shift+Space** inside a call. Typing a comma highlights the next parameter. Its description comes from the corresponding `@param` tag when available. |
| Parameter name hints | Enable **Editor: Inlay Hints** to see labels such as `port:` beside positional arguments when the signature identifies the parameter unambiguously. |
| Hover documentation | Hover over a name at a call site to see the original signature and the comment preceding the declaration. This works with unsaved edits in included files. The server recognizes `///`, `//!`, block comments, Doxygen tags, and `@brief("…")` and `@description("…")` annotations. |
| Navigation | Press **F12** on a name to open its declaration or on a literal `#include` path to open the file. Use **Go to Type Definition** on a variable or field with a known type, or **Shift+F12** to find references. |
| Field and method completion | Type a dot after a header, struct, or instance of a known extern. Completion works with typed parameters, chained field access, some typedefs, and header stacks. In P4₁₄ it also resolves fields on `header` and `metadata` instances. |
| Workspace text search | Run **P4: Find Identifier in Workspace Text** from the Command Palette or context menu to find whole-identifier matches, including in comments and directives. Results show file paths, line numbers, and snippets. Select a result to open the file. The extension uses `rg` when available on its `PATH` and falls back to a built-in search. |
| Include path fixes | Press **Ctrl+.** on an unresolved include. If the project folder contains a P4 file with the same filename, you can select its suggested relative path. |
| Formatting and renaming | **Format Document** adjusts indentation using your editor settings. **F2** can rename scalar locals in a simple action body that contains no nested blocks or calls. Parameters, global names, and fields are outside the supported rename scope. |

For P4₁₆, the server reads signatures for functions, actions, constructors, and known extern methods. For P4₁₄, it reads `action` and `primitive_action` declarations and knows several standard primitives, including `modify_field` with and without a mask. It selects overloads using the available declarations, receiver type, argument names, and argument count. If several signatures fit, you can browse the candidates.

For function-like SDK macros, **F12**, hover, and signature help use the source `#define`. Conditional branches can yield more than one declaration. Signature help for the built-in P4₁₆ header methods (`isValid()`, `setValid()`, and `setInvalid()`) and for `table.apply()` works without a source declaration.

Workspace text search returns up to 250 matches and gives open buffers priority. It skips build directories and files larger than 2 MiB on disk. The workspace index lists up to 5,000 source files. If `rg` is unavailable, the built-in search skips hidden directories and does not apply `.gitignore` rules.

## SDK and compiler settings

If your code uses `#include <vendor.p4>`, add **the directory containing `vendor.p4`** to `p4.compiler.includePaths` in `.vscode/settings.json`. Use separate VS Code windows for projects that need different compiler settings. Adjust the paths below for your project.

```json
{
  "p4.compiler.includePaths": ["include", "/opt/vendor/share/p4include"],
  "p4.compiler.language": "p4-16",
  "p4.compiler.enabled": true,
  "p4.compiler.path": "p4test",
  "p4.compiler.entrypoint": "src/main.p4",
  "p4.compiler.args": ["-DPROJECT_FEATURE=1"],
  "p4.compiler.timeoutMs": 15000
}
```

The extension bundles reference copies of `core.p4`, `v1model.p4`, `psa.p4` (BMv2), and `pna.p4` for P4₁₆. The editor searches your configured include directories first. The compiler uses its own SDK and your project's compiler settings.

For a P4₁₄ project, set `"p4.compiler.language": "p4-14"`. In `auto` mode, the server recognizes the `.p4_14` and `.p4_16` extensions and looks for declarations specific to P4₁₄. It defaults to P4₁₆ when the dialect is ambiguous.

As you type, the editor reports structural errors such as unmatched brackets and missing local includes. For P4₁₆, an ANTLR parser also checks the syntax of the unsaved buffer. The server skips this pass for files with unresolved conditional branches, unsupported directives, or more than 524,288 UTF-16 code units. If your SDK uses a custom dialect or macros whose expansion changes the syntax, you can disable this pass with `"p4.syntaxDiagnostics.enabled": false` and use the compiler to validate the program.

Enable compiler diagnostics with `"p4.compiler.enabled": true`. When you save a P4 file, the server runs the compiler specified by `p4.compiler.path` on the configured entry point. If the entry point is empty, it checks the file you saved. Use **Save All** to include edits from other files in the same run. P4₁₄ requires a compiler built with support for that dialect. VS Code disables external compilation in Restricted Mode.

Errors and warnings with source locations appear in the **Problems** panel (`Ctrl+Shift+M`), in the editor, and in the file tree. For example, given `switch.p4(57):syntax error, unexpected IDENTIFIER, expecting APPLY`, the server reads line 57 from the message and uses the `^^^^` marker beneath the source excerpt to underline the token. Select the diagnostic in **Problems** to open the file the compiler reported, including files reached through `#include`. A successful rebuild clears previous compiler errors for that entry point.

Run **P4: Check Project** from the Command Palette to start the same check manually. With `p4.compiler.entrypoint` set in a single-folder workspace, you can run the command with no P4 file open. If you leave the setting empty, open the saved P4 file you want to check. If the workspace folder contains unsaved P4 files, choose **Save and Check** to save them and run the compiler once.

For an underlined `example_table_key.aply`, press **Ctrl+.** and select **Replace 'aply' with 'apply'**. This quick fix is available for a saved file when the compiler points to the `aply` token and reports `expecting APPLY`.

Expand a diagnostic in **Problems** to see related locations reported by p4c. For example, an argument type error can link a call to a declaration in another file. **P4: Show Compiler Output** opens the log with the entry point, compiler output, and exit code for each run. It also shows backend messages without a line number. The output limit is 4 MiB per run.

## How the language server analyzes P4

The server tracks macro definitions and undefinitions from `-D`, `-U`, and available headers. It preserves source locations, skips branches it can prove inactive, and keeps the alternatives when a condition is unknown. It indexes tokens, declarations, scopes, and literal `#include` paths. Its analysis covers a subset of C preprocessing and P4 type resolution, so it cannot evaluate every `#if` condition or build the compiler's typed intermediate representation. Macros, some generic types, and architecture-specific extensions can yield several candidate declarations or remain unresolved. Use workspace text search to inspect those cases. Signature help and hover documentation work independently of p4c.

## Building from source

Use Node.js 20 or later to run the tests and Python 3 to build the VSIX. Run these commands from the repository root.

```sh
node --test server/compiler.test.js server/test/*.test.js test/*.test.js extension/test/*.test.js
python3 build_vsix.py
```

The test suite starts a separate language server process, exercises the client with a simulated VS Code API, and uses a test executable for compiler diagnostics. For additional checks or to rebuild the parser, use the following commands.

- **TextMate scopes** — Run `(cd test/textmate && npm ci && node --test grammar.test.js)` to exercise the grammar with TextMate.
- **Desktop VS Code** — Run `python3 test/vscode/run.py /path/to/extension.vsix` to test the packaged extension in a temporary profile.
- **Real compilers** — Set `P4TEST_16` and `P4TEST_14` to the paths of the corresponding compiler executables, then run `node --test test/real-compiler.cjs`.
- **ANTLR parser** — The package includes a prebuilt parser. To rebuild it using the checked-in `server/vendor-antlr/source/package-lock.json`, run `(cd server/vendor-antlr/source && npm ci && npm run build)`.

To inspect or restart the running server, use **P4: Show Language Server Output** or **P4: Restart Language Server** from the Command Palette.

## Licenses

P4 Language Tools is released under the [MIT License](LICENSE). The repository includes license and attribution information for its third-party components.

- [Syntax highlighting grammar and snippets](extension/third-party/p4-syntax/NOTICE.txt)
- [P4₁₆ grammar and ANTLR runtime](server/vendor-antlr/NOTICE.txt)
- [Standard P4 headers](server/p4include/sources.json) and [their license](server/p4include/LICENSE)

// Generated classes from fattaholmanan/p4-vscode-extension at the revision in NOTICE.txt.
// buildParseTrees is disabled here because the editor only consumes syntax errors.
import { BaseErrorListener, CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { P4Parser } from './generated/P4Parser';
import { P4Lexer } from './generated/P4Lexer';

export function parse(source: string, report: (line: number, column: number, width: number, message: string) => void) {
  class Listener extends BaseErrorListener {
    override syntaxError(_recognizer: unknown, token: Token | null, line: number, column: number, message: string): void {
      // ANTLR columns and token offsets count code points, including for the lexer.
      const width = token && token.type !== Token.EOF ? Math.max(1, token.stop - token.start + 1) : 1;
      report(line - 1, column, width, message);
    }
  }
  const listener = new Listener();
  const lexer = new P4Lexer(CharStream.fromString(source));
  lexer.removeErrorListeners();
  lexer.addErrorListener(listener);
  const parser = new P4Parser(new CommonTokenStream(lexer));
  parser.removeErrorListeners();
  parser.addErrorListener(listener);
  parser.buildParseTrees = false;
  parser.program();
}

/**
 * A conservative shell-line reader for the `guard` hook: splits a command on unquoted `&&`, `||`, `;`, `|`, `&` and
 * newlines, strips quotes, drops redirections and reads each segment's `VAR=value` prefixes. Anything it cannot read
 * with confidence (command substitution, subshells, here-documents, unbalanced quotes) makes the whole line
 * `ambiguous`, and the guard then allows it: runScript stays the authority (RFC 0004 §7.1 H4).
 */

/** `{ segments: [{ words: string[] }] }`, or `{ ambiguous: true }`. */
export function splitShell(line) {
  const text = String(line ?? "");
  const segments = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push({ words });
    words = [];
  };
  let skipNextWord = false;
  const takeWord = () => {
    if (skipNextWord && inWord) {
      word = "";
      inWord = false;
      skipNextWord = false;
      return;
    }
    endWord();
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "`" || (c === "$" && text[i + 1] === "(")) return { ambiguous: true };
      else if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < text.length && text[i + 1] !== "\n") {
        word += text[++i];
        inWord = true;
      } else i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "`" || c === "(" || c === ")" || (c === "$" && text[i + 1] === "(")) return { ambiguous: true };
    if (c === "<" && text[i + 1] === "<") return { ambiguous: true };
    if (c === ">" || c === "<" || (c === "&" && text[i + 1] === ">")) {
      // A redirection: drop an adjacent fd number, the operator and its target word.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else takeWord();
      if (c === "&") i++;
      while (text[i + 1] === ">" || text[i + 1] === "<") i++;
      if (text[i + 1] === "&") {
        i++;
        while (/\d|-/.test(text[i + 1] ?? "")) i++;
        continue;
      }
      skipNextWord = true;
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if ((c === "&" || c === "|") && text[i + 1] === c) i++;
      takeWord();
      endSegment();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      takeWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) return { ambiguous: true };
  takeWord();
  endSegment();
  return { segments };
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/** A segment's leading `VAR=value` words (also after `env`), and the words of the command itself. */
export function commandOf(words) {
  const env = {};
  let i = 0;
  const assignments = () => {
    for (let match; i < words.length && (match = ASSIGNMENT.exec(words[i])); i++) env[match[1]] = match[2];
  };
  assignments();
  if (words[i] === "env") {
    i++;
    if (words[i]?.startsWith("-")) return { env, words: [], opaque: true };
    assignments();
  }
  while (["time", "nohup", "command"].includes(words[i])) i++;
  return { env, words: words.slice(i) };
}

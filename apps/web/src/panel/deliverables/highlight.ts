import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { HIGHLIGHT_MAX_CHARS } from './deliverables-model.js';

/**
 * The viewer's syntax highlighting (P9-09; TECHNOLOGY §9.5): highlight.js's core with a fixed set
 * of languages, part of the viewer's lazily loaded chunk. Its output is HTML the library escapes
 * (every character of the source is text in it); `highlight` returns `undefined` when the file
 * has no known language or is too large to highlight, and the viewer shows it as plain text.
 */
const LANGS = {
  bash,
  c,
  cpp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  makefile,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, fn] of Object.entries(LANGS)) hljs.registerLanguage(name, fn);

export function highlight(text: string, language: string | undefined): string | undefined {
  if (!language || text.length > HIGHLIGHT_MAX_CHARS || !hljs.getLanguage(language)) {
    return undefined;
  }
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}

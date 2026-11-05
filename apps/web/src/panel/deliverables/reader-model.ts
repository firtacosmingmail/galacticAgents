import { extensionOf, isMarkdownPath, safeLink } from './deliverables-model.js';

/**
 * The reader's pure parts (P8-25, SPEC decision 151): which view a file gets, JSON and XML
 * re-indented for reading, and the document an HTML file is rendered from.
 */

/**
 * How the viewer shows a text file: Markdown and HTML rendered (with a "Source" switch), JSON and
 * XML formatted (with a "Source" switch), everything else as highlighted code.
 */
export type ReaderKind = 'markdown' | 'html' | 'json' | 'xml' | 'code';

const XML_EXTENSIONS = new Set(['xml', 'xsd', 'xsl', 'xslt', 'plist', 'rss', 'atom', 'wsdl']);

export function readerKindOf(path: string): ReaderKind {
  if (isMarkdownPath(path)) return 'markdown';
  const ext = extensionOf(path);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'json') return 'json';
  if (XML_EXTENSIONS.has(ext)) return 'xml';
  return 'code';
}

/** The two views of a kind, the first one shown by default; `code` has one. */
export function readerViews(kind: ReaderKind): readonly [string, string] | undefined {
  if (kind === 'markdown' || kind === 'html') return ['Rendered', 'Source'];
  if (kind === 'json' || kind === 'xml') return ['Formatted', 'Source'];
  return undefined;
}

const INDENT = '  ';

/**
 * JSON re-indented by two spaces, or `undefined` when it is not valid JSON. The text is
 * re-spaced token by token, never parsed into values and printed again, so every string and number
 * stays exactly as written (`12345678901234567890` is not rounded, `1.0` stays `1.0`).
 */
export function formatJson(text: string): string | undefined {
  const src = text.replace(/^\uFEFF/, '');
  try {
    JSON.parse(src);
  } catch {
    return undefined;
  }
  let out = '';
  let depth = 0;
  const line = () => `\n${INDENT.repeat(depth)}`;
  for (let i = 0; i < src.length;) {
    const ch = src[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i++;
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] === close) {
        out += ch + close;
        i = j + 1;
      } else {
        depth++;
        out += ch + line();
        i++;
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
      out += line() + ch;
      i++;
    } else if (ch === ',') {
      out += `,${line()}`;
      i++;
    } else if (ch === ':') {
      out += ': ';
      i++;
    } else {
      // A literal: a number, true, false or null, copied as written.
      let j = i;
      while (j < src.length && !/[\s,:[\]{}"]/.test(src[j]!)) j++;
      out += src.slice(i, j);
      i = j;
    }
  }
  return out;
}

/**
 * XML re-indented by two spaces, or `undefined` when it is not well-formed. Parsed inert with
 * `DOMParser` (no script runs, nothing is fetched); whitespace-only text between elements is
 * dropped, an element holding only text stays on one line, and the `<?xml …?>` declaration is kept.
 */
export function formatXml(text: string): string | undefined {
  const src = text.replace(/^\uFEFF/, '');
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return undefined;
  const lines: string[] = [];
  const declaration = /^\s*(<\?xml[\s\S]*?\?>)/.exec(src)?.[1];
  if (declaration) lines.push(declaration);
  for (const node of Array.from(doc.childNodes)) writeXml(node, 0, lines);
  return lines.join('\n');
}

const serializer = () => new XMLSerializer();

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

function writeXml(node: Node, depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);
  switch (node.nodeType) {
    case Node.ELEMENT_NODE: {
      const el = node as Element;
      const attrs = Array.from(el.attributes)
        .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
        .join('');
      const kids = Array.from(el.childNodes).filter(
        (k) => !(k.nodeType === Node.TEXT_NODE && !k.nodeValue?.trim()),
      );
      if (kids.length === 0) {
        lines.push(`${pad}<${el.tagName}${attrs}/>`);
      } else if (kids.length === 1 && kids[0]!.nodeType === Node.TEXT_NODE) {
        lines.push(
          `${pad}<${el.tagName}${attrs}>${escapeText(kids[0]!.nodeValue!.trim())}</${el.tagName}>`,
        );
      } else {
        lines.push(`${pad}<${el.tagName}${attrs}>`);
        for (const k of kids) writeXml(k, depth + 1, lines);
        lines.push(`${pad}</${el.tagName}>`);
      }
      return;
    }
    case Node.TEXT_NODE: {
      const t = node.nodeValue?.trim();
      if (t) lines.push(pad + escapeText(t));
      return;
    }
    default:
      // A comment, CDATA section, processing instruction or doctype, as the serializer writes it.
      lines.push(pad + serializer().serializeToString(node));
  }
}

/**
 * What the rendered HTML frame loads nothing with (decision 151): no script, no network — inline
 * styles and `data:` images and fonts only. Set in the document itself, so it holds wherever the
 * frame runs, on top of the policy the frame inherits from the panel.
 */
export const HTML_FRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/** The frame's sandbox: no scripts, an opaque origin, forms off; a link may open a new tab. */
export const HTML_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * The document an HTML deliverable is rendered from (P8-25, decision 151), made from an inert
 * parse (`DOMParser`: no script runs, nothing is fetched): the policy above first in its head, its
 * `meta refresh` removed (it would load an address by itself), and its links kept only for
 * http(s) and mailto — opening in a new tab — or as in-page `#` anchors; the rest lose their
 * address, as Markdown's do.
 */
export function htmlFrameDocument(text: string): string {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  for (const meta of Array.from(doc.querySelectorAll('meta[http-equiv]'))) {
    if (meta.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') meta.remove();
  }
  for (const base of Array.from(doc.querySelectorAll('base'))) base.remove();
  for (const a of Array.from(doc.querySelectorAll('a[href], area[href]'))) {
    const href = a.getAttribute('href')!.trim();
    if (href.startsWith('#')) {
      a.setAttribute('target', '_self');
      continue;
    }
    const safe = safeLink(href);
    if (safe) {
      a.setAttribute('href', safe);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  }
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', HTML_FRAME_CSP);
  doc.head.prepend(csp);
  const type = doc.doctype;
  const doctype = type
    ? `<!DOCTYPE ${type.name}${type.publicId ? ` PUBLIC "${type.publicId}"` : ''}${
        type.systemId ? `${type.publicId ? '' : ' SYSTEM'} "${type.systemId}"` : ''
      }>`
    : '';
  return doctype + doc.documentElement.outerHTML;
}

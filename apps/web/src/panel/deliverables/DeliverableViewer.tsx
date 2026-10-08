import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import type { DeliverableListItem } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { useApi } from '../../console/hierarchy/shared.js';
import {
  imageTypeOf,
  isMarkdownPath,
  languageOf,
  mediaType,
  safeLink,
  SVG_TYPE,
} from './deliverables-model.js';
import { highlight } from './highlight.js';
import { svgPreview } from './svg-image.js';

/**
 * The viewer (P9-09; SPEC decisions 125, 126; TECHNOLOGY §9.5), loaded lazily with
 * `react-markdown` and `highlight.js` so the panel's first load does not carry them. It shows the
 * file as it is now, read with the bearer token (never a token in an address):
 *
 * - text and code with highlighting chosen by the extension (escaped by highlight.js; past
 *   `HIGHLIGHT_MAX_CHARS` plain), an HTML file as its source;
 * - Markdown rendered without its raw HTML, its links kept only for http(s) and mailto and opened
 *   in a new tab with `noopener`, its images never loaded (their alt text, and a link for a web
 *   address), with a "Source" switch;
 * - an image from a `blob:` URL made with an allow-listed raster type, in an `<img>` only; an SVG
 *   never from a `blob:` URL (it would be a document of the panel's origin in a new tab, wave-3
 *   review B1): rasterised to a PNG, else from its opaque-origin `data:` URL (`svg-image.ts`);
 * - "first 2 MB" when the server cut the text (`X-Truncated`); a refusal (too large, missing,
 *   changed) in words, with Open / Download left to the row.
 */

type Shown =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; tooLarge: boolean }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; url: string }
  | { kind: 'none'; why: string };

export default function DeliverableViewer({
  row,
  onClose,
  actions,
}: {
  row: DeliverableListItem;
  onClose: () => void;
  /** The row's Open / Download, repeated in the viewer's bar. */
  actions?: ReactNode;
}) {
  const api = useApi();
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const [source, setSource] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const path = row.location?.path ?? row.title;
  const markdown = isMarkdownPath(path);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    let url: string | undefined;
    let revoke: (() => void) | undefined;
    api.deliverableContent(row.id).then(
      async (content) => {
        if (!live) return;
        const image = imageTypeOf(content.contentType);
        if (image === SVG_TYPE) {
          const svg = await svgPreview(content.bytes);
          if (!live) {
            svg.revoke?.();
            return;
          }
          revoke = svg.revoke;
          setShown({ kind: 'image', url: svg.url });
        } else if (image) {
          // An explicit, allow-listed type: never HTML, never sniffed.
          url = URL.createObjectURL(new Blob([content.bytes], { type: image }));
          setShown({ kind: 'image', url });
        } else if (mediaType(content.contentType) === 'text/plain') {
          setShown({
            kind: 'text',
            text: new TextDecoder('utf-8').decode(content.bytes),
            truncated: content.truncated,
          });
        } else {
          setShown({ kind: 'none', why: 'This file has no preview: open or download it.' });
        }
      },
      (e: unknown) => {
        if (!live) return;
        const tooLarge = e instanceof ApiError && e.code === 'too_large';
        setShown({
          kind: 'error',
          tooLarge,
          message: tooLarge
            ? 'Too large to preview here: open or download it.'
            : e instanceof ApiError && e.status === 410
              ? `It cannot be read: ${e.message}`
              : `Could not read it: ${(e as Error).message}`,
        });
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      revoke?.();
    };
  }, [api, row.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <section
      className="dlv-viewer"
      aria-label={`preview of ${row.title}`}
      onKeyDown={onKeyDown}
      data-testid="deliverable-viewer"
    >
      <div className="dlv-viewer-bar">
        <h4 className="dlv-viewer-title" ref={heading} tabIndex={-1}>
          {row.title}
        </h4>
        {shown.kind === 'text' && markdown && (
          <span className="sts-toggle" role="group" aria-label="rendered or source">
            <button
              type="button"
              className={`sts-toggle-option${!source ? ' is-on' : ''}`}
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              Rendered
            </button>
            <button
              type="button"
              className={`sts-toggle-option${source ? ' is-on' : ''}`}
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              Source
            </button>
          </span>
        )}
        <span className="pnl-spacer" />
        {actions}
        <button type="button" className="secondary" onClick={onClose}>
          Close preview
        </button>
      </div>
      {shown.kind === 'loading' && <p className="muted">Reading…</p>}
      {shown.kind === 'error' && (
        <p
          className={shown.tooLarge ? 'muted' : 'error'}
          role={shown.tooLarge ? undefined : 'alert'}
        >
          {shown.message}
        </p>
      )}
      {shown.kind === 'none' && <p className="muted">{shown.why}</p>}
      {shown.kind === 'image' && (
        <div className="dlv-image">
          <img src={shown.url} alt={row.description ?? row.title} />
        </div>
      )}
      {shown.kind === 'text' && (
        <>
          {shown.truncated && (
            <p className="dlv-truncated" role="note">
              Showing the first 2 MB: the file is longer. Download it, or open it on the Mac, for
              the whole file.
            </p>
          )}
          {markdown && !source ? (
            <MarkdownView text={shown.text} />
          ) : (
            <CodeView text={shown.text} language={languageOf(path)} />
          )}
        </>
      )}
    </section>
  );
}

/** Code and text: highlight.js's escaped HTML, or the text as text. */
function CodeView({ text, language }: { text: string; language: string | undefined }) {
  // Highlighting a large file is the viewer's costliest step: once per text and language.
  const html = useMemo(() => highlight(text, language), [text, language]);
  return (
    <pre className="dlv-code" tabIndex={0} aria-label="file contents">
      {html !== undefined ? (
        // The library's output: every character of the file is escaped text in it (a test checks
        // that a `<script>` in a source file comes out as text). The viewer's only raw HTML.
        <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{text}</code>
      )}
    </pre>
  );
}

/** Markdown links: only http(s) and mailto, in a new tab, with `noopener`; the rest as text. */
const components: Components = {
  a: ({ href, children }) => {
    const safe = safeLink(href);
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="dlv-md-nolink">{children}</span>
    );
  },
  // Images are never loaded (decision 126): a remote one would tell its server the file was
  // opened, a relative one is another file. Their alt text shows, and a web address as a link.
  img: ({ alt, src }) => {
    const safe = typeof src === 'string' ? safeLink(src) : undefined;
    return (
      <span className="dlv-md-img">
        [image{alt ? `: ${alt}` : ''}]
        {safe && safe.startsWith('http') && (
          <>
            {' '}
            <a href={safe} target="_blank" rel="noopener noreferrer">
              (image address)
            </a>
          </>
        )}
      </span>
    );
  },
};

/** Keeps a URL only when it is a link the viewer may show (`''` drops it). */
const urlTransform = (url: string) => safeLink(url) ?? '';

function MarkdownView({ text }: { text: string }) {
  return (
    <div className="dlv-markdown">
      <Markdown skipHtml urlTransform={urlTransform} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

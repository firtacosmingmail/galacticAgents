import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DeliverableListItem } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { useApi } from '../../console/hierarchy/shared.js';
import { imageTypeOf, languageOf, mediaType, safeLink, SVG_TYPE } from './deliverables-model.js';
import { highlight } from './highlight.js';
import {
  formatJson,
  formatXml,
  HTML_FRAME_SANDBOX,
  htmlFrameDocument,
  readerKindOf,
  readerViews,
} from './reader-model.js';
import { svgPreview } from './svg-image.js';

/**
 * The viewer (P9-09; SPEC decisions 125, 126; TECHNOLOGY §9.5), loaded lazily with
 * `react-markdown` and `highlight.js` so the panel's first load does not carry them. It shows the
 * file as it is now, read with the bearer token (never a token in an address):
 *
 * - text and code with highlighting chosen by the extension (escaped by highlight.js; past
 *   `HIGHLIGHT_MAX_CHARS` plain) and line numbers;
 * - Markdown rendered with GitHub's extensions (tables, task lists, strikethrough, P8-25) and its
 *   code blocks highlighted, without its raw HTML, its links kept only for http(s) and mailto and
 *   opened in a new tab with `noopener`, its images never loaded (their alt text, and a link for a
 *   web address), with a "Source" switch;
 * - JSON and XML formatted for reading (P8-25, `reader-model.ts`), with a "Source" switch; one
 *   that does not parse shows as written and says so;
 * - an HTML file rendered as a static page (P8-25, decision 151): in a sandboxed frame with no
 *   scripts and an opaque origin, from a document whose own policy loads nothing from the network
 *   (`htmlFrameDocument`), with a "Source" switch;
 * - "Expand" moves the viewer into a large reader over the page (a modal dialog), Escape back;
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
  // The second of the kind's two views ("Source"), when it has two.
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const path = row.location?.path ?? row.title;
  const kind = readerKindOf(path);
  const views = readerViews(kind);

  useEffect(() => {
    heading.current?.focus();
  }, [expanded]);

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
    // In the large reader, Escape goes back to the panel's preview first.
    if (expanded) setExpanded(false);
    else onClose();
  };

  const viewer = (
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
        {shown.kind === 'text' && views && (
          <span
            className="sts-toggle"
            role="group"
            aria-label={`${views[0].toLowerCase()} or source`}
          >
            <button
              type="button"
              className={`sts-toggle-option${!source ? ' is-on' : ''}`}
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              {views[0]}
            </button>
            <button
              type="button"
              className={`sts-toggle-option${source ? ' is-on' : ''}`}
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              {views[1]}
            </button>
          </span>
        )}
        <span className="pnl-spacer" />
        {(shown.kind === 'text' || shown.kind === 'image') && (
          <button
            type="button"
            className="secondary"
            aria-pressed={expanded}
            onClick={() => setExpanded((x) => !x)}
          >
            {expanded ? 'Back to the panel' : 'Expand'}
          </button>
        )}
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
          <TextView
            text={shown.text}
            kind={kind}
            source={source}
            language={languageOf(path)}
            title={row.title}
          />
        </>
      )}
    </section>
  );

  return expanded ? (
    <ReaderDialog title={row.title} onBack={() => setExpanded(false)}>
      {viewer}
    </ReaderDialog>
  ) : (
    viewer
  );
}

/**
 * The large reader (P8-25): the viewer in a modal dialog over the page — the page behind is inert,
 * the dialog's own Escape (its `cancel`) goes back to the panel's preview.
 */
function ReaderDialog({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    // jsdom has no showModal: there the dialog is only opened.
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dlv-reader"
      aria-label={`reader: ${title}`}
      onCancel={(e) => {
        e.preventDefault();
        onBack();
      }}
    >
      {children}
    </dialog>
  );
}

/** A text file in the view its kind and the switch call for. */
function TextView({
  text,
  kind,
  source,
  language,
  title,
}: {
  text: string;
  kind: ReturnType<typeof readerKindOf>;
  source: boolean;
  language: string | undefined;
  title: string;
}) {
  const formatted = useMemo(
    () =>
      source
        ? undefined
        : kind === 'json'
          ? formatJson(text)
          : kind === 'xml'
            ? formatXml(text)
            : undefined,
    [text, kind, source],
  );
  if (!source && kind === 'markdown') return <MarkdownView text={text} />;
  if (!source && kind === 'html') return <HtmlFrame text={text} title={title} />;
  if (!source && (kind === 'json' || kind === 'xml')) {
    if (formatted === undefined) {
      return (
        <>
          <p className="dlv-truncated" role="note">
            {kind === 'json'
              ? 'This is not valid JSON, so it is shown as written.'
              : 'This is not well-formed XML, so it is shown as written.'}
          </p>
          <CodeView text={text} language={language} />
        </>
      );
    }
    return <CodeView text={formatted} language={kind} />;
  }
  return <CodeView text={text} language={language} />;
}

/**
 * An HTML file rendered as a static page (P8-25, decision 151): a sandboxed frame — no scripts,
 * an opaque origin that cannot reach the panel or its token — whose document loads nothing from
 * the network (`htmlFrameDocument`). Links to the web open in a new tab.
 */
function HtmlFrame({ text, title }: { text: string; title: string }) {
  const doc = useMemo(() => htmlFrameDocument(text), [text]);
  return (
    <iframe
      className="dlv-html"
      title={`rendered ${title}`}
      sandbox={HTML_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={doc}
    />
  );
}

/**
 * Code and text: highlight.js's escaped HTML, or the text as text, with line numbers (P8-25) in a
 * gutter that scrolls with the code and stays in view when it scrolls sideways.
 */
function CodeView({ text, language }: { text: string; language: string | undefined }) {
  // Highlighting a large file is the viewer's costliest step: once per text and language.
  const html = useMemo(() => highlight(text, language), [text, language]);
  const numbers = useMemo(() => {
    const count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join('\n');
  }, [text]);
  return (
    <div className="dlv-code" tabIndex={0} role="region" aria-label="file contents">
      <div className="dlv-gutter" aria-hidden="true">
        {numbers}
      </div>
      <pre>
        {html !== undefined ? (
          // The library's output: every character of the file is escaped text in it (a test
          // checks that a `<script>` in a source file comes out as text). The viewer's only raw
          // HTML outside the sandboxed HTML frame.
          <code
            className={`hljs language-${language}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code>{text}</code>
        )}
      </pre>
    </div>
  );
}

/** A Markdown code block highlighted by its fence's language, when the viewer knows it. */
function MarkdownCode({
  className,
  children,
}: {
  className?: string | undefined;
  children?: ReactNode;
}) {
  const language = /language-([\w+#-]+)/.exec(className ?? '')?.[1]?.toLowerCase();
  const text = typeof children === 'string' ? children.replace(/\n$/, '') : undefined;
  const html = useMemo(
    () => (language && text !== undefined ? highlight(text, language) : undefined),
    [language, text],
  );
  return html !== undefined ? (
    <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <code className={className}>{children}</code>
  );
}

/** Markdown links: only http(s) and mailto, in a new tab, with `noopener`; the rest as text. */
const components: Components = {
  code: ({ className, children }) => <MarkdownCode className={className}>{children}</MarkdownCode>,
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
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

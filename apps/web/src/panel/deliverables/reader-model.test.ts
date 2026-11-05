// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  formatJson,
  formatXml,
  HTML_FRAME_CSP,
  htmlFrameDocument,
  readerKindOf,
  readerViews,
} from './reader-model.js';

describe('readerKindOf (P8-25)', () => {
  it('picks the view by extension', () => {
    expect(readerKindOf('docs/README.md')).toBe('markdown');
    expect(readerKindOf('out/report.HTML')).toBe('html');
    expect(readerKindOf('index.htm')).toBe('html');
    expect(readerKindOf('data.json')).toBe('json');
    expect(readerKindOf('pom.xml')).toBe('xml');
    expect(readerKindOf('Info.plist')).toBe('xml');
    expect(readerKindOf('main.ts')).toBe('code');
    expect(readerKindOf('settings.jsonc')).toBe('code');
    expect(readerViews('html')).toEqual(['Rendered', 'Source']);
    expect(readerViews('json')).toEqual(['Formatted', 'Source']);
    expect(readerViews('code')).toBeUndefined();
  });
});

describe('formatJson (P8-25)', () => {
  it('re-indents minified JSON, keeping empty containers on one line', () => {
    expect(formatJson('{"a":1,"b":[true,null,{}],"c":{"d":[]}}')).toBe(
      [
        '{',
        '  "a": 1,',
        '  "b": [',
        '    true,',
        '    null,',
        '    {}',
        '  ],',
        '  "c": {',
        '    "d": []',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('keeps every value as written: big numbers, decimals, escapes, punctuation in strings', () => {
    const out = formatJson('{"n":12345678901234567890,"f":1.0,"s":"a, b: {c} [d] \\"e\\""}');
    expect(out).toContain('"n": 12345678901234567890');
    expect(out).toContain('"f": 1.0');
    expect(out).toContain('"s": "a, b: {c} [d] \\"e\\""');
    expect(JSON.parse(out!)).toEqual(
      JSON.parse('{"n":12345678901234567890,"f":1.0,"s":"a, b: {c} [d] \\"e\\""}'),
    );
  });

  it('takes a BOM and a top-level scalar; refuses what is not JSON', () => {
    expect(formatJson('\uFEFF[1, 2]')).toBe('[\n  1,\n  2\n]');
    expect(formatJson('"x"')).toBe('"x"');
    expect(formatJson('{"a": 1,}')).toBeUndefined();
    expect(formatJson('// note\n{}')).toBeUndefined();
  });
});

describe('formatXml (P8-25)', () => {
  it('re-indents XML, keeps the declaration, text-only elements on one line', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><project xmlns="urn:x"><!-- deps --><dependencies>' +
      '<dependency scope="test"><id>junit</id><v/></dependency></dependencies>' +
      '<script><![CDATA[a < b]]></script></project>';
    expect(formatXml(xml)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project xmlns="urn:x">',
        '  <!-- deps -->',
        '  <dependencies>',
        '    <dependency scope="test">',
        '      <id>junit</id>',
        '      <v/>',
        '    </dependency>',
        '  </dependencies>',
        '  <script>',
        '    <![CDATA[a < b]]>',
        '  </script>',
        '</project>',
      ].join('\n'),
    );
  });

  it('escapes text and attributes again, and refuses XML that is not well-formed', () => {
    expect(formatXml('<a t="x &amp; &quot;y&quot;">1 &lt; 2</a>')).toBe(
      '<a t="x &amp; &quot;y&quot;">1 &lt; 2</a>',
    );
    expect(formatXml('<a><b></a>')).toBeUndefined();
  });
});

describe('htmlFrameDocument (P8-25, decision 151)', () => {
  const frame = (html: string) =>
    new DOMParser().parseFromString(htmlFrameDocument(html), 'text/html');

  it('puts the no-network policy first in the head and keeps the doctype', () => {
    const out = htmlFrameDocument(
      '<!DOCTYPE html><html><head><title>R</title><link rel="stylesheet" href="https://cdn/x.css"></head><body><h1>Hi</h1></body></html>',
    );
    expect(
      out.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    const doc = frame(out);
    expect(doc.head.firstElementChild?.getAttribute('content')).toBe(HTML_FRAME_CSP);
    expect(doc.querySelector('h1')?.textContent).toBe('Hi');
  });

  it('removes meta refresh and base; links open a new tab, in-page anchors stay, others lose their address', () => {
    const doc = frame(
      '<meta http-equiv="Refresh" content="0;url=https://tracker.example/"><base href="https://x/">' +
        '<a id="w" href="https://example.com/a">web</a><a id="m" href="mailto:a@b.c">mail</a>' +
        '<a id="t" href="#part">toc</a><a id="r" href="other.html">file</a><a id="j" href="javascript:alert(1)">js</a>',
    );
    expect(doc.querySelector('meta[http-equiv="Refresh"]')).toBeNull();
    expect(doc.querySelector('base')).toBeNull();
    const a = (id: string) => doc.getElementById(id)!;
    expect(a('w').getAttribute('target')).toBe('_blank');
    expect(a('w').getAttribute('rel')).toBe('noopener noreferrer');
    expect(a('m').getAttribute('href')).toBe('mailto:a@b.c');
    expect(a('t').getAttribute('href')).toBe('#part');
    expect(a('t').getAttribute('target')).toBe('_self');
    expect(a('r').hasAttribute('href')).toBe(false);
    expect(a('j').hasAttribute('href')).toBe(false);
  });

  it('a fragment without html or head still gets the policy', () => {
    const doc = frame('<p>just a paragraph</p>');
    expect(doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')).toBeTruthy();
    expect(doc.body.textContent).toBe('just a paragraph');
  });
});

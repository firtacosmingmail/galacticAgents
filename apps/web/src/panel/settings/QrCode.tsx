import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * The SVG path of a QR code for `text` (P7-02): one unit square per dark module, on a grid that
 * includes a quiet zone of `border` modules. Encoded in the browser (`uqr`): the text — the phone
 * address with the token — is never sent anywhere to be drawn.
 */
export function qrModules(text: string, border = 2): { size: number; path: string } {
  const qr = encode(text, { ecc: 'M', border });
  const parts: string[] = [];
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
    });
  });
  return { size: qr.size, path: parts.join('') };
}

/** A QR code drawn as an inline SVG, dark on white whatever the theme (scanners need contrast). */
export function QrCode({ text, label, px = 220 }: { text: string; label: string; px?: number }) {
  const { size, path } = useMemo(() => qrModules(text), [text]);
  return (
    <svg
      className="set-qr-code"
      role="img"
      aria-label={label}
      width={px}
      height={px}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

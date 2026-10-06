import { createHash } from 'node:crypto';

/**
 * The push services a subscription may point at (P7-04). The server POSTs to whatever endpoint a
 * client registers, so an arbitrary URL would turn it into a request forwarder to any host —
 * including ones only the Mac can reach. Only the browsers' own push services are accepted:
 * Chrome/Android (FCM), Firefox (Mozilla autopush), Safari/iOS (Apple), Edge (WNS).
 */
const PUSH_SERVICE_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
] as const;

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** A device's id: the first 32 hex digits of SHA-256(endpoint) (the web page computes the same). */
export function pushDeviceId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 32);
}

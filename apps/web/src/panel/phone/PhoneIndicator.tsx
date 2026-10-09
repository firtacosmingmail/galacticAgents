import { useAppStore } from '../../state/store.js';
import { phoneIndicator, usePhoneStatus } from './use-phone-status.js';

/** The id of Settings → Access (the phone section and the QR code). */
export const ACCESS_SECTION_ID = 'settings-access';

/** Scrolls Settings → Access into view and moves focus to its heading, once it is rendered. */
export function revealAccessSection(attempts = 20): void {
  const el = document.getElementById(ACCESS_SECTION_ID);
  if (!el) {
    if (attempts > 0) setTimeout(() => revealAccessSection(attempts - 1), 50);
    return;
  }
  el.scrollIntoView?.({ block: 'start' });
  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

/**
 * The top bar's phone indicator (P9-16; SPEC decision 137): "Phone: online" (a green dot; the
 * tooltip has the address and how many phones are connected), "Phone: restart needed", or
 * "Phone: off" (grey; the tooltip says why). A click opens Settings → Access. Nothing shows while
 * the status is unknown or the server has no phone routes. `compact`: the dot only, named.
 */
export function PhoneIndicator({ compact = false }: { compact?: boolean }) {
  const phone = usePhoneStatus();
  const selection = useAppStore((s) => s.selection);
  const navigate = useAppStore((s) => s.navigate);
  if (!phone?.status || phone.unavailable) return null;
  const view = phoneIndicator(phone.status);
  const open = () => {
    navigate({ route: 'settings', selection });
    revealAccessSection();
  };
  return (
    <button
      type="button"
      className={`pnl-phone pnl-phone-${view.kind}${compact ? ' pnl-phone-compact' : ''}`}
      title={view.tooltip}
      aria-label={`${view.label}. ${view.tooltip}. Open phone access settings`}
      data-closes-menu=""
      onClick={open}
    >
      <span className="pnl-phone-dot" aria-hidden="true" />
      {!compact && <span>{view.label}</span>}
    </button>
  );
}

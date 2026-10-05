import { useId, useState } from 'react';
import type { QualityTier } from '@galactic/protocol';
import { useDeviceTier, writeDeviceTier } from '../../scene/device-tier.js';
import { isPhone } from '../../scene/device.js';
import { useSettingsData } from './SettingsData.js';

const TIER_NAMES: Record<QualityTier, string> = {
  high: 'High',
  balanced: 'Balanced',
  mobile: 'Mobile',
};

const AUTOMATIC = 'auto';

/**
 * The rendering quality of this browser alone (P7-03; SPEC decision 93): "Automatic"
 * follows the settings' tier above — `Mobile` on a phone — and any other choice wins over it on
 * this device only. Applied at once and remembered in this browser (`device-tier.ts`), never sent
 * to the server: the phone choosing `Mobile` leaves the Mac at `High`.
 */
export function DeviceQuality() {
  const id = useId();
  const device = useDeviceTier();
  const server = useSettingsData().response?.settings.qualityTier;
  const [saved, setSaved] = useState(false);
  const phone = isPhone();
  const autoHint = phone
    ? 'Mobile, because this looks like a phone'
    : server
      ? `${TIER_NAMES[server]}, the rendering quality above`
      : 'the rendering quality above';
  const choose = (value: string) => {
    writeDeviceTier(value === AUTOMATIC ? undefined : (value as QualityTier));
    setSaved(true);
  };
  const options: { value: string; label: string; hint: string }[] = [
    { value: AUTOMATIC, label: 'Automatic', hint: autoHint },
    ...(['high', 'balanced', 'mobile'] as const).map((t) => ({
      value: t,
      label: TIER_NAMES[t],
      hint: 'on this device only',
    })),
  ];
  return (
    <section className="set-section" aria-label="Rendering quality on this device">
      <div className="set-head">
        <h2 className="set-title">Rendering quality on this device</h2>
      </div>
      <p className="set-intro">
        Overrides the rendering quality above in this browser only, and applies at once. Phones
        start at Mobile.
      </p>
      <fieldset className="set-field set-radios">
        <legend className="set-visually-hidden">Rendering quality on this device</legend>
        {options.map((o) => (
          <label key={o.value} className="set-radio">
            <input
              type="radio"
              name={id}
              value={o.value}
              checked={(device ?? AUTOMATIC) === o.value}
              onChange={() => choose(o.value)}
            />
            <span>
              <strong>{o.label}</strong> <span className="set-muted">— {o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {saved && (
        <p className="set-saved" role="status">
          Saved in this browser.
        </p>
      )}
    </section>
  );
}

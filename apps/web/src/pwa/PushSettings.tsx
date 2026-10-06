import { useCallback, useEffect, useState } from 'react';
import {
  PushKind,
  allPushKindsOn,
  type PushDevice,
  type PushKinds,
  type PushStatusResponse,
} from '@galactic/protocol';
import { KIND_LABELS } from '../panel/notifications/prefs.js';
import { ApiError } from '../console/api.js';
import {
  applicationServerKey,
  createPushApi,
  deviceLabel,
  pushDeviceId,
  pushRegistration,
  pushSupport,
  rememberDevice,
  sameServerKey,
  subscriptionJson,
  type PushApi,
  type PushEnv,
  type PushSupport,
} from './push.js';
import '../panel/notifications/notifications.css';
import './push.css';

/**
 * Push notifications on this device (P7-04; SPEC §4.5, decision 59): the phone's lock-screen
 * alerts for a question or permission waiting for the user and a project that finished or failed.
 * Per device: each browser subscribes itself and keeps its own switches (stored with its
 * subscription on the server, which decides what to send while the page is closed). The browser's
 * permission prompt opens only from the "Turn on" click — iOS refuses it otherwise — and on iOS
 * only the app added to the Home Screen can receive push at all.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'unavailable'; why: PushSupport | 'no-worker' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      reg: ServiceWorkerRegistration;
      status: PushStatusResponse;
      /** This browser's subscription, when it has one made with the server's key. */
      sub: PushSubscription | undefined;
      /** One made with an older server key (the key file was lost): replaced on "Turn on". */
      stale: PushSubscription | undefined;
      /** This device as the server lists it (absent: push is off here). */
      device: PushDevice | undefined;
    };

const PUSH_KIND_LABELS = KIND_LABELS.filter((k) =>
  (PushKind.options as readonly string[]).includes(k.kind),
) as { kind: PushKind; label: string }[];

const messageOf = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : 'something went wrong';

export interface PushSettingsProps {
  token: string;
  /** Tests inject these. */
  env?: PushEnv;
  api?: PushApi;
}

export function PushSettings({ token, env, api: injected }: PushSettingsProps) {
  const [api] = useState<PushApi>(() => injected ?? createPushApi(token));
  const [pushEnv] = useState<PushEnv>(() => env ?? { win: window, nav: navigator });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const permission = (): NotificationPermission | undefined => {
    try {
      const w = pushEnv.win as Window & { Notification?: typeof Notification };
      return w.Notification?.permission;
    } catch {
      return undefined;
    }
  };

  const [support] = useState<PushSupport>(() => pushSupport(pushEnv));

  /** Reads the device's state; the phase changes only when the answer arrives. */
  const load = useCallback(
    (cancelled: () => boolean = () => false) =>
      readPhase(api, pushEnv).then((next) => {
        if (!cancelled()) setPhase(next);
      }),
    [api, pushEnv],
  );

  useEffect(() => {
    if (support !== 'supported') return;
    let stop = false;
    void load(() => stop);
    return () => {
      stop = true;
    };
  }, [load, support]);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await what();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (support !== 'supported') return <Unavailable why={support} />;
  if (phase.kind === 'unavailable') return <Unavailable why={phase.why} />;
  if (phase.kind === 'loading') {
    return (
      <section className="ntf-settings" aria-label="Push notifications on this device">
        <p className="ntf-status">Checking push notifications…</p>
      </section>
    );
  }
  if (phase.kind === 'error') {
    return (
      <section className="ntf-settings" aria-label="Push notifications on this device">
        <p className="ntf-status ntf-status-blocked" role="alert">
          Could not read the push settings: {phase.message}{' '}
          <button type="button" className="secondary ntf-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </section>
    );
  }

  const { reg, status, sub, stale, device } = phase;
  const label = deviceLabel(pushEnv);
  const kinds: PushKinds = device?.kinds ?? allPushKindsOn();
  const details = device?.details ?? false;
  const blocked = permission() === 'denied';

  const save = (next: { kinds?: PushKinds; details?: boolean }) =>
    run(async () => {
      if (!sub) return;
      const saved = await api.subscribe({
        subscription: subscriptionJson(sub),
        kinds: next.kinds ?? kinds,
        details: next.details ?? details,
        label,
      });
      rememberDevice(saved);
      setPhase({ ...phase, device: saved, status: withDevice(status, saved) });
      setNotice('Saved for this device.');
    });

  const turnOn = () =>
    run(async () => {
      let current = sub;
      if (!current) {
        // Rare: a subscription bound to a lost key must go first (the browser allows one).
        if (stale) await stale.unsubscribe().catch(() => false);
        // Otherwise the first await of the click: the permission prompt needs the gesture (iOS).
        current = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(status.publicKey),
        });
      }
      const saved = await api.subscribe({
        subscription: subscriptionJson(current),
        kinds,
        details,
        label,
      });
      rememberDevice(saved);
      setPhase({
        ...phase,
        sub: current,
        stale: undefined,
        device: saved,
        status: withDevice(status, saved),
      });
      setNotice('Push notifications are on for this device.');
    });

  const turnOff = () =>
    run(async () => {
      if (sub) {
        await api.unsubscribe(sub.endpoint);
        await sub.unsubscribe().catch(() => false);
      }
      rememberDevice(undefined);
      setPhase({
        ...phase,
        sub: undefined,
        device: undefined,
        status: { ...status, devices: status.devices.filter((d) => d.id !== device?.id) },
      });
      setNotice('Push notifications are off for this device.');
    });

  const test = () =>
    run(async () => {
      if (!sub) return;
      const res = (await api.test(sub.endpoint)) as { ok?: boolean };
      setNotice(
        res.ok
          ? 'Test push sent. It should arrive in a few seconds.'
          : 'The push service did not take the test push; try again later.',
      );
    });

  const remove = (other: PushDevice) =>
    run(async () => {
      await api.remove(other.id);
      setPhase({
        ...phase,
        status: { ...status, devices: status.devices.filter((d) => d.id !== other.id) },
      });
      setNotice(`Push notifications removed from ${other.label}.`);
    });

  const others = status.devices.filter((d) => d.id !== device?.id);

  return (
    <section className="ntf-settings" aria-label="Push notifications on this device">
      {blocked ? (
        <p className="ntf-status ntf-status-blocked">
          Notifications are blocked for this site. Allow them in the browser’s (or the phone’s)
          settings for GalacticAgents, then reload.
        </p>
      ) : device ? (
        <p className="ntf-status">
          On for this device ({device.label}).{' '}
          <button type="button" className="secondary ntf-button" disabled={busy} onClick={turnOff}>
            Turn off
          </button>{' '}
          <button type="button" className="secondary ntf-button" disabled={busy} onClick={test}>
            Send a test push
          </button>
        </p>
      ) : (
        <p className="ntf-status">
          <button type="button" className="ntf-button" disabled={busy} onClick={turnOn}>
            Turn on push notifications
          </button>
        </p>
      )}
      {device?.lastError && (
        <p className="ntf-note">The last push to this device failed ({device.lastError}).</p>
      )}

      <fieldset className="ntf-kinds" disabled={!device || busy}>
        <legend>Push to this device when</legend>
        {PUSH_KIND_LABELS.map(({ kind, label: text }) => (
          <label key={kind} className="ntf-kind">
            <input
              type="checkbox"
              name={`push-${kind}`}
              checked={kinds[kind]}
              onChange={(e) => void save({ kinds: { ...kinds, [kind]: e.target.checked } })}
            />{' '}
            {text}
          </label>
        ))}
        <label className="ntf-kind push-details">
          <input
            type="checkbox"
            name="push-details"
            checked={details}
            onChange={(e) => void save({ details: e.target.checked })}
          />{' '}
          Show project names and question text (visible on the lock screen)
        </label>
      </fieldset>

      {notice && (
        <p className="ntf-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="ntf-status ntf-status-blocked" role="alert">
          {error}
        </p>
      )}

      {others.length > 0 && (
        <div className="push-devices">
          <h3 className="ntf-heading">Other devices with push</h3>
          <ul>
            {others.map((d) => (
              <li key={d.id}>
                <span>{d.label}</span>
                {status.canRemoveOthers && (
                  <button
                    type="button"
                    className="secondary ntf-button"
                    disabled={busy}
                    aria-label={`Remove push notifications from ${d.label}`}
                    onClick={() => void remove(d)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="ntf-note">
        Pushes reach this device while GalacticAgents is closed. Without “Show project names”, the
        lock screen says only what happened (“A question for you”), never what it is about.
      </p>
    </section>
  );
}

async function readPhase(api: PushApi, env: PushEnv): Promise<Phase> {
  const reg = await pushRegistration(env);
  if (!reg?.pushManager) return { kind: 'unavailable', why: 'no-worker' };
  try {
    const status = await api.status();
    const held = (await reg.pushManager.getSubscription()) ?? undefined;
    const fresh = held && sameServerKey(held, status.publicKey);
    const sub = fresh ? held : undefined;
    const id = sub ? await pushDeviceId(sub.endpoint) : undefined;
    const device = id ? status.devices.find((d) => d.id === id) : undefined;
    return { kind: 'ready', reg, status, sub, stale: fresh ? undefined : held, device };
  } catch (err) {
    return { kind: 'error', message: messageOf(err) };
  }
}

function withDevice(status: PushStatusResponse, device: PushDevice): PushStatusResponse {
  return { ...status, devices: [...status.devices.filter((d) => d.id !== device.id), device] };
}

function Unavailable({ why }: { why: PushSupport | 'no-worker' }) {
  const text = {
    'ios-install':
      'On iPhone and iPad, push notifications work only in the app added to the Home Screen: tap Share, then “Add to Home Screen”, open GalacticAgents from there and turn them on.',
    insecure:
      'Push notifications need a secure (HTTPS) address, such as the Tailscale Serve name (docs/REMOTE_ACCESS.md).',
    unsupported: 'This browser cannot receive push notifications.',
    'no-worker':
      'Push notifications need the installed app’s service worker, which runs in the built app (galactic start), not in development.',
    supported: '',
  }[why];
  return (
    <section className="ntf-settings" aria-label="Push notifications on this device">
      <p className="ntf-status">{text}</p>
    </section>
  );
}

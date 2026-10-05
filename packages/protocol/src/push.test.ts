import { describe, expect, it } from 'vitest';
import { NotificationKind } from './panel.js';
import {
  PushKind,
  PushPayload,
  PushStatusResponse,
  PushSubscribeRequest,
  allPushKindsOn,
  isPushKind,
} from './push.js';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  expirationTime: null,
  keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
};

describe('push schemas (P7-04)', () => {
  it('push kinds are notification kinds, the four decision 59 triggers for the phone', () => {
    for (const k of PushKind.options) expect(NotificationKind.options).toContain(k);
    expect(PushKind.options).toEqual([
      'permission',
      'question',
      'project_completed',
      'project_failed',
    ]);
    expect(isPushKind('task_completed')).toBe(false);
    expect(isPushKind('permission')).toBe(true);
    expect(Object.values(allPushKindsOn()).every(Boolean)).toBe(true);
  });

  it('accepts a browser subscription and refuses a non-https endpoint or bad keys', () => {
    expect(PushSubscribeRequest.safeParse({ subscription }).success).toBe(true);
    expect(
      PushSubscribeRequest.safeParse({
        subscription: { ...subscription, endpoint: 'http://fcm.googleapis.com/x' },
      }).success,
    ).toBe(false);
    expect(
      PushSubscribeRequest.safeParse({
        subscription: { ...subscription, keys: { p256dh: 'short', auth: 'a'.repeat(22) } },
      }).success,
    ).toBe(false);
    expect(PushSubscribeRequest.safeParse({ subscription, label: 'x'.repeat(81) }).success).toBe(
      false,
    );
  });

  it('a payload has no room for anything but the notification', () => {
    const ok = PushPayload.safeParse({
      v: 1,
      id: 'question:q1',
      kind: 'question',
      title: 'A question for you',
      target: { kind: 'question', id: 'q1' },
      at: '2026-10-05T10:00:00.000Z',
    });
    expect(ok.success).toBe(true);
    // zod strips unknown keys: a token could never ride along through the schema.
    const parsed = PushPayload.parse({
      v: 1,
      id: 'galactic:test',
      kind: 'test',
      title: 'GalacticAgents',
      at: '2026-10-05T10:00:00.000Z',
      token: 'secret',
    });
    expect(parsed).not.toHaveProperty('token');
  });

  it('a status response lists devices without endpoints', () => {
    const parsed = PushStatusResponse.parse({
      publicKey: 'BAbc',
      canRemoveOthers: true,
      devices: [
        {
          id: '0123456789abcdef0123456789abcdef',
          label: 'iPhone',
          kinds: allPushKindsOn(),
          details: false,
          origin: 'remote',
          createdAt: '2026-10-05T10:00:00.000Z',
          updatedAt: '2026-10-05T10:00:00.000Z',
          endpoint: 'https://web.push.apple.com/x',
        },
      ],
    });
    expect(parsed.devices[0]).not.toHaveProperty('endpoint');
  });
});

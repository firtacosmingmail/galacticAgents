/**
 * A scriptable stand-in for the browser's `Notification` (tests only): records every notification
 * shown, and answers `requestPermission` with `nextAnswer`.
 */
export class FakeNotification {
  static permission: NotificationPermission = 'default';
  static nextAnswer: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  static requests = 0;

  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requests++;
    FakeNotification.permission = FakeNotification.nextAnswer;
    return Promise.resolve(FakeNotification.permission);
  }

  static reset(permission: NotificationPermission = 'default'): void {
    FakeNotification.permission = permission;
    FakeNotification.nextAnswer = 'granted';
    FakeNotification.instances = [];
    FakeNotification.requests = 0;
  }

  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeNotification.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  get tag(): string | undefined {
    return this.options.tag;
  }
}

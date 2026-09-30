/**
 * A scriptable stand-in for the browser WebSocket, for client unit tests.
 * Each `new FakeWebSocket(url)` registers itself in `FakeWebSocket.instances`.
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  // --- test controls -------------------------------------------------------
  serverOpens(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  serverSends(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverCloses(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
  get hello(): { type: string; token: string; lastEventId?: number; logId?: string } {
    return JSON.parse(this.sent[0] ?? '{}');
  }
}

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PTY_TERMINAL_SIZE, type TranscriptChunk } from '@galactic/protocol';
import { ApiContext } from '../../console/hierarchy/shared.js';
import type { Api } from '../../console/api.js';
import { TerminalInput, TerminalView } from './TerminalView.js';

/** xterm.js stand-in: what was written, and the options it was made with (jsdom has no canvas). */
const xterm = vi.hoisted(() => ({
  writes: [] as string[],
  resets: 0,
  options: undefined as unknown,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: unknown) {
      xterm.options = options;
    }
    open() {}
    write(data: string) {
      xterm.writes.push(data);
    }
    reset() {
      xterm.resets++;
      xterm.writes.length = 0;
    }
    dispose() {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const chunk = (seq: number, kind: TranscriptChunk['kind'], text: string): TranscriptChunk => ({
  agentId: 'a-pty',
  seq,
  at: `2026-10-06T10:00:${String(seq).padStart(2, '0')}.000Z`,
  kind,
  text,
});

afterEach(() => {
  cleanup();
  xterm.writes.length = 0;
  xterm.resets = 0;
  vi.unstubAllGlobals();
});

describe('TerminalView (P8-08)', () => {
  it('draws the terminal chunks in order at the agent size, read-only; older pages redraw', async () => {
    const { rerender } = render(
      <TerminalView
        chunks={[
          chunk(3, 'terminal', '\x1b[32mhi'),
          chunk(4, 'text', 'hi'),
          chunk(5, 'terminal', '!'),
        ]}
      />,
    );
    await vi.waitFor(() => expect(xterm.writes).toEqual(['\x1b[32mhi', '!']));
    expect(xterm.options).toMatchObject({ ...PTY_TERMINAL_SIZE, disableStdin: true });
    rerender(
      <TerminalView
        chunks={[
          chunk(3, 'terminal', '\x1b[32mhi'),
          chunk(5, 'terminal', '!'),
          chunk(7, 'terminal', ' more'),
        ]}
      />,
    );
    expect(xterm.writes).toEqual(['\x1b[32mhi', '!', ' more']);
    expect(xterm.resets).toBe(0);
    // An older page landed: the screen is replayed from the start.
    rerender(
      <TerminalView
        chunks={[
          chunk(1, 'terminal', 'start '),
          chunk(3, 'terminal', 'hi'),
          chunk(7, 'terminal', '.'),
        ]}
      />,
    );
    expect(xterm.resets).toBe(1);
    expect(xterm.writes).toEqual(['start ', 'hi', '.']);
  });

  it('says when nothing is on the screen yet', () => {
    render(<TerminalView chunks={[chunk(1, 'text', 'only text')]} />);
    expect(screen.getByText('Nothing on the screen yet.')).toBeTruthy();
  });
});

describe('TerminalInput (P8-08)', () => {
  const api = (terminal: Api['terminal']) => ({ terminal }) as unknown as Api;

  it("types a line from the Mac's own browser", async () => {
    const terminal = vi.fn(async () => ({ messageId: 'm-1' }));
    render(
      <ApiContext.Provider value={api(terminal)}>
        <TerminalInput agentId="a-pty" />
      </ApiContext.Provider>,
    );
    fireEvent.change(screen.getByLabelText('Type into its terminal'), {
      target: { value: 'yes please' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Type it' }));
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledWith('a-pty', 'yes please'));
    await vi.waitFor(() =>
      expect((screen.getByLabelText('Type into its terminal') as HTMLInputElement).value).toBe(''),
    );
  });

  it('is not offered to a remote client', () => {
    vi.stubGlobal('location', { hostname: 'mymac.tail1234.ts.net' });
    render(
      <ApiContext.Provider value={api(vi.fn())}>
        <TerminalInput agentId="a-pty" />
      </ApiContext.Provider>,
    );
    expect(screen.queryByLabelText('Type into its terminal')).toBeNull();
    expect(screen.getByText(/only from the Mac/)).toBeTruthy();
  });
});

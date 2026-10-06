// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKUP_SCHEDULE, type BackupsResponse } from '@galactic/protocol';
import { Backups, BackupsApiError, createBackupsApi, type BackupsApi } from './Backups.js';

/** P8-03 — the settings' Backups section: list, "Back up now", the export, Mac only. */

afterEach(cleanup);

const listed = (over: Partial<BackupsResponse> = {}): BackupsResponse => ({
  backups: [
    {
      name: 'galactic-20261006T100000000Z-auto.sqlite',
      kind: 'auto',
      createdAt: '2026-10-06T10:00:00.000Z',
      bytes: 3 * 2 ** 20,
    },
  ],
  directory: '/Users/me/.galactic/backups',
  schedule: DEFAULT_BACKUP_SCHEDULE,
  running: false,
  ...over,
});

function fakeApi(over: Partial<BackupsApi> = {}): BackupsApi {
  return {
    list: vi.fn(() => Promise.resolve(listed())),
    backupNow: vi.fn(() =>
      Promise.resolve({
        at: '2026-10-06T11:00:00.000Z',
        kind: 'manual' as const,
        outcome: 'ok' as const,
        name: 'galactic-20261006T110000000Z-manual.sqlite',
        bytes: 2 ** 20,
      }),
    ),
    exportMap: vi.fn(() =>
      Promise.resolve({ blob: new Blob(['{}']), name: 'galactic-map-2026-10-06.json' }),
    ),
    ...over,
  };
}

describe('Backups (P8-03)', () => {
  it('lists the backups and the rotation', async () => {
    render(<Backups token="t" api={fakeApi()} />);
    expect(await screen.findByRole('list', { name: 'backup files' })).toBeTruthy();
    expect(screen.getByText(/daily · 3.0 MB/)).toBeTruthy();
    expect(screen.getByText(/keeps 7 daily, 4 weekly and 5 manual/)).toBeTruthy();
    expect(screen.getByText('/Users/me/.galactic/backups')).toBeTruthy();
  });

  it('backs up now and says how it went', async () => {
    const api = fakeApi();
    render(<Backups token="t" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
    expect(await screen.findByText('Backed up (1.0 MB).')).toBeTruthy();
    expect(api.backupNow).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(2); // the list is read again
  });

  it('says why a backup was skipped', async () => {
    const api = fakeApi({
      backupNow: () =>
        Promise.resolve({
          at: '2026-10-06T11:00:00.000Z',
          kind: 'manual',
          outcome: 'skipped',
          detail: 'the disk has 10 MiB free',
        }),
    });
    render(<Backups token="t" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not backed up: the disk has/);
  });

  it('exports the map as a download, with transcripts when asked', async () => {
    const api = fakeApi();
    const onDownload = vi.fn();
    render(<Backups token="t" api={api} onDownload={onDownload} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /with transcripts/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export the map' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalled());
    expect(api.exportMap).toHaveBeenCalledWith(true);
    expect(onDownload.mock.calls[0]![1]).toBe('galactic-map-2026-10-06.json');
  });

  it('tells a remote client to use the Mac', async () => {
    const api = fakeApi({
      list: () => Promise.reject(new BackupsApiError(403, 'only here', 'remote_control')),
    });
    render(<Backups token="t" api={api} />);
    expect((await screen.findByRole('note')).textContent).toMatch(/managed on the Mac/);
    expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull();
  });

  it('shows a skipped or failed last backup', async () => {
    const api = fakeApi({
      list: () =>
        Promise.resolve(
          listed({
            last: {
              at: '2026-10-06T03:00:00.000Z',
              kind: 'auto',
              outcome: 'skipped',
              detail: 'the disk has 10 MiB free',
            },
          }),
        ),
    });
    render(<Backups token="t" api={api} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/was skipped/);
  });

  it('the API sends the token and reads the file name', async () => {
    const fetchImpl = vi.fn((_path: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response('{"format":"x"}', {
          headers: { 'content-disposition': 'attachment; filename="galactic-map-2026-10-06.json"' },
        }),
      ),
    );
    const api = createBackupsApi('tok', fetchImpl as unknown as typeof fetch);
    const { name } = await api.exportMap(false);
    expect(name).toBe('galactic-map-2026-10-06.json');
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/export');
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)['authorization']).toBe(
      'Bearer tok',
    );
    const refused = createBackupsApi('tok', (() =>
      Promise.resolve(
        new Response('{"error":"remote_control","message":"only here"}', { status: 403 }),
      )) as unknown as typeof fetch);
    await expect(refused.list()).rejects.toMatchObject({ status: 403, code: 'remote_control' });
  });
});

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { registerAnchor } from './anchors.js';
import { useCameraStore } from './camera/store.js';
import { SceneProbe } from './probe.js';
import type { SatelliteFrame } from './satellites/director.js';
import { publishSatellites } from './satellites/registry.js';

afterEach(() => {
  cleanup();
  act(() => publishSatellites(new Map()));
  useCameraStore.setState({ focusedId: undefined, flying: false, atSystem: true });
});

describe('SceneProbe (P8-05 test hook)', () => {
  it('mirrors the drawn bodies, the satellites and the camera, hidden from everyone', () => {
    render(<SceneProbe />);
    const probe = screen.getByTestId('scene-probe');
    expect(probe.hidden).toBe(true);
    expect(probe.textContent).toBe('');
    expect(probe.dataset['camera']).toBe('system');

    let unregister: (() => void) | undefined;
    act(() => {
      const object = {} as Object3D;
      const off1 = registerAnchor({ bodyId: 'b-mars', object, radius: 1, kind: 'planet' });
      const off2 = registerAnchor({ bodyId: 'b-earth', object, radius: 1, kind: 'planet' });
      unregister = () => (off1(), off2());
      const frame = (agentId: string) => ({ agentId }) as SatelliteFrame;
      publishSatellites(
        new Map([
          ['a-2', frame('a-2')],
          ['a-1', frame('a-1')],
        ]),
      );
    });
    expect(probe.dataset['bodies']).toBe('b-earth b-mars');
    expect(probe.dataset['satellites']).toBe('a-1 a-2');

    act(() => useCameraStore.setState({ flying: true }));
    expect(probe.dataset['camera']).toBe('flying');
    act(() => useCameraStore.setState({ flying: false, focusedId: 'b-mars', atSystem: false }));
    expect(probe.dataset['camera']).toBe('b-mars');
    act(() => useCameraStore.setState({ focusedId: undefined }));
    expect(probe.dataset['camera']).toBe('free');

    act(() => unregister!());
    expect(probe.dataset['bodies']).toBe('');
  });
});

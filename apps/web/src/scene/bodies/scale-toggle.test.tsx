import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSceneScale } from '../scale.js';
import { SCALE_NOTES, ScaleToggle } from './ScaleToggle.js';

afterEach(() => {
  cleanup();
  useSceneScale.getState().setMode('fake');
});

describe('ScaleToggle', () => {
  it('defaults to the readable layout and says it is not to scale (corner case 25)', () => {
    render(<ScaleToggle />);
    const button = screen.getByRole('button', { name: 'True scale' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.pnl-scene-scale-note')?.textContent).toBe(SCALE_NOTES.fake);
    expect(SCALE_NOTES.fake).toMatch(/not to scale/);
  });

  it('switches the scene to true scale and back, with the note following', () => {
    render(<ScaleToggle />);
    const button = screen.getByRole('button', { name: 'True scale' });
    fireEvent.click(button);
    expect(useSceneScale.getState().mode).toBe('true');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.pnl-scene-scale-note')?.textContent).toBe(SCALE_NOTES.true);
    expect(SCALE_NOTES.true).toMatch(/enlarged ×\d+/);
    fireEvent.click(button);
    expect(useSceneScale.getState().mode).toBe('fake');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});

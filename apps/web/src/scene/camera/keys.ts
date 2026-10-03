/**
 * The scene's keyboard shortcuts (P3-04), active while the scene area has focus:
 * `]` next body, `[` previous body, `Escape` or `Home` back to the whole system.
 * Brackets, not arrows: arrows scroll the page and move the caret, and OrbitControls may take
 * them for panning later. Typing in a field, and any key with Ctrl, Meta or Alt, is ignored.
 */
export type SceneKeyAction = 'next' | 'previous' | 'back';

export const SCENE_SHORTCUTS = '] [ Escape Home';

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
}

export function sceneKeyAction(event: KeyLike): SceneKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return undefined;
  if (isTyping(event.target)) return undefined;
  switch (event.key) {
    case ']':
      return 'next';
    case '[':
      return 'previous';
    case 'Escape':
    case 'Home':
      return 'back';
    default:
      return undefined;
  }
}

function isTyping(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return (
    el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null
  );
}

type DragTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Calls `onEnd` once a drag is over, for a list that draws only the rows on
 * screen. A row scrolled out of the window mid-drag is removed from the page,
 * and a dragend aimed at a removed element reaches nobody. The window still
 * sees a drop (and the dragend, while the row is drawn), and the browser sends
 * no mouse events during a drag, so the first mouse move after the source row
 * has gone means the drag finished somewhere that is not a drop target, or was
 * cancelled. Returns the function that stops watching.
 */
export function watchDragEnd(target: DragTarget, sourceIsDrawn: () => boolean, onEnd: () => void): () => void {
  const end = (): void => onEnd();
  const moved = (): void => {
    if (!sourceIsDrawn()) onEnd();
  };
  target.addEventListener('dragend', end);
  target.addEventListener('drop', end);
  target.addEventListener('mousemove', moved);
  return () => {
    target.removeEventListener('dragend', end);
    target.removeEventListener('drop', end);
    target.removeEventListener('mousemove', moved);
  };
}

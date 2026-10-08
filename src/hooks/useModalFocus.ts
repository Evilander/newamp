import { useLayoutEffect, type RefObject } from 'react';
import { activateModalFocus } from '../lib/modal-focus';

export function useModalFocus(dialog: RefObject<HTMLElement>, initial?: RefObject<HTMLElement>, active = true): void {
  useLayoutEffect(() => {
    if (!active || !dialog.current) return;
    return activateModalFocus(dialog.current, initial?.current);
  }, [dialog, initial, active]);
}

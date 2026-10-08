const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

export function activateModalFocus(dialog: HTMLElement, initial?: HTMLElement | null): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const siblings = new Map<HTMLElement, boolean>();
  let branch: HTMLElement = dialog;
  while (branch.parentElement && branch !== document.body) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        siblings.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
    branch = branch.parentElement;
  }
  const targets = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') && element.getClientRects().length > 0,
  );
  const focusFirst = () => (initial?.isConnected ? initial : targets()[0] ?? dialog).focus();
  const onFocus = (event: FocusEvent) => {
    if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const elements = targets();
    const index = elements.indexOf(document.activeElement as HTMLElement);
    if (!elements.length || index < 0 || (!event.shiftKey && index === elements.length - 1) || (event.shiftKey && index === 0)) {
      event.preventDefault();
      (event.shiftKey ? elements.at(-1) ?? dialog : elements[0] ?? dialog).focus();
    }
  };
  document.addEventListener('focusin', onFocus);
  dialog.addEventListener('keydown', onKey);
  focusFirst();
  return () => {
    document.removeEventListener('focusin', onFocus);
    dialog.removeEventListener('keydown', onKey);
    for (const [element, inert] of siblings) element.inert = inert;
    if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
  };
}

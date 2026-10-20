import { useEffect, type RefObject } from 'react';

/** The one managed details that is open right now. Opening another managed details closes it. */
let openOwner: { close: () => void } | null = null;

const MENU_ITEM = 'button, a[role="menuitem"]';

/**
 * Makes a native details menu dismissible. While it is open, a pointerdown outside it, Escape, focus moving to an
 * element outside it, or a click on one of its items closes it. Escape returns focus to the summary. Document
 * listeners exist only while the menu is open.
 */
export function useDismissibleDetails(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    let detach: (() => void) | null = null;
    const owner = {
      close: () => {
        detach?.();
        details.open = false;
      },
    };
    const attach = () => {
      if (detach) return;
      if (openOwner && openOwner !== owner) openOwner.close();
      openOwner = owner;
      const onPointerDown = (event: PointerEvent) => {
        if (!(event.target instanceof Node) || !details.contains(event.target)) owner.close();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        details.querySelector('summary')?.focus();
        owner.close();
      };
      const onFocusOut = (event: FocusEvent) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !details.contains(next)) owner.close();
      };
      const onClick = (event: MouseEvent) => {
        const item = event.target instanceof Element ? event.target.closest(MENU_ITEM) : null;
        if (item && details.contains(item)) owner.close();
      };
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('focusout', onFocusOut);
      document.addEventListener('click', onClick);
      detach = () => {
        document.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('focusout', onFocusOut);
        document.removeEventListener('click', onClick);
        detach = null;
        if (openOwner === owner) openOwner = null;
      };
    };
    const onToggle = () => {
      if (details.open) attach();
      else detach?.();
    };
    details.addEventListener('toggle', onToggle);
    if (details.open) attach();
    return () => {
      detach?.();
      details.removeEventListener('toggle', onToggle);
    };
  }, [ref]);
}

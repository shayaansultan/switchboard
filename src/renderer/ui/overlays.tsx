// The two floating things: a menu anchored to a button, and a tooltip above
// whatever is hovered or focused. Both are rendered once at the root and
// driven through context, so a re-render of the row underneath never
// removes them.

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { act } from '../lib';

export type MenuItem =
  | { label: string; danger?: boolean; disabled?: boolean; run: () => unknown }
  | { colors: string[]; current: string; pick: (color: string) => unknown }
  | 'separator';
export type MenuPlacement = { prefer?: 'above' | 'below'; align?: 'left' | 'right' };
type OpenMenu = { anchor: HTMLElement; items: MenuItem[]; place: MenuPlacement };
type Tip = { anchor: HTMLElement; lines: string[] };

type Overlays = {
  openMenu(anchor: HTMLElement, items: MenuItem[], place?: MenuPlacement): void;
  closeMenu(): void;
  showTip(anchor: HTMLElement, lines: string[]): void;
  hideTip(): void;
};
const Ctx = createContext<Overlays>({ openMenu() {}, closeMenu() {}, showTip() {}, hideTip() {} });
export const useOverlays = (): Overlays => useContext(Ctx);

// Handlers that give an element a tooltip.
export function useTip(lines: string[] | null) {
  const { showTip, hideTip } = useOverlays();
  if (!lines || !lines.length) return {};
  const show = (e: Event) => showTip(e.currentTarget as HTMLElement, lines);
  return { onMouseEnter: show, onFocus: show, onMouseLeave: hideTip, onBlur: hideTip };
}

export function OverlayProvider({ children }: { children: ComponentChildren }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  // Pressing the button that opened the menu sends a mousedown first, which
  // counts as a click outside and closes it, and then a click, which would
  // open it again. Remember the anchor of a menu closed that way so the click
  // that follows toggles it shut instead.
  const closedByAnchor = useRef<HTMLElement | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  const api: Overlays = {
    openMenu(anchor, items, place = {}) {
      if (closedByAnchor.current === anchor) {
        closedByAnchor.current = null;
        return;
      }
      closedByAnchor.current = null;
      setMenu({ anchor, items, place });
    },
    closeMenu: () => setMenu(null),
    showTip: (anchor, lines) => setTip({ anchor, lines }),
    hideTip: () => setTip(null),
  };

  useEffect(() => {
    if (!menu) return;
    const onOutside = (e: MouseEvent) => {
      const m = menuRef.current;
      if (!m) return;
      const box = document.querySelector('.menu');
      if (box && box.contains(e.target as Node)) return;
      closedByAnchor.current = m.anchor.contains(e.target as Node) ? m.anchor : null;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu ? <Menu {...menu} close={() => setMenu(null)} /> : null}
      {tip ? <Tooltip {...tip} /> : null}
    </Ctx.Provider>
  );
}

// Above the button, right-aligned to it: the button sits at the foot of its
// card, so above is where the room is. Below only when the button is so
// close to the top that above would not fit, and never past an edge.
function Menu({ anchor, items, place, close }: OpenMenu & { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const position = () => {
    const menu = ref.current;
    if (!menu) return;
    if (!anchor.isConnected) {
      close();
      return;
    }
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const gap = 4;
    const margin = 8;
    const fitsAbove = r.top - gap - h >= margin;
    const fitsBelow = r.bottom + gap + h <= window.innerHeight - margin;
    const above = place.prefer === 'below' ? !fitsBelow && fitsAbove : fitsAbove || !fitsBelow;
    const top = above ? r.top - gap - h : r.bottom + gap;
    const left = place.align === 'left' ? r.left : r.right - w;
    menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - h - margin))}px`;
    menu.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - w - margin))}px`;
  };
  useLayoutEffect(() => {
    position();
    (ref.current?.querySelector('button[role=menuitem]:not([disabled])') as HTMLButtonElement | null)?.focus();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  });
  return (
    <div class="menu" role="menu" ref={ref}>
      {items.map((it, i) => {
        if (it === 'separator') return <hr key={i} />;
        if ('colors' in it) {
          return (
            <div class="swatches" role="group" title="Colour" key={i}>
              {it.colors.map((c) => (
                <button
                  type="button"
                  key={c}
                  class={`swatch ${c.toLowerCase() === it.current.toLowerCase() ? 'on' : ''}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => {
                    close();
                    act(() => it.pick(c), anchor);
                  }}
                />
              ))}
              <label class="swatch custom" title="Any colour">
                <input
                  type="color"
                  value={it.current}
                  onChange={(e) => {
                    const value = (e.currentTarget as HTMLInputElement).value;
                    close();
                    act(() => it.pick(value), anchor);
                  }}
                />
              </label>
            </div>
          );
        }
        return (
          <button
            type="button"
            key={i}
            class={it.danger ? 'danger' : ''}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              close();
              act(it.run, anchor);
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function Tooltip({ anchor, lines }: Tip) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const gap = 6;
    const margin = 8;
    const top = r.top - gap - h >= margin ? r.top - gap - h : r.bottom + gap;
    const left = r.left + r.width / 2 - w / 2;
    tip.style.top = `${top}px`;
    tip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - w - margin))}px`;
  });
  return (
    <div class="tip" role="tooltip" ref={ref}>
      {lines.map((line, i) => (
        <div class={i ? 'sub' : ''} key={i}>
          {line}
        </div>
      ))}
    </div>
  );
}

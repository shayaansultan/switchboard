// The two floating things: a menu anchored to a button (or to the pointer,
// for a right-click), and a tooltip above whatever is hovered or focused.
// Both are rendered once at the root and driven through context, so a
// re-render of the row underneath never removes them.

import { createContext, type ComponentChildren } from 'preact';
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { act } from '../lib';
import { Icon } from './primitives';

// What a menu can hold: a header naming what the menu acts on, plain items
// (checkable ones form a radio group), a submenu that shows its current
// value, a row of colour swatches, or a separator.
export type MenuItem =
  | { header: string; sub?: string }
  | { label: string; danger?: boolean; disabled?: boolean; checked?: boolean; run: () => unknown }
  | { label: string; value?: string; items: MenuItem[] }
  | { colors: string[]; current: string; pick: (color: string) => unknown }
  | 'separator';
export type MenuPlacement = { prefer?: 'above' | 'below'; align?: 'left' | 'right' };
// A menu opens from a button, or from the point that was right-clicked.
export type MenuAnchor = HTMLElement | { x: number; y: number };
type OpenMenu = { anchor: MenuAnchor; items: MenuItem[]; place: MenuPlacement };
type Tip = { anchor: HTMLElement; lines: string[] };

type Overlays = {
  openMenu(anchor: MenuAnchor, items: MenuItem[], place?: MenuPlacement): void;
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

const isElement = (a: MenuAnchor): a is HTMLElement => a instanceof HTMLElement;
const rectOf = (a: MenuAnchor): DOMRect => (isElement(a) ? a.getBoundingClientRect() : new DOMRect(a.x, a.y, 0, 0));

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
      if (isElement(anchor) && closedByAnchor.current === anchor) {
        closedByAnchor.current = null;
        return;
      }
      closedByAnchor.current = null;
      setTip(null);
      setMenu({ anchor, items, place });
    },
    closeMenu: () => setMenu(null),
    showTip: (anchor, lines) => setTip({ anchor, lines }),
    hideTip: () => setTip(null),
  };

  // A layout effect, so Escape and outside clicks are heard from the commit
  // that puts the menu on screen. A plain effect waits for the next paint,
  // and a key pressed in between would leave the menu open.
  useLayoutEffect(() => {
    if (!menu) return;
    const onOutside = (e: MouseEvent) => {
      const m = menuRef.current;
      if (!m) return;
      if ((e.target as Element).closest?.('.menu')) return;
      closedByAnchor.current = isElement(m.anchor) && m.anchor.contains(e.target as Node) ? m.anchor : null;
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
// row, so above is where the room is. Below only when the button is so close
// to the top that above would not fit, and never past an edge. From a
// right-click the menu hangs off the pointer instead.
function Menu({ anchor, items, place, close }: OpenMenu & { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sub, setSub] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const position = () => {
    const menu = ref.current;
    if (!menu) return;
    if (isElement(anchor) && !anchor.isConnected) {
      close();
      return;
    }
    const r = rectOf(anchor);
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const gap = isElement(anchor) ? 4 : 2;
    const margin = 8;
    const fitsAbove = r.top - gap - h >= margin;
    const fitsBelow = r.bottom + gap + h <= window.innerHeight - margin;
    const prefer = isElement(anchor) ? place.prefer : 'below';
    const above = prefer === 'below' ? !fitsBelow && fitsAbove : fitsAbove || !fitsBelow;
    const top = above ? r.top - gap - h : r.bottom + gap;
    const align = isElement(anchor) ? place.align : 'left';
    const left = align === 'left' ? r.left : r.right - w;
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
  }, []);
  const run = (fn: () => unknown) => {
    close();
    act(fn, isElement(anchor) ? anchor : null);
  };
  const open = sub ? items[sub.index] : null;
  return (
    <>
      <div class="menu" role="menu" ref={ref}>
        {items.map((it, i) => (
          <Item key={i} it={it} onRun={run} sub={sub?.index === i} openSub={(el) => setSub({ index: i, anchor: el })} />
        ))}
      </div>
      {open && typeof open === 'object' && 'items' in open && sub ? (
        <Submenu anchor={sub.anchor} items={open.items} onRun={run} />
      ) : null}
    </>
  );
}

function Item({
  it,
  onRun,
  sub,
  openSub,
}: {
  it: MenuItem;
  onRun: (fn: () => unknown) => void;
  sub: boolean;
  openSub: (el: HTMLElement) => void;
}) {
  if (it === 'separator') return <hr />;
  if ('header' in it) {
    return (
      <div class="menu-head">
        <b>{it.header}</b>
        {it.sub ? <span>{it.sub}</span> : null}
      </div>
    );
  }
  if ('colors' in it) {
    return (
      <div class="swatches" role="group" title="Colour">
        {it.colors.map((c) => (
          <button
            type="button"
            key={c}
            class={`swatch ${c.toLowerCase() === it.current.toLowerCase() ? 'on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => onRun(() => it.pick(c))}
          />
        ))}
        <label class="swatch custom" title="Any colour">
          <input
            type="color"
            value={it.current}
            onChange={(e) => {
              const value = (e.currentTarget as HTMLInputElement).value;
              onRun(() => it.pick(value));
            }}
          />
        </label>
      </div>
    );
  }
  if ('items' in it) {
    return (
      <button
        type="button"
        class={`sub ${sub ? 'open' : ''}`}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={sub}
        onMouseEnter={(e) => openSub(e.currentTarget as HTMLElement)}
        onClick={(e) => openSub(e.currentTarget as HTMLElement)}
      >
        {it.label}
        <span class="value">
          {it.value}
          <Icon name="right" size={13} />
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      class={`${it.danger ? 'danger' : ''} ${it.checked !== undefined ? 'checkable' : ''}`}
      role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={it.checked === undefined ? undefined : it.checked}
      disabled={it.disabled}
      onClick={() => onRun(it.run)}
    >
      {it.checked !== undefined ? <span class="tick">{it.checked ? '✓' : ''}</span> : null}
      {it.label}
    </button>
  );
}

// Beside the item that opened it, to the right when there is room.
function Submenu({
  anchor,
  items,
  onRun,
}: {
  anchor: HTMLElement;
  items: MenuItem[];
  onRun: (fn: () => unknown) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const margin = 8;
    const left = r.right + 2 + w <= window.innerWidth - margin ? r.right + 2 : r.left - 2 - w;
    const top = Math.max(margin, Math.min(r.top - 6, window.innerHeight - h - margin));
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(margin, left)}px`;
  }, [anchor]);
  return (
    <div class="menu submenu" role="menu" ref={ref}>
      {items.map((it, i) => (
        <Item key={i} it={it} onRun={onRun} sub={false} openSub={() => {}} />
      ))}
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

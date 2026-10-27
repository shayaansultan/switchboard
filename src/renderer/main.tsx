import { render } from 'preact';
import { App } from './app';

// Page zoom (View › Zoom, or ⌘+ and ⌘−) scales the page but not the traffic
// lights macOS draws over the title bar. The zoom is the window's width in
// screen points over the page's width in CSS pixels. The title bar divides the
// space it keeps for the lights by it (--zoom in style.css), and the main
// process moves the lights to the bar's centre line. A resize follows every
// zoom change, so that is when to look.
function followZoom(): void {
  const ratio = window.outerWidth / window.innerWidth;
  const zoom = Number.isFinite(ratio) && ratio > 0.25 && ratio < 5 ? Math.round(ratio * 1000) / 1000 : 1;
  document.documentElement.style.setProperty('--zoom', String(zoom));
  window.sb.reportZoom?.(zoom);
}
followZoom();
window.addEventListener('resize', followZoom);

render(<App />, document.getElementById('app') as HTMLElement);

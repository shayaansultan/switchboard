// Renders build/icon.svg and build/tray.svg to PNGs using Electron itself,
// then the shell script turns them into icon.icns and tray template images.
// Usage: bunx electron build/render-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const jobs = [
  { svg: 'icon.svg', out: 'icon-1024.png', size: 1024 },
  { svg: 'tray.svg', out: 'tray-raw.png', size: 176 },
];

async function render({ svg, out, size }) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const data = fs.readFileSync(path.join(__dirname, svg), 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(data).toString('base64')}" style="width:${size}px;height:${size}px;display:block"></body></html>`;
  const tmp = path.join(__dirname, `.render-${size}.html`);
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  fs.unlinkSync(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(path.join(__dirname, out), img.toPNG());
  win.destroy();
}

app.whenReady().then(async () => {
  // One job per process: a second offscreen window in the same process fails to load.
  const only = process.argv.find((a) => a.endsWith('.svg'));
  for (const j of jobs.filter((j) => !only || j.svg === only)) await render(j);
  app.quit();
});

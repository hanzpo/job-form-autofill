// Renders the extension icons from inline SVG with headless Chromium.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");

// App icon: rounded square, a form card with lines and a lightning bolt.
const appSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4f7cff"/><stop offset="1" stop-color="#2440c9"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#g)"/>
  <rect x="120" y="104" width="240" height="304" rx="28" fill="#fff"/>
  <rect x="156" y="152" width="120" height="22" rx="11" fill="#c7d3ff"/>
  <rect x="156" y="204" width="168" height="22" rx="11" fill="#c7d3ff"/>
  <rect x="156" y="256" width="96" height="22" rx="11" fill="#c7d3ff"/>
  <path d="M352 236 L292 336 H338 L318 420 L396 306 H348 L372 236 Z" fill="#ffcf3f" stroke="#2440c9" stroke-width="14" stroke-linejoin="round"/>
</svg>`;

// Toolbar icon: monochrome template-style glyph (Safari tints toolbar icons).
const toolbarSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="5" y="3.5" width="17" height="25" rx="3" fill="none" stroke="#000" stroke-width="2.4"/>
  <rect x="9" y="9" width="8" height="2.4" rx="1.2"/>
  <rect x="9" y="14" width="6" height="2.4" rx="1.2"/>
  <path d="M24 13 L18.5 22 H22.5 L21 29 L28 19 H24 L26.5 13 Z" fill="#000"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, file), omitBackground: true });
}
for (const s of [48, 96, 128, 256, 512]) await render(appSvg, s, `icon-${s}.png`);
for (const s of [16, 32]) await render(toolbarSvg, s, `toolbar-${s}.png`);
await browser.close();
console.log("icons written to", out);

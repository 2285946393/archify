import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../archify/bin/visual-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'archify');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;

test('Viewer toolbars move focus between enabled top-level controls with directional keys', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser toolbar keyboard checks.',
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-toolbar-keyboard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(skill, 'examples', 'web-app.architecture.json');
  const artifact = path.join(directory, 'diagram.html');
  execFileSync(process.execPath, [path.join(skill, 'bin/archify.mjs'), 'render', 'architecture', input, artifact]);

  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  async function observe(width) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(artifact).href });
    await loaded;
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const key = value => new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
        const run = (toolbar, selector) => {
          const controls = [...toolbar.querySelectorAll(selector)].filter(button => !button.disabled && !button.hidden && button.getClientRects().length);
          const identify = () => document.activeElement.id || document.activeElement.getAttribute('data-view');
          controls[0].focus(); const first = identify();
          const right = controls[0].dispatchEvent(key('ArrowRight')); const second = identify();
          controls[1].dispatchEvent(key('ArrowLeft')); const returned = identify();
          controls[1].dispatchEvent(key('End')); const end = identify();
          document.activeElement.dispatchEvent(key('Home')); const home = identify();
          return { count: controls.length, first, second, returned, end, home, right };
        };
        return {
          page: run(document.querySelector('.toolbar'), ':scope > .toolbar-group > button'),
          dock: run(document.querySelector('.diagram-nav'), ':scope > button')
        };
      })()`, returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    for (const [name, value] of Object.entries(result.result.value)) {
      assert.ok(value.count > 2, `${width}/${name}: expected several enabled controls`);
      assert.notEqual(value.first, value.second, `${width}/${name}: ArrowRight moves focus`);
      assert.equal(value.returned, value.first, `${width}/${name}: ArrowLeft returns focus`);
      assert.equal(value.home, value.first, `${width}/${name}: Home selects first control`);
      assert.equal(value.right, false, `${width}/${name}: handled key prevents default`);
    }
  }
  await observe(1440);
  await observe(640);
});

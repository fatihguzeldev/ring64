import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve('.');
const html = `<!doctype html><meta charset="utf-8"><title>ring64 execution checks</title>
<script type="module" src="/build/tests/execution/browser.js"></script>`;

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}/build/`)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, {
      'content-type': extname(file) === '.wasm' ? 'application/wasm' : 'text/javascript',
      'cache-control': 'no-store',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
let browser;
try {
  let executablePath = process.env.RING64_BROWSER;
  if (!executablePath && process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try {
      await access(chrome);
      executablePath = chrome;
    } catch {
      /* use Playwright Chromium */
    }
  }
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.ring64Result !== undefined);
  const encoded = await page.evaluate(async () => await window.ring64Result);
  if (errors.length) throw new Error(errors.join('\n'));
  const result = JSON.parse(encoded);
  const binary = await readFile('build/ring64.wasm');
  const evidence = {
    browser: browser.version(),
    headless: true,
    coreSha256: createHash('sha256').update(binary).digest('hex'),
    tools: {
      rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
      cargo: execFileSync('cargo', ['--version'], { encoding: 'utf8' }).trim(),
      node: process.version,
      typescript: JSON.parse(await readFile('node_modules/typescript/package.json', 'utf8'))
        .version,
      playwright: JSON.parse(await readFile('node_modules/playwright/package.json', 'utf8'))
        .version,
    },
    lockHashes: {
      cargo: createHash('sha256')
        .update(await readFile('Cargo.lock'))
        .digest('hex'),
      npm: createHash('sha256')
        .update(await readFile('package-lock.json'))
        .digest('hex'),
    },
    coreBytes: binary.length,
    ...result,
  };
  await mkdir('build/verification', { recursive: true });
  await writeFile('build/verification/browser.json', JSON.stringify(evidence, null, 2));
  console.log(
    `browser ${evidence.browser}: ${evidence.conformance.passed.length} scenarios passed; evidence build/verification/browser.json`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

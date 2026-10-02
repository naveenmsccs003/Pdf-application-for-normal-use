/**
 * Tests for the desktop app's PDFium mode, run in headless Chrome.
 * Starts the desktop host in test mode (no window) and replaces the native bridge
 * (window.external) with one that opens files by path.
 *
 *   npm run fixtures && npm run test:desktop
 *
 * Environment: DOTNET (default "dotnet"), BROWSER_PATH, DESKTOP_TEST_PORT (default 5011).
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const PORT = process.env.DESKTOP_TEST_PORT || '5011';
const APP_URL = `http://127.0.0.1:${PORT}/`;
const DOTNET = process.env.DOTNET || 'dotnet';
const CHROME = process.env.BROWSER_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));

let passed = 0, failed = 0, skipped = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function skip(name, reason) { skipped++; console.log('SKIP ' + name + ' (' + reason + ')'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixture = f => path.join(FIXTURES, f);
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

async function startHost() {
    const project = path.join(__dirname, '..', 'desktop');
    const host = spawn(DOTNET, ['run', '--project', project], {
        env: { ...process.env, PDFVIEWER_TEST_PORT: PORT, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    host.stdout.on('data', d => { output += d; });
    host.stderr.on('data', d => { output += d; });
    for (let i = 0; i < 240; i++) {
        try { if ((await fetch(APP_URL)).ok) return host; } catch { /* not up yet */ }
        if (host.exitCode !== null) break;
        await sleep(500);
    }
    host.kill();
    throw new Error('Desktop host did not start:\n' + output);
}

(async () => {
    if (!fs.existsSync(fixture('ten-pages.pdf'))) { console.error('Test files missing. Run: npm run fixtures'); process.exit(2); }
    if (!CHROME) { console.error('Chrome not found. Set BROWSER_PATH.'); process.exit(2); }

    console.log('Starting desktop host in test mode (first run builds the project)...');
    const host = await startHost();
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    let exitCode = 0;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        const consoleErrors = [];
        page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn') consoleErrors.push(m.text()); });
        page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

        // Stand-in for Photino's bridge: "open" opens window.__nextOpenPath through the test endpoint.
        await page.evaluateOnNewDocument(() => {
            const listeners = [];
            const bridge = {
                sendMessage(raw) {
                    const message = JSON.parse(raw);
                    window.__sent = (window.__sent || []).concat(message.type);
                    if (message.type !== 'open') return;
                    fetch('/api/test/open', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: window.__nextOpenPath })
                    }).then(r => r.json()).then(replies => {
                        replies.forEach(reply => listeners.forEach(l => l(JSON.stringify(reply))));
                        window.__openReplies = (window.__openReplies || 0) + 1;
                    });
                },
                receiveMessage(callback) { listeners.push(callback); }
            };
            Object.defineProperty(window, 'external', { value: bridge, configurable: true });
        });

        await page.goto(APP_URL, { waitUntil: 'load' });
        await page.waitForSelector('.toolbar');

        const state = () => page.evaluate(() => {
            const q = s => document.querySelector(s);
            const canvas = q('.canvas-layer canvas');
            const scroll = q('.viewer-scroll');
            const pad = parseFloat(getComputedStyle(scroll).paddingLeft) * 2;
            let inked = 0;
            if (canvas) {
                const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                for (let i = 0; i < data.length; i += 4) if (data[i] < 128) inked++;
            }
            return {
                empty: !!q('.empty-state'),
                hint: q('.empty-state .hint') ? q('.empty-state .hint').textContent.trim() : '',
                openIsButton: !!q('.toolbar button.tool-primary') && !q('.toolbar input[type=file]'),
                error: q('.alert') ? q('.alert span').textContent.trim() : '',
                fileName: q('.file-name') ? q('.file-name').textContent.trim() : '',
                pageStatus: 'Page: ' + (q('.page-input').value || '–') + ' / ' + q('.page-total').textContent.replace('of', '').trim(),
                zoom: q('.zoom-value').textContent.trim(),
                canvasW: canvas ? parseFloat(canvas.style.width) : 0,
                canvasH: canvas ? parseFloat(canvas.style.height) : 0,
                inked,
                availW: scroll.clientWidth - pad, availH: scroll.clientHeight - pad,
                highlights: [...document.querySelectorAll('.highlight:not(.is-draft)')].map(h => ({ l: parseFloat(h.style.left), w: parseFloat(h.style.width) })),
                sent: window.__sent || []
            };
        });
        const settle = async (timeout = 30000) => {
            await sleep(150);
            await page.waitForFunction(() => !document.querySelector('.loading') && !document.querySelector('.viewer-scroll.is-rendering'), { timeout });
            await sleep(300);
        };
        const click = async label => {
            await page.evaluate(l => (document.querySelector(`button[aria-label="${l}"]`) ||
                [...document.querySelectorAll('button')].find(b => b.textContent.trim() === l)).click(), label);
            await settle();
        };
        const open = async (file, timeout) => {
            await page.evaluate(p => { window.__nextOpenPath = p; }, path.isAbsolute(file) ? file : fixture(file));
            const before = await page.evaluate(() => window.__openReplies || 0);
            const t0 = Date.now();
            await click('Open PDF');
            // Wait for the host's reply to this open, then for the page to render.
            await page.waitForFunction(n => (window.__openReplies || 0) > n, { timeout: timeout || 30000 }, before);
            await settle(timeout);
            return Date.now() - t0;
        };
        const drag = async (x1, y1, x2, y2) => {
            const box = await (await page.$('.interaction-layer')).boundingBox();
            await page.mouse.move(box.x + x1, box.y + y1); await page.mouse.down();
            await page.mouse.move(box.x + x2, box.y + y2, { steps: 6 }); await page.mouse.up(); await sleep(150);
        };
        const dismiss = async () => { if (await page.$('.alert-close')) { await page.click('.alert-close'); await sleep(100); } };
        let s, ms;

        s = await state();
        check('desktop mode: Open PDF is a button (native dialog), no file input', s.openIsButton);
        check('desktop mode: large-file hint', /very large files/.test(s.hint), s.hint);
        check('desktop mode: UI told host it is ready', s.sent.includes('ready'), s.sent);

        // ----- Invalid files -----
        await open('notes.txt'); s = await state(); check('non-PDF rejected', s.error === 'The selected file is not a valid PDF.', s.error); await dismiss();
        await open('empty.pdf'); s = await state(); check('empty file rejected', s.error === 'The selected file is empty.', s.error); await dismiss();
        await open('corrupt.pdf'); s = await state(); check('corrupt PDF rejected', s.error === 'The selected file is not a valid PDF.', s.error); await dismiss();
        await open('does-not-exist.pdf'); s = await state(); check('missing file reported', s.error === 'The selected file could not be found.', s.error); await dismiss();
        if (fs.existsSync(fixture('password.pdf'))) {
            await open('password.pdf'); s = await state();
            check('password-protected PDF reported', s.error === 'This PDF is password-protected and cannot be opened.', s.error); await dismiss();
        } else skip('password-protected PDF', 'fixture needs Ghostscript');
        check('still on empty state after errors', (await state()).empty);

        // ----- Normal document -----
        await open('ten-pages.pdf'); s = await state();
        check('10-page PDF opens via PDFium', s.pageStatus === 'Page: 1 / 10' && s.fileName === 'ten-pages.pdf' && !s.error, s);
        check('page rendered at 100% with content', s.canvasW === 595 && s.canvasH === 842 && s.inked > 1000, [s.canvasW, s.canvasH, s.inked]);
        await click('Next page'); s = await state(); check('Next -> page 2', s.pageStatus === 'Page: 2 / 10' && s.inked > 1000);
        await click('Zoom in'); s = await state(); check('zoom 125% re-renders', s.zoom === '125%' && near(s.canvasW, 743.75) && s.inked > 1000, [s.zoom, s.canvasW]);
        await click('Fit Page'); s = await state(); check('Fit Page', s.canvasH <= s.availH && s.availH - s.canvasH < 3, [s.canvasH, s.availH]);
        await click('Fit Width'); s = await state(); check('Fit Width', s.canvasW <= s.availW && s.availW - s.canvasW < 3, [s.canvasW, s.availW]);

        await click('Highlight'); await drag(40, 100, 300, 130); s = await state();
        const k1 = s.canvasW / 595, hlW = s.highlights[0] && s.highlights[0].w / k1;
        check('highlight created', s.highlights.length === 1);
        await click('Zoom out'); s = await state(); const k2 = s.canvasW / 595;
        check('highlight follows zoom (PDFium mode)', s.highlights.length === 1 && near(s.highlights[0].w, hlW * k2), [s.highlights[0], hlW * k2]);
        await click('Next page'); s = await state(); check('highlight stays on its page', s.highlights.length === 0);
        await click('Previous page'); s = await state(); check('highlight restored on its page', s.highlights.length === 1);
        await click('Highlight');

        // ----- Failed open keeps the current document -----
        await open('corrupt.pdf'); await dismiss(); await click('Next page'); s = await state();
        check('previous document still works after failed open', s.pageStatus === 'Page: 3 / 10' && s.inked > 1000 && !s.error, s.pageStatus);

        // ----- Orientation and real-world content -----
        await open('rotated.pdf'); await click('Reset zoom'); s = await state();
        check('rotated 90° page is landscape', s.canvasW === 842 && s.canvasH === 595 && s.inked > 1000, [s.canvasW, s.canvasH]);
        await open('mixed-sizes.pdf'); await click('Fit Page');
        let allFit = true;
        for (let p = 1; p <= 5; p++) { s = await state(); allFit = allFit && s.canvasW <= s.availW + 1 && s.canvasH <= s.availH + 1; if (p < 5) await click('Next page'); }
        check('mixed page sizes all fit', allFit);
        if (fs.existsSync(fixture('tracemonkey.pdf'))) {
            await open('tracemonkey.pdf'); await click('Fit Width'); s = await state();
            check('real-world PDF renders', s.pageStatus === 'Page: 1 / 14' && s.inked > 5000, [s.pageStatus, s.inked]);
            await page.screenshot({ path: path.join(__dirname, 'screenshots', 'desktop-real-world.png') });
        } else skip('real-world PDF', 'fixture not downloaded');

        // ----- Large files -----
        ms = await open('large-45mb.pdf', 60000); s = await state();
        check(`45 MB PDF opens (${ms} ms)`, s.pageStatus === 'Page: 1 / 2' && s.inked > 0 && !s.error, s.error);
        ms = await open('large-150.pdf'); s = await state();
        check(`150-page PDF opens (${ms} ms)`, s.pageStatus === 'Page: 1 / 150');

        if (fs.existsSync(fixture('huge-8gb-classic.pdf'))) {
            ms = await open('huge-8gb-classic.pdf', 60000); s = await state();
            check(`8 GB PDF opens (${ms} ms)`, s.pageStatus === 'Page: 1 / 2' && s.inked > 500 && !s.error && ms < 15000, [s.pageStatus, s.error]);
            const t0 = Date.now(); await click('Next page'); s = await state();
            check(`8 GB PDF: page stored at the end of the file renders (${Date.now() - t0} ms)`, s.pageStatus === 'Page: 2 / 2' && s.inked > 500 && !s.error);
            await page.screenshot({ path: path.join(__dirname, 'screenshots', 'desktop-8gb.png') });

            ms = await open('huge-60gb-xrefstream.pdf', 60000); s = await state();
            check(`60 GB PDF with compressed index rejected quickly (${ms} ms)`,
                s.error.startsWith('This PDF is larger than 4 GB and uses a compressed page index') && ms < 5000, s.error);
            await dismiss();
            check('8 GB document still open after the rejection', s.fileName === 'huge-8gb-classic.pdf', s.fileName);
        } else skip('huge sparse PDFs', 'not generated on this platform');

        // ----- Security: API only serves the opened file -----
        const probe = await page.evaluate(async () => {
            const bad = await fetch('/api/local/00000000-0000-0000-0000-000000000000/pages/1').then(r => r.status);
            const traversal = await fetch('/api/local/..%2f..%2fetc%2fpasswd/pages/1').then(r => r.status);
            const badScale = await fetch(document.querySelector('.canvas-layer') ? '/api/local/00000000-0000-0000-0000-000000000000/pages/1?scale=999' : '').then(r => r.status);
            return { bad, traversal, badScale };
        });
        check('unknown token -> 404', probe.bad === 404, probe);
        check('path-like token -> 404', probe.traversal === 404, probe);
        check('out-of-range scale rejected', probe.badScale === 400 || probe.badScale === 404, probe);

        // The pixel checks above use getImageData, which makes Chrome log a performance hint.
        const unexpected = consoleErrors.filter(e => !/status of (400|404)/.test(e) && !/willReadFrequently/.test(e));
        check('no unexpected console errors', unexpected.length === 0, unexpected);
    } catch (e) {
        console.error(e);
        exitCode = 2;
    } finally {
        await browser.close();
        host.kill();
    }
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(exitCode || (failed ? 1 : 0));
})();

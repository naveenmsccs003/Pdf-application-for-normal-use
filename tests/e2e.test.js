/**
 * End-to-end UI tests for the PDF viewer.
 *
 *   1. Start the app:          cd backend && dotnet run
 *   2. Generate test files:    cd tests && npm install && npm run fixtures
 *   3. Run:                    npm test                 (Chrome)
 *                              npm run test:firefox     (Firefox)
 *
 * Browser: first argument or BROWSER env (chrome|firefox). Also APP_URL, BROWSER_PATH.
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const APP_URL = process.env.APP_URL || 'http://localhost:5000/';
const BROWSER = (process.argv[2] || process.env.BROWSER || 'chrome').toLowerCase();
const SCREENSHOTS = path.join(__dirname, 'screenshots');

const CANDIDATE_PATHS = {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    firefox: ['/snap/firefox/current/usr/lib/firefox/firefox', '/usr/lib/firefox/firefox', '/usr/bin/firefox',
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe', '/Applications/Firefox.app/Contents/MacOS/firefox']
};

let passed = 0, failed = 0, skipped = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function skip(name, reason) { skipped++; console.log('SKIP ' + name + ' (' + reason + ')'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasFixture = f => fs.existsSync(path.join(FIXTURES, f));

(async () => {
    if (!hasFixture('ten-pages.pdf')) {
        console.error('Test files missing. Run: npm run fixtures');
        process.exit(2);
    }
    const executablePath = process.env.BROWSER_PATH || CANDIDATE_PATHS[BROWSER].find(p => fs.existsSync(p));
    if (!executablePath) {
        console.error('No ' + BROWSER + ' found. Set BROWSER_PATH.');
        process.exit(2);
    }
    fs.mkdirSync(SCREENSHOTS, { recursive: true });

    console.log(`Browser: ${BROWSER} (${executablePath})\nApp:     ${APP_URL}\n`);
    const browser = await puppeteer.launch({
        browser: BROWSER, executablePath, headless: true,
        args: BROWSER === 'chrome' ? ['--no-sandbox'] : []
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + (e.message || e)));

    try {
        await page.goto(APP_URL, { waitUntil: 'load' });
    } catch (e) {
        console.error('Cannot reach ' + APP_URL + ' - is the app running? (cd backend && dotnet run)');
        await browser.close();
        process.exit(2);
    }
    await page.waitForSelector('.toolbar');

    // ----- helpers -----
    const state = () => page.evaluate(() => {
        const q = s => document.querySelector(s);
        const label = b => b.textContent.replace(/[‹›]/g, '').trim();
        const btn = t => [...document.querySelectorAll('.toolbar button')].find(b => label(b) === t);
        const canvas = q('.canvas-layer canvas');
        const scroll = q('.viewer-scroll');
        const pad = parseFloat(getComputedStyle(scroll).paddingLeft) * 2;
        return {
            empty: !!q('.empty-state'),
            error: q('.alert') ? q('.alert span').textContent.trim() : '',
            fileName: q('.file-name') ? q('.file-name').textContent.trim() : '',
            pageStatus: q('.page-status').textContent.trim(),
            status: q('.status-text').textContent.trim(),
            zoom: q('.zoom-value').textContent.trim(),
            canvasW: canvas ? parseFloat(canvas.style.width) : 0,
            canvasH: canvas ? parseFloat(canvas.style.height) : 0,
            availW: scroll.clientWidth - pad, availH: scroll.clientHeight - pad,
            hScroll: scroll.scrollWidth > scroll.clientWidth, vScroll: scroll.scrollHeight > scroll.clientHeight,
            canvases: document.querySelectorAll('canvas').length,
            highlights: [...document.querySelectorAll('.highlight:not(.is-draft)')].map(h => ({
                l: parseFloat(h.style.left), t: parseFloat(h.style.top), w: parseFloat(h.style.width), h: parseFloat(h.style.height),
                sel: h.classList.contains('is-selected')
            })),
            disabled: Object.fromEntries(['Prev', 'Next', 'Fit Page', 'Fit Width', 'Highlight', 'Remove', 'Clear Highlights']
                .map(t => [t, btn(t).disabled])),
            zoomOutDisabled: q('[aria-label="Zoom out"]').disabled,
            zoomInDisabled: q('[aria-label="Zoom in"]').disabled
        };
    });
    const settle = async (timeout = 20000) => {
        await sleep(150);
        await page.waitForFunction(() => !document.querySelector('.loading') && !document.querySelector('.viewer-scroll.is-rendering'), { timeout });
        await sleep(350);
    };
    const click = async label => {
        await page.evaluate(l => [...document.querySelectorAll('.toolbar button')]
            .find(b => b.textContent.replace(/[‹›]/g, '').trim() === l || b.getAttribute('aria-label') === l).click(), label);
        await settle();
    };
    const open = async (file, timeout) => {
        const input = await page.$('.toolbar input[type=file]');
        await input.uploadFile(path.join(FIXTURES, file));
        await sleep(300);
        await settle(timeout);
    };
    const goTo = async n => {
        // Select the current value first (a synthetic triple-click does not select in Firefox number inputs).
        await page.focus('.page-input');
        await page.$eval('.page-input', el => el.select());
        await page.keyboard.type(String(n));
        await page.keyboard.press('Enter');
        await settle();
    };
    const layerBox = async () => (await page.$('.interaction-layer')).boundingBox();
    const drag = async (x1, y1, x2, y2) => {
        const box = await layerBox();
        await page.mouse.move(box.x + x1, box.y + y1);
        await page.mouse.down();
        await page.mouse.move(box.x + (x1 + x2) / 2, box.y + (y1 + y2) / 2, { steps: 4 });
        await page.mouse.move(box.x + x2, box.y + y2, { steps: 4 });
        await page.mouse.up();
        await sleep(150);
    };
    const clickAt = async (x, y) => { const box = await layerBox(); await page.mouse.click(box.x + x, box.y + y); await sleep(150); };
    const dismissError = async () => { if (await page.$('.alert-close')) { await page.click('.alert-close'); await sleep(100); } };
    const shot = name => page.screenshot({ path: path.join(SCREENSHOTS, `${BROWSER}-${name}.png`) });
    const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
    let s;

    // ===== Initial state =====
    s = await state();
    check('initial empty state', s.empty && s.pageStatus === 'Page: – / –', s.pageStatus);
    check('all buttons disabled without a document', Object.values(s.disabled).every(Boolean) && s.zoomInDisabled && s.zoomOutDisabled, s.disabled);
    await shot('01-empty');

    // ===== Invalid files (before any document is open) =====
    await open('notes.txt'); s = await state();
    check('non-PDF file rejected', s.error === 'Please select a PDF file.', s.error);
    await open('fake.pdf'); s = await state();
    check('fake .pdf rejected by server', s.error === 'The selected file is not a valid PDF.', s.error);
    await open('empty.pdf'); s = await state();
    check('empty file rejected', s.error === 'The selected file is empty.', s.error);
    await open('too-large.pdf'); s = await state();
    check('file over 50 MB rejected', s.error.startsWith('The selected file is too large'), s.error);
    await open('corrupt.pdf'); s = await state();
    check('corrupt PDF (valid header, broken body) shows friendly error', s.error === 'The selected file is not a valid PDF.' || s.error === 'Unable to open this PDF.', s.error);
    check('still on empty state after errors', s.empty);

    // ===== 10-page PDF: open + navigation =====
    await open('ten-pages.pdf'); s = await state();
    check('10-page PDF opens on page 1', s.pageStatus === 'Page: 1 / 10' && !s.empty && !s.error, s.pageStatus);
    check('rendered at 100%', s.zoom === '100%' && s.canvasW === 595 && s.canvasH === 842, [s.zoom, s.canvasW, s.canvasH]);
    check('Prev disabled on first page', s.disabled.Prev && !s.disabled.Next);
    await shot('02-opened');

    await click('Next'); s = await state(); check('Next -> page 2', s.pageStatus === 'Page: 2 / 10', s.pageStatus);
    await click('Prev'); s = await state(); check('Prev -> page 1', s.pageStatus === 'Page: 1 / 10', s.pageStatus);
    await goTo(10); s = await state();
    check('jump to page 10, Next disabled', s.pageStatus === 'Page: 10 / 10' && s.disabled.Next && !s.disabled.Prev, s.pageStatus);
    await goTo(99); s = await state();
    check('invalid page number rejected', s.error.startsWith('Please enter a page number between 1 and 10') && s.pageStatus === 'Page: 10 / 10', s.error);
    await dismissError();
    await clickAt(5, 5);
    await page.keyboard.press('ArrowLeft'); await settle(); s = await state();
    check('ArrowLeft -> page 9', s.pageStatus === 'Page: 9 / 10', s.pageStatus);
    await goTo(1);

    // ===== Failed open keeps the current document =====
    await open('corrupt.pdf'); s = await state();
    check('failed open shows error', !!s.error, s.error);
    await dismissError();
    await click('Next'); s = await state();
    check('previous document still works after failed open', s.pageStatus === 'Page: 2 / 10' && s.canvasW === 595 && !s.error, [s.pageStatus, s.error]);
    await click('Prev');

    // ===== Zoom =====
    await click('Zoom in'); s = await state(); check('zoom in -> 125%', s.zoom === '125%' && near(s.canvasW, 743.75), [s.zoom, s.canvasW]);
    await click('Zoom in'); await click('Zoom in'); s = await state(); check('zoom in -> 200%', s.zoom === '200%' && s.canvasW === 1190, [s.zoom, s.canvasW]);
    for (let i = 0; i < 4; i++) await click('Zoom out');
    s = await state(); check('zoom out -> 75%', s.zoom === '75%' && near(s.canvasW, 446.25), [s.zoom, s.canvasW]);
    await click('Reset zoom'); s = await state(); check('reset zoom -> 100%', s.zoom === '100%' && s.canvasW === 595, [s.zoom, s.canvasW]);
    for (let i = 0; i < 10; i++) await click('Zoom out');
    s = await state(); check('zoom out stops at 25% and disables', s.zoom === '25%' && s.zoomOutDisabled, s.zoom);
    for (let i = 0; i < 12; i++) await click('Zoom in');
    s = await state(); check('zoom in stops at 300% and disables', s.zoom === '300%' && s.zoomInDisabled, s.zoom);
    await click('Reset zoom');

    // ===== Fit =====
    await click('Fit Page'); s = await state();
    check('Fit Page shows the whole page', s.canvasH <= s.availH && s.canvasW <= s.availW && s.availH - s.canvasH < 3 && !s.vScroll && !s.hScroll,
        [s.canvasW, s.canvasH, s.availW, s.availH]);
    await click('Fit Width'); s = await state();
    check('Fit Width matches viewer width', s.availW - s.canvasW < 3 && s.canvasW <= s.availW && !s.hScroll, [s.canvasW, s.availW]);

    // ===== Highlights =====
    await click('Fit Page'); await click('Highlight'); s = await state();
    check('highlight mode on', s.status.startsWith('Highlight mode'), s.status);
    const fitScale = s.canvasW / 595;
    await drag(40, 100, 300, 130); s = await state();
    check('drag creates a selected highlight', s.highlights.length === 1 && s.highlights[0].sel && near(s.highlights[0].w, 260, 2), s.highlights);
    const pdfW = s.highlights[0].w / fitScale, pdfX = s.highlights[0].l / fitScale;
    await drag(40, 200, 250, 225); s = await state(); check('multiple highlights', s.highlights.length === 2, s.highlights.length);
    await drag(40, 300, 42, 302); s = await state(); check('tiny drag does not create a highlight', s.highlights.length === 2);
    await shot('03-highlights');

    const scaleNow = async () => { const st = await state(); return [st, st.canvasW / 595]; };
    let k;
    await click('Zoom in'); [s, k] = await scaleNow();
    check('highlight follows zoom', near(s.highlights[0].l, pdfX * k) && near(s.highlights[0].w, pdfW * k), [s.highlights[0], pdfW * k]);
    await click('Fit Width'); [s, k] = await scaleNow();
    check('highlight follows Fit Width', near(s.highlights[0].w, pdfW * k), [s.highlights[0].w, pdfW * k]);
    await click('Fit Page'); [s, k] = await scaleNow();
    check('highlight follows Fit Page', near(s.highlights[0].w, pdfW * k), [s.highlights[0].w, pdfW * k]);

    await click('Next'); s = await state();
    check('page 2 shows no page-1 highlights', s.highlights.length === 0 && s.pageStatus === 'Page: 2 / 10');
    await drag(60, 60, 200, 90); s = await state(); check('highlight on page 2', s.highlights.length === 1);
    await click('Prev'); s = await state(); check('page 1 highlights restored', s.highlights.length === 2, s.highlights.length);

    await page.setViewport({ width: 900, height: 650 }); await sleep(600); await settle(); [s, k] = await scaleNow();
    check('Fit Page recomputed on window resize', s.availH - s.canvasH < 3 && s.canvasH <= s.availH, [s.canvasH, s.availH]);
    check('highlight follows window resize', near(s.highlights[0].w, pdfW * k), [s.highlights[0].w, pdfW * k]);
    await page.setViewport({ width: 1280, height: 800 }); await sleep(600); await settle();

    await page.keyboard.press('Escape'); await sleep(150); s = await state();
    check('Esc leaves highlight mode', !s.status.startsWith('Highlight mode') && s.highlights.every(h => !h.sel), s.status);
    const h0 = s.highlights[0];
    await clickAt(h0.l + h0.w / 2, h0.t + h0.h / 2); s = await state();
    check('click selects a highlight', s.highlights[0].sel && !s.disabled.Remove);
    await shot('04-selected');
    await click('Remove'); s = await state(); check('Remove deletes the selected highlight', s.highlights.length === 1 && s.disabled.Remove, s.highlights.length);
    const h1 = s.highlights[0];
    await clickAt(h1.l + 5, h1.t + 5); await page.keyboard.press('Delete'); await sleep(150); s = await state();
    check('Delete key removes the selected highlight', s.highlights.length === 0);
    await click('Highlight'); await drag(50, 50, 200, 80); await page.click('.highlight-remove'); await sleep(150); s = await state();
    check('× button removes the highlight', s.highlights.length === 0);
    await drag(50, 50, 200, 80); await click('Clear Highlights'); s = await state();
    check('Clear Highlights removes all', s.highlights.length === 0 && s.disabled['Clear Highlights']);
    await click('Next'); s = await state(); check('Clear Highlights also cleared other pages', s.highlights.length === 0);
    await click('Highlight');

    // ===== Render failure =====
    // Simulate a drawing failure part-way through rendering the next page (thrown once).
    await page.evaluate(() => {
        const proto = CanvasRenderingContext2D.prototype;
        const methods = ['fillText', 'transform', 'fill', 'drawImage', 'restore'];
        const originals = Object.fromEntries(methods.map(m => [m, proto[m]]));
        methods.forEach(m => {
            proto[m] = function () {
                methods.forEach(n => { proto[n] = originals[n]; });
                throw new Error('Simulated rendering failure');
            };
        });
    });
    await click('Next'); s = await state();
    check('render failure shows friendly error', s.error === 'Unable to display this page.', s.error);
    await dismissError();
    await click('Next'); s = await state();
    check('viewer recovers after render failure', !s.error && s.canvasW > 0 && s.pageStatus === 'Page: 4 / 10', [s.pageStatus, s.error]);

    // ===== Large page count =====
    await open('large-150.pdf'); s = await state();
    check('150-page PDF opens, highlights reset', s.pageStatus === 'Page: 1 / 150' && s.highlights.length === 0, s.pageStatus);
    let t0 = Date.now(); await goTo(150); s = await state();
    check(`jump to page 150 (${Date.now() - t0} ms)`, s.pageStatus === 'Page: 150 / 150');
    check('only one page canvas in the DOM', s.canvases === 1, s.canvases);

    // ===== Large file =====
    t0 = Date.now(); await open('large-45mb.pdf', 60000); s = await state();
    check(`45 MB PDF opens (${Date.now() - t0} ms)`, s.pageStatus === 'Page: 1 / 2' && s.canvasW > 0 && !s.error, [s.pageStatus, s.error]);
    await click('Next'); s = await state(); check('45 MB PDF page 2', s.pageStatus === 'Page: 2 / 2' && !s.error);
    await click('Prev'); await click('Zoom in'); s = await state(); check('45 MB PDF zoom', s.canvasW > 595 && !s.error, s.canvasW);
    await shot('05-large');

    // ===== Page sizes and orientation =====
    await open('mixed-sizes.pdf'); await click('Fit Page');
    for (let p = 1; p <= 5; p++) {
        s = await state();
        check(`mixed sizes: Fit Page on page ${p}`, s.canvasW <= s.availW + 1 && s.canvasH <= s.availH + 1 &&
            (s.availW - s.canvasW < 3 || s.availH - s.canvasH < 3) && !s.error, [s.canvasW, s.canvasH, s.availW, s.availH]);
        if (p < 5) await click('Next');
    }
    await click('Fit Width'); s = await state(); check('wide page Fit Width', s.availW - s.canvasW < 3 && !s.hScroll, [s.canvasW, s.availW]);
    await click('Zoom in'); await click('Zoom in'); s = await state(); check('zoomed wide page scrolls horizontally (not clipped)', s.hScroll);

    await open('landscape.pdf'); s = await state();
    check('landscape PDF', s.pageStatus === 'Page: 1 / 3' && s.canvasW > s.canvasH, [s.canvasW, s.canvasH]);

    await open('rotated.pdf'); await click('Reset zoom'); s = await state();
    check('page rotated 90° displays as landscape', s.canvasW === 842 && s.canvasH === 595, [s.canvasW, s.canvasH]);
    await click('Highlight'); await drag(100, 100, 400, 140); s = await state();
    const rotW = s.highlights[0].w;
    await click('Zoom in'); s = await state();
    check('highlight on rotated page follows zoom', near(s.highlights[0].w, rotW * 1.25), [s.highlights[0].w, rotW * 1.25]);
    await click('Highlight');
    await click('Next'); s = await state();
    check('page rotated 180° stays portrait', s.canvasH > s.canvasW && s.highlights.length === 0, [s.canvasW, s.canvasH]);
    await shot('06-rotated');

    // ===== Content types =====
    await open('image-based.pdf'); s = await state();
    check('image-based (scanned) PDF', s.pageStatus === 'Page: 1 / 3' && s.canvasW > 0 && !s.error);
    await open('form.pdf'); s = await state();
    check('PDF with form field', s.pageStatus === 'Page: 1 / 1' && s.canvasW > 0 && !s.error);
    await open('truncated.pdf'); s = await state();
    check('truncated PDF: opens or shows friendly error', (s.fileName === 'truncated.pdf' && s.canvasW > 0) ||
        ['The selected file is not a valid PDF.', 'Unable to open this PDF.'].includes(s.error), [s.pageStatus, s.error]);
    await dismissError();

    if (hasFixture('password.pdf')) {
        await open('password.pdf'); s = await state();
        check('password-protected PDF shows friendly error', s.error === 'This PDF is password-protected and cannot be opened.', s.error);
        await dismissError();
    } else skip('password-protected PDF', 'fixture needs Ghostscript');

    if (hasFixture('tracemonkey.pdf')) {
        await open('tracemonkey.pdf'); s = await state();
        check('real-world PDF (pdf.js corpus) opens', s.pageStatus === 'Page: 1 / 14' && s.canvasW > 0 && !s.error, [s.pageStatus, s.error]);
        await click('Fit Width'); await click('Highlight'); await drag(60, 150, 500, 180); s = await state();
        const tmW = s.highlights[0].w, tmScale = s.canvasW;
        await goTo(14); s = await state(); check('real-world PDF last page', s.pageStatus === 'Page: 14 / 14' && s.highlights.length === 0);
        await goTo(1); await click('Zoom out'); s = await state();
        check('real-world PDF highlight survives page change + zoom', s.highlights.length === 1 && near(s.highlights[0].w, tmW * s.canvasW / tmScale, 2),
            [s.highlights[0] && s.highlights[0].w, tmW * s.canvasW / tmScale]);
        await click('Highlight');
        await shot('07-real-world');
    } else skip('real-world PDF', 'fixture not downloaded');

    // ===== Tablet viewport =====
    await page.setViewport({ width: 768, height: 1024, isMobile: BROWSER === 'chrome', hasTouch: BROWSER === 'chrome' });
    await sleep(800);
    await open('ten-pages.pdf'); await click('Fit Width'); s = await state();
    check('tablet: Fit Width', s.availW - s.canvasW < 3 && !s.hScroll, [s.canvasW, s.availW]);
    if (BROWSER === 'chrome') {
        await click('Highlight');
        const box = await layerBox();
        const t = (x, y) => [{ x: box.x + x, y: box.y + y }];
        const cdp = await page.createCDPSession();
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: t(60, 120) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: t(150, 135) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: t(260, 150) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(200); s = await state();
        check('tablet: touch drag creates highlight', s.highlights.length === 1 && near(s.highlights[0].w, 200, 3), s.highlights);
    }
    await shot('08-tablet');

    const unexpected = consoleErrors.filter(e => !/status of (400|413)/.test(e) && !/\b(400|413)\b.*Bad Request|Payload Too Large/i.test(e));
    check('no unexpected console errors', unexpected.length === 0, unexpected);

    await browser.close();
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped  (screenshots: tests/screenshots)`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

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
const DOWNLOADS = path.join(__dirname, 'downloads');

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
    fs.rmSync(DOWNLOADS, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS, { recursive: true });

    console.log(`Browser: ${BROWSER} (${executablePath})\nApp:     ${APP_URL}\n`);
    const browser = await puppeteer.launch({
        browser: BROWSER, executablePath, headless: true,
        args: BROWSER === 'chrome' ? ['--no-sandbox'] : []
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    // Chrome: save downloads to a folder so the tool results can be checked.
    // Firefox: headless downloads can freeze the tab after a few files, so download links are only
    // recorded there (the tool's result message is still checked).
    let canCheckDownloads = false;
    if (BROWSER === 'chrome') {
        const cdp = await page.createCDPSession();
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
        canCheckDownloads = true;
    } else {
        await page.evaluateOnNewDocument(() => {
            const click = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                if (this.hasAttribute('download')) {
                    window.__downloads = (window.__downloads || []).concat(this.download);
                    return;
                }
                return click.call(this);
            };
        });
    }

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
        const btn = t => document.querySelector(`button[aria-label="${t}"]`);
        const canvas = q('.canvas-layer canvas');
        const scroll = q('.viewer-scroll');
        const pad = parseFloat(getComputedStyle(scroll).paddingLeft) * 2;
        return {
            empty: !!q('.empty-state'),
            error: q('.alert') ? q('.alert span').textContent.trim() : '',
            fileName: q('.file-name') ? q('.file-name').textContent.trim() : '',
            pageStatus: 'Page: ' + (q('.page-input').value || '–') + ' / ' + q('.page-total').textContent.replace('of', '').trim(),
            status: q('.status-text').textContent.trim(),
            zoom: q('.zoom-value').value.trim(),
            canvasW: canvas ? parseFloat(canvas.style.width) : 0,
            canvasH: canvas ? parseFloat(canvas.style.height) : 0,
            availW: scroll.clientWidth - pad, availH: scroll.clientHeight - pad,
            hScroll: scroll.scrollWidth > scroll.clientWidth, vScroll: scroll.scrollHeight > scroll.clientHeight,
            canvases: document.querySelectorAll('.canvas-layer canvas').length,
            thumbs: [...document.querySelectorAll('.thumb')].map(t => ({
                page: Number(t.querySelector('.thumb-frame').getAttribute('data-page')),
                current: t.classList.contains('is-current'),
                drawn: !!t.querySelector('canvas'),
                marks: t.querySelector('.thumb-marks') ? Number(t.querySelector('.thumb-marks').textContent) : 0
            })),
            markups: [...document.querySelectorAll('.markup-row')].map(r => ({
                text: r.querySelector('.markup-meta').textContent.trim(), selected: r.classList.contains('is-selected')
            })),
            highlights: [...document.querySelectorAll('.highlight:not(.is-draft)')].map(h => ({
                l: parseFloat(h.style.left), t: parseFloat(h.style.top), w: parseFloat(h.style.width), h: parseFloat(h.style.height),
                sel: h.classList.contains('is-selected')
            })),
            disabled: Object.fromEntries(['First page', 'Previous page', 'Next page', 'Last page', 'Fit Page', 'Fit Width', 'Highlight', 'Remove', 'Clear Markups']
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
        await page.evaluate(l => (document.querySelector(`button[aria-label="${l}"]`) ||
            [...document.querySelectorAll('button')].find(b => b.textContent.trim() === l)).click(), label);
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
    const typeZoom = async text => {
        await page.focus('.zoom-value');
        await page.$eval('.zoom-value', el => el.select());
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
        await settle();
    };
    const menuState = () => page.evaluate(() => ({
        file: !document.querySelector('#menu-file').hidden,
        edit: !document.querySelector('#menu-edit').hidden,
        zoom: !document.querySelector('#menu-zoom').hidden,
        focus: document.activeElement ? (document.activeElement.textContent || '').trim().replace(/\s+/g, ' ') : '',
        recent: [...document.querySelectorAll('#menu-file .menu-item-recent')].map(b => b.getAttribute('aria-label')),
        startRecent: [...document.querySelectorAll('.recent-start-name')].map(e => e.textContent.trim())
    }));
    const openMenu = async name => { await page.click(`#menu-${name}-button`); await sleep(100); };
    const menuItem = async (menu, text) => {
        await page.evaluate((m, t) => [...document.querySelectorAll(`#menu-${m} .menu-item`)]
            .find(b => b.textContent.trim().startsWith(t)).click(), menu, text);
        await settle();
    };
    const shortcut = async key => {
        await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control');
        await settle();
    };
    let s;

    // ===== Initial state =====
    s = await state();
    check('initial empty state', s.empty && s.pageStatus === 'Page: – / –', s.pageStatus);
    check('all buttons disabled without a document', Object.values(s.disabled).every(Boolean) && s.zoomInDisabled && s.zoomOutDisabled, s.disabled);
    const toolsDisabled = await page.evaluate(() => ['Split', 'Compress', 'Convert'].map(t => document.querySelector(`button[aria-label="${t}"]`).disabled));
    check('Split/Compress/Convert need a document; Merge does not', toolsDisabled.every(Boolean) &&
        !(await page.$eval('button[aria-label="Merge"]', b => b.disabled)), toolsDisabled);
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
    check('Prev disabled on first page', s.disabled['Previous page'] && !s.disabled['Next page']);
    await shot('02-opened');

    await click('Next page'); s = await state(); check('Next -> page 2', s.pageStatus === 'Page: 2 / 10', s.pageStatus);
    await click('Previous page'); s = await state(); check('Prev -> page 1', s.pageStatus === 'Page: 1 / 10', s.pageStatus);
    await goTo(10); s = await state();
    check('jump to page 10, Next disabled', s.pageStatus === 'Page: 10 / 10' && s.disabled['Next page'] && !s.disabled['Previous page'], s.pageStatus);
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
    await click('Next page'); s = await state();
    check('previous document still works after failed open', s.pageStatus === 'Page: 2 / 10' && s.canvasW === 595 && !s.error, [s.pageStatus, s.error]);
    await click('Previous page');

    // ===== Zoom =====
    await click('Zoom in'); s = await state(); check('zoom in -> 125%', s.zoom === '125%' && near(s.canvasW, 743.75), [s.zoom, s.canvasW]);
    await click('Zoom in'); await click('Zoom in'); s = await state(); check('zoom in -> 200%', s.zoom === '200%' && s.canvasW === 1190, [s.zoom, s.canvasW]);
    for (let i = 0; i < 4; i++) await click('Zoom out');
    s = await state(); check('zoom out -> 75%', s.zoom === '75%' && near(s.canvasW, 446.25), [s.zoom, s.canvasW]);
    await click('Actual size'); s = await state(); check('reset zoom -> 100%', s.zoom === '100%' && s.canvasW === 595, [s.zoom, s.canvasW]);
    for (let i = 0; i < 10; i++) await click('Zoom out');
    s = await state(); check('zoom out stops at 25% and disables', s.zoom === '25%' && s.zoomOutDisabled, s.zoom);
    for (let i = 0; i < 12; i++) await click('Zoom in');
    s = await state(); check('zoom in stops at 300% and disables', s.zoom === '300%' && s.zoomInDisabled, s.zoom);
    await click('Actual size');

    // ===== Fit =====
    await click('Fit Page'); s = await state();
    check('Fit Page shows the whole page', s.canvasH <= s.availH && s.canvasW <= s.availW && s.availH - s.canvasH < 3 && !s.vScroll && !s.hScroll,
        [s.canvasW, s.canvasH, s.availW, s.availH]);
    await click('Fit Width'); s = await state();
    check('Fit Width matches viewer width', s.availW - s.canvasW < 3 && s.canvasW <= s.availW && !s.hScroll, [s.canvasW, s.availW]);

    // ===== Custom zoom, Actual size, menus, shortcuts =====
    await typeZoom('135'); s = await state();
    check('custom zoom 135 -> 135%', s.zoom === '135%' && near(s.canvasW, 803.25), [s.zoom, s.canvasW]);
    await typeZoom('80%'); s = await state();
    check('custom zoom accepts "80%"', s.zoom === '80%' && near(s.canvasW, 476), [s.zoom, s.canvasW]);
    await typeZoom('999'); s = await state();
    check('custom zoom clamps to 300%', s.zoom === '300%' && s.zoomInDisabled, s.zoom);
    await typeZoom('abc'); s = await state();
    check('invalid custom zoom rejected, zoom kept', s.zoom === '300%' && s.error.startsWith('Enter a zoom between 25% and 300%'), [s.zoom, s.error]);
    await dismissError();
    await page.focus('.zoom-value'); await page.$eval('.zoom-value', el => el.select());
    await page.keyboard.type('50'); await page.keyboard.press('Escape'); await sleep(100);
    check('Escape reverts the typed zoom', (await page.$eval('.zoom-value', el => el.value)) === '300%');
    await page.$eval('.zoom-value', el => el.blur()); await settle();
    await click('Actual size'); s = await state();
    check('Actual size button -> 100%', s.zoom === '100%' && s.canvasW === 595, [s.zoom, s.canvasW]);

    await openMenu('file'); let m = await menuState();
    check('File menu opens on click', m.file && !m.zoom, m);
    await page.click('.app-title'); await sleep(100); m = await menuState();
    check('click outside closes the menu', !m.file, m);

    await page.focus('#menu-file-button'); await page.keyboard.press('ArrowDown'); await sleep(100); m = await menuState();
    check('ArrowDown opens File menu, focus on first item', m.file && m.focus.startsWith('Open PDF'), m);
    await page.keyboard.press('ArrowRight'); await sleep(100); m = await menuState(); s = await state();
    check('ArrowRight switches to Edit menu (page unchanged)', m.edit && !m.file && m.focus.startsWith('Find') && s.pageStatus === 'Page: 1 / 10', [m, s.pageStatus]);
    await page.keyboard.press('ArrowRight'); await sleep(100); m = await menuState(); s = await state();
    check('ArrowRight switches to Zoom menu (page unchanged)', m.zoom && !m.file && m.focus.startsWith('Zoom in') && s.pageStatus === 'Page: 1 / 10', [m, s.pageStatus]);
    await page.keyboard.press('End'); await sleep(50); m = await menuState();
    check('End -> last Zoom item', m.focus.startsWith('Custom zoom'), m.focus);
    await page.keyboard.press('ArrowUp'); await sleep(50); m = await menuState();
    check('ArrowUp moves through items', m.focus.startsWith('Actual size'), m.focus);
    await page.keyboard.press('Escape'); await sleep(100); m = await menuState();
    check('Escape closes the menu and focuses its button', !m.zoom && m.focus === 'Zoom', m);

    await openMenu('zoom'); await menuItem('zoom', 'Fit to page'); s = await state();
    const fitPagePressed = await page.$eval('button[aria-label="Fit Page"]', b => b.getAttribute('aria-pressed'));
    check('Zoom > Fit to page', fitPagePressed === 'true' && s.canvasH <= s.availH && !(await menuState()).zoom, [fitPagePressed, s.canvasH, s.availH]);
    await openMenu('zoom'); await menuItem('zoom', 'Actual size'); s = await state();
    check('Zoom > Actual size', s.zoom === '100%' && s.canvasW === 595, s.zoom);
    const customZoomDialog = () => page.evaluate(() => {
        const input = document.getElementById('custom-zoom-input');
        const error = document.querySelector('[aria-labelledby="custom-zoom-title"] .dialog-message');
        return { open: !!input, value: input ? input.value : '', focused: !!input && document.activeElement === input,
            selected: !!input && input.selectionStart === 0 && input.selectionEnd === input.value.length,
            error: error ? error.textContent.trim() : '' };
    });
    await openMenu('zoom'); await menuItem('zoom', 'Custom zoom'); await sleep(100);
    let cz = await customZoomDialog();
    check('Zoom > Custom zoom opens a dialog with the current zoom selected', cz.open && cz.value === '100' && cz.focused && cz.selected, cz);
    await page.keyboard.type('abc'); await page.keyboard.press('Enter'); await sleep(100); cz = await customZoomDialog();
    check('Custom zoom dialog: invalid value shows an error and stays open', cz.open && cz.error.startsWith('Enter a number between 25 and 300'), cz);
    await page.keyboard.press('ArrowRight'); await sleep(100); s = await state();
    check('Custom zoom dialog: page keys do not act behind it', s.pageStatus.startsWith('Page: 1'), s.pageStatus);
    await page.$eval('#custom-zoom-input', el => el.select()); await page.keyboard.type('150'); await page.keyboard.press('Enter'); await settle();
    s = await state(); cz = await customZoomDialog();
    check('Custom zoom dialog: 150 -> 150%, dialog closes', s.zoom === '150%' && !cz.open, [s.zoom, cz]);
    await openMenu('zoom'); await menuItem('zoom', 'Custom zoom'); await sleep(100);
    await page.keyboard.type('60'); await page.keyboard.press('Escape'); await sleep(100); s = await state(); cz = await customZoomDialog();
    check('Custom zoom dialog: Esc cancels', s.zoom === '150%' && !cz.open, [s.zoom, cz]);
    await openMenu('zoom'); await menuItem('zoom', 'Custom zoom'); await sleep(100);
    await page.click('.dialog-footer .tool-outline'); await sleep(100);
    check('Custom zoom dialog: Cancel closes it', !(await customZoomDialog()).open);

    await shortcut('Digit0'); s = await state();
    check(`Ctrl+0 -> 100%`, s.zoom === '100%', s.zoom);
    await shortcut('Equal'); s = await state();
    check('Ctrl+= zooms in', s.zoom === '125%', s.zoom);
    await shortcut('Minus'); s = await state();
    check('Ctrl+- zooms out', s.zoom === '100%', s.zoom);
    await shortcut('KeyS'); s = await state();
    check('Ctrl+S without highlights explains, no download', s.status.startsWith('Nothing to save yet'), s.status);
    await openMenu('file');
    const saveDisabled = await page.evaluate(() => [...document.querySelectorAll('#menu-file .menu-item')]
        .find(b => b.textContent.includes('Save copy with markups')).disabled);
    check('File > Save copy disabled without highlights', saveDisabled);
    await page.keyboard.press('Escape');

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

    await click('Next page'); s = await state();
    check('page 2 shows no page-1 highlights', s.highlights.length === 0 && s.pageStatus === 'Page: 2 / 10');
    await drag(60, 60, 200, 90); s = await state(); check('highlight on page 2', s.highlights.length === 1);
    await click('Previous page'); s = await state(); check('page 1 highlights restored', s.highlights.length === 2, s.highlights.length);

    // Markups list and thumbnails reflect the highlights
    check('markups list shows all highlights, sorted by page', s.markups.length === 3 &&
        s.markups[0].text.startsWith('Page 1') && s.markups[2].text.startsWith('Page 2'), s.markups);
    check('thumbnail badges count highlights per page', s.thumbs.find(t => t.page === 1).marks === 2 && s.thumbs.find(t => t.page === 2).marks === 1, s.thumbs);
    await page.click('.markup-row:nth-child(3) .markup-main'); await settle(); s = await state();
    check('clicking a markup opens its page and selects it', s.pageStatus === 'Page: 2 / 10' && s.highlights.length === 1 && s.markups[2].selected, [s.pageStatus, s.markups]);
    await page.click('.markup-row:nth-child(1) .markup-main'); await settle(); s = await state();
    check('clicking a markup on another page goes back', s.pageStatus === 'Page: 1 / 10' && s.markups[0].selected && s.highlights.some(h => h.sel), s.pageStatus);
    await page.keyboard.press('Escape'); await sleep(100);

    await page.setViewport({ width: 900, height: 650 }); await sleep(600); await settle(); [s, k] = await scaleNow();
    check('Fit Page recomputed on window resize', s.availH - s.canvasH < 3 && s.canvasH <= s.availH, [s.canvasH, s.availH]);
    check('highlight follows window resize', near(s.highlights[0].w, pdfW * k), [s.highlights[0].w, pdfW * k]);
    const panelsAfterNarrow = await page.evaluate(() => getComputedStyle(document.querySelector('.thumbnails-panel')).display === 'none' &&
        getComputedStyle(document.querySelector('.markups-panel')).display === 'none');
    check('side panels close when the window becomes narrow', panelsAfterNarrow);
    await page.setViewport({ width: 1280, height: 800 }); await sleep(600); await settle();
    await click('Thumbnails panel'); await click('Markups panel');

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
    await drag(50, 50, 200, 80); await click('Clear Markups'); s = await state();
    check('Clear Highlights removes all', s.highlights.length === 0 && s.disabled['Clear Markups']);
    await click('Next page'); s = await state(); check('Clear Highlights also cleared other pages', s.highlights.length === 0);
    await click('Highlight');

    // ===== Pan (hand tool) =====
    const scrollPos = () => page.$eval('.viewer-scroll', el => ({ left: el.scrollLeft, top: el.scrollTop }));
    const panPressed = () => page.$eval('button[aria-label="Pan"]', b => b.getAttribute('aria-pressed') === 'true');
    await typeZoom('300');
    check('Pan is the default tool', await panPressed() && await page.$eval('.interaction-layer', el => getComputedStyle(el).cursor === 'grab'));
    let p0 = await scrollPos();
    await drag(400, 400, 250, 300); let p1 = await scrollPos(); s = await state();
    check('Pan: dragging the page moves around it', near(p1.left - p0.left, 150, 3) && near(p1.top - p0.top, 100, 3) && s.highlights.length === 0, [p0, p1]);
    await click('Highlight');
    check('Highlight tool turns Pan off', !(await panPressed()));
    await page.$eval('button[aria-label="Highlight"]', b => b.blur());
    p0 = await scrollPos();
    await page.keyboard.down('Space'); await drag(400, 400, 300, 350); await page.keyboard.up('Space'); await sleep(100);
    p1 = await scrollPos(); s = await state();
    check('Pan: hold Space to pan in highlight mode', near(p1.left - p0.left, 100, 3) && near(p1.top - p0.top, 50, 3) && s.highlights.length === 0, [p0, p1, s.highlights.length]);
    await drag(400, 400, 500, 450); s = await state();
    check('Highlight mode still draws after Space is released', s.highlights.length === 1, s.highlights.length);
    p0 = await scrollPos();
    const lb = await layerBox();
    await page.mouse.move(lb.x + 400, lb.y + 400); await page.mouse.down({ button: 'middle' });
    await page.mouse.move(lb.x + 330, lb.y + 360, { steps: 4 }); await page.mouse.up({ button: 'middle' }); await sleep(150);
    p1 = await scrollPos(); s = await state();
    check('Pan: middle mouse button pans in any tool', near(p1.left - p0.left, 70, 3) && near(p1.top - p0.top, 40, 3) && s.highlights.length === 1, [p0, p1]);
    await click('Pan'); s = await state();
    check('Pan button leaves highlight mode', await panPressed() && !s.status.startsWith('Highlight mode'), s.status);
    const hp = s.highlights[0];
    await clickAt(hp.l + hp.w / 2, hp.t + hp.h / 2); s = await state();
    check('Pan: a click without moving still selects a highlight', s.highlights[0].sel, s.highlights[0]);
    await click('Clear Markups'); await click('Fit Page');

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
    await click('Next page'); s = await state();
    check('render failure shows friendly error', s.error === 'Unable to display this page.', s.error);
    await dismissError();
    await click('Next page'); s = await state();
    check('viewer recovers after render failure', !s.error && s.canvasW > 0 && s.pageStatus === 'Page: 4 / 10', [s.pageStatus, s.error]);

    // ===== Large page count =====
    await open('large-150.pdf'); s = await state();
    check('150-page PDF opens, highlights reset', s.pageStatus === 'Page: 1 / 150' && s.highlights.length === 0, s.pageStatus);
    let t0 = Date.now(); await goTo(150); s = await state();
    check(`jump to page 150 (${Date.now() - t0} ms)`, s.pageStatus === 'Page: 150 / 150');
    check('only one page canvas in the DOM', s.canvases === 1, s.canvases);
    check(`thumbnails are virtualized (${s.thumbs.length} of 150 in the DOM)`, s.thumbs.length > 0 && s.thumbs.length < 20, s.thumbs.length);
    check('current thumbnail follows page 150', s.thumbs.some(t => t.page === 150 && t.current));
    await sleep(800); s = await state();
    check('visible thumbnails are drawn', s.thumbs.filter(t => t.drawn).length >= 3, s.thumbs.filter(t => t.drawn).length);
    await click('Thumbnails panel'); await click('First page'); await click('Thumbnails panel'); await sleep(400); s = await state();
    check('reopened thumbnails panel shows the current page', s.thumbs.some(t => t.page === 1 && t.current), s.thumbs.map(t => t.page));
    await click('Last page');
    await page.click('.thumb[aria-label="Go to page 148"]'); await settle(); s = await state();
    check('clicking a thumbnail opens that page', s.pageStatus === 'Page: 148 / 150', s.pageStatus);
    await click('First page'); s = await state();
    check('First page button', s.pageStatus === 'Page: 1 / 150' && s.disabled['First page'] && !s.disabled['Last page'], s.pageStatus);
    await click('Last page'); s = await state();
    check('Last page button', s.pageStatus === 'Page: 150 / 150' && s.disabled['Last page'], s.pageStatus);
    await click('Close document'); s = await state();
    check('closing the document tab returns to the start screen', s.empty && s.pageStatus === 'Page: – / –' && s.thumbs.length === 0, s.pageStatus);
    await open('large-150.pdf');

    // ===== Large file =====
    t0 = Date.now(); await open('large-45mb.pdf', 60000); s = await state();
    check(`45 MB PDF opens (${Date.now() - t0} ms)`, s.pageStatus === 'Page: 1 / 2' && s.canvasW > 0 && !s.error, [s.pageStatus, s.error]);
    await click('Next page'); s = await state(); check('45 MB PDF page 2', s.pageStatus === 'Page: 2 / 2' && !s.error);
    await click('Previous page'); await click('Zoom in'); s = await state(); check('45 MB PDF zoom', s.canvasW > 595 && !s.error, s.canvasW);
    await shot('05-large');

    // ===== Page sizes and orientation =====
    await open('mixed-sizes.pdf'); await click('Fit Page');
    for (let p = 1; p <= 5; p++) {
        s = await state();
        check(`mixed sizes: Fit Page on page ${p}`, s.canvasW <= s.availW + 1 && s.canvasH <= s.availH + 1 &&
            (s.availW - s.canvasW < 3 || s.availH - s.canvasH < 3) && !s.error, [s.canvasW, s.canvasH, s.availW, s.availH]);
        if (p < 5) await click('Next page');
    }
    await click('Fit Width'); s = await state(); check('wide page Fit Width', s.availW - s.canvasW < 3 && !s.hScroll, [s.canvasW, s.availW]);
    await click('Zoom in'); await click('Zoom in'); s = await state(); check('zoomed wide page scrolls horizontally (not clipped)', s.hScroll);

    await open('landscape.pdf'); s = await state();
    check('landscape PDF', s.pageStatus === 'Page: 1 / 3' && s.canvasW > s.canvasH, [s.canvasW, s.canvasH]);

    await open('rotated.pdf'); await click('Actual size'); s = await state();
    check('page rotated 90° displays as landscape', s.canvasW === 842 && s.canvasH === 595, [s.canvasW, s.canvasH]);
    await click('Highlight'); await drag(100, 100, 400, 140); s = await state();
    const rotW = s.highlights[0].w;
    await click('Zoom in'); s = await state();
    check('highlight on rotated page follows zoom', near(s.highlights[0].w, rotW * 1.25), [s.highlights[0].w, rotW * 1.25]);
    await click('Highlight');
    await click('Next page'); s = await state();
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

    // ===== PDF tools (merge, split, compress, convert) =====
    const dialogState = () => page.evaluate(() => ({
        open: !!document.querySelector('.dialog'),
        items: [...document.querySelectorAll('.merge-list .merge-name')].map(e => e.textContent.trim()),
        error: (document.querySelector('.dialog-message.is-error') || {}).textContent || '',
        result: (document.querySelector('.dialog-message.is-success') || {}).textContent || '',
        runDisabled: document.querySelector('.dialog-footer .tool-primary') ? document.querySelector('.dialog-footer .tool-primary').disabled : null
    }));
    const runTool = async () => {
        await page.click('.dialog-footer .tool-primary');
        try {
            await page.waitForFunction(() => document.querySelector('.dialog-message'), { timeout: 120000 });
        } catch (e) {
            const why = await page.evaluate(() => ({
                dialog: !!document.querySelector('.dialog'),
                working: !!document.querySelector('.dialog-working'),
                runDisabled: document.querySelector('.dialog-footer .tool-primary')?.disabled
            }));
            console.log('     tool did not finish:', JSON.stringify(why));
        }
        await sleep(300);
        return dialogState();
    };
    const waitForDownload = async (name, timeout = 30000) => {
        const file = path.join(DOWNLOADS, name);
        for (let t = 0; t < timeout; t += 250) {
            if (fs.existsSync(file) && !fs.existsSync(file + '.crdownload') && fs.statSync(file).size > 0) return fs.readFileSync(file);
            await sleep(250);
        }
        return null;
    };
    const zipEntries = buf => buf.toString('latin1').split('PK\x01\x02').length - 1;   // central directory records
    const closeDialog = async () => { await page.keyboard.press('Escape'); await sleep(200); };

    await open('ten-pages.pdf');
    await click('Merge'); let d = await dialogState();
    check('merge dialog lists the open document first', d.open && d.items.length === 1 && /ten-pages\.pdf/.test(d.items[0]) && d.runDisabled, d);
    await (await page.$('.dialog input[type=file]')).uploadFile(path.join(FIXTURES, 'one-page.pdf'), path.join(FIXTURES, 'landscape.pdf'));
    await sleep(300);
    await page.click('button[aria-label="Move landscape.pdf up"]'); await sleep(100); d = await dialogState();
    check('merge list: add files and reorder', d.items.length === 3 && d.items[1] === 'landscape.pdf' && !d.runDisabled, d.items);
    await (await page.$('.dialog input[type=file]')).uploadFile(path.join(FIXTURES, 'notes.txt')); await sleep(200); d = await dialogState();
    check('merge list rejects non-PDF files', d.items.length === 3 && /Please select a PDF file/.test(d.error), d);
    d = await runTool();
    check('merge result', /Merged 3 files \(14 pages\)/.test(d.result), d);
    if (canCheckDownloads) {
        const merged = await waitForDownload('merged.pdf');
        check('merged.pdf downloaded', merged && merged.subarray(0, 5).toString() === '%PDF-', merged && merged.length);
    }
    await closeDialog();
    check('Esc closes the dialog', !(await dialogState()).open);

    await click('Split'); await page.click('input[value=ranges]'); await page.type('.inline-text', '3-99');
    d = await runTool(); check('split: invalid range reported', /outside pages 1 to 10/.test(d.error), d.error);
    await page.click('input[value=chunks]'); await page.$eval('.inline-number', e => { e.value = ''; });
    await page.type('.inline-number', '3'); await page.$eval('.inline-number', e => e.dispatchEvent(new Event('input')));
    d = await runTool(); check('split into chunks of 3', /Created 4 PDF files/.test(d.result), d);
    if (canCheckDownloads) {
        const zip = await waitForDownload('ten-pages-split.zip');
        check('split ZIP contains 4 PDFs', zip && zipEntries(zip) === 4, zip && zipEntries(zip));
    }
    await closeDialog();

    await page.keyboard.press('Escape');
    await click('Convert'); await page.click('input[value=docx]'); d = await runTool();
    check('convert to Word', /ten-pages\.docx \(text only\)/.test(d.result), d);
    if (canCheckDownloads) {
        const docx = await waitForDownload('ten-pages.docx');
        check('Word file downloaded with text', docx && docx.subarray(0, 2).toString() === 'PK', docx && docx.length);
    }
    await page.click('input[value=xlsx]'); d = await runTool();
    check('convert to Excel', /ten-pages\.xlsx \(text only\)/.test(d.result), d);
    await page.click('input[value=png]'); await page.select('.choice-indent select', 'number:72'); d = await runTool();
    check('convert to PNG images', /ten-pages-png\.zip/.test(d.result), d);
    if (canCheckDownloads) {
        const pngZip = await waitForDownload('ten-pages-png.zip');
        check('PNG ZIP has one image per page', pngZip && zipEntries(pngZip) === 10, pngZip && zipEntries(pngZip));
    }
    await closeDialog();

    await open('image-based.pdf');
    await click('Compress'); await page.click('input[value=small]'); d = await runTool();
    check('compress image-based PDF', /% smaller|already compact|Ghostscript, which is not installed/.test(d.result + d.error), d);
    await closeDialog();

    await open('ten-pages.pdf');
    await click('Merge'); d = await dialogState();
    check('merge needs at least two files', d.runDisabled === true);
    const pageBefore = (await state()).pageStatus;
    await page.keyboard.press('ArrowRight'); await sleep(300);
    check('viewer shortcuts are blocked while a dialog is open', (await state()).pageStatus === pageBefore);
    await closeDialog();

    // ===== Save highlights into a copy of the PDF =====
    // Share of yellow-ish pixels in a page-space rectangle of the rendered canvas.
    const yellowShare = rect => page.evaluate(r => {
        const canvas = document.querySelector('.canvas-layer canvas');
        const k = canvas.width / parseFloat(canvas.style.width);   // device pixels per CSS pixel
        const data = canvas.getContext('2d').getImageData(Math.round(r.x * k), Math.round(r.y * k), Math.round(r.w * k), Math.round(r.h * k)).data;
        let yellow = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 170 && data[i + 2] < 120) yellow++;
        return yellow / (data.length / 4);
    }, rect);

    await open('ten-pages.pdf'); await click('Actual size');
    check('Save with highlights disabled without highlights', await page.$eval('button[aria-label="Save with markups"]', b => b.disabled));
    await click('Highlight');
    await drag(60, 120, 360, 160); await drag(60, 300, 260, 330);
    await click('Highlight');
    check('canvas has no yellow before saving (overlay only)', await yellowShare({ x: 70, y: 125, w: 280, h: 30 }) < 0.05);
    await click('Save with markups');
    await page.waitForFunction(() => /highlight|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('save highlights reports the copy', /ten-pages-highlighted\.pdf with 2 markups/.test(s.status), s.status);
    check('viewer keeps the in-memory highlights after saving', s.highlights.length === 2);
    if (canCheckDownloads) {
        const saved = await waitForDownload('ten-pages-highlighted.pdf');
        check('highlighted copy downloaded', saved && saved.subarray(0, 5).toString() === '%PDF-', saved && saved.length);
        if (saved) {
            const input = await page.$('.toolbar input[type=file]');
            await input.uploadFile(path.join(DOWNLOADS, 'ten-pages-highlighted.pdf')); await sleep(300); await settle();
            await click('Actual size');
            const inside = await yellowShare({ x: 70, y: 125, w: 280, h: 30 });
            const outside = await yellowShare({ x: 70, y: 200, w: 280, h: 30 });
            check(`saved highlights are part of the PDF (pdf.js shows them: ${Math.round(inside * 100)}% yellow inside, ${Math.round(outside * 100)}% outside)`,
                inside > 0.5 && outside < 0.05);
        }
    }

    // ===== Markup tools: shapes, lines, freehand, notes =====
    const shapes = () => page.evaluate(() => [...document.querySelectorAll('.markup-layer g.markup')].map(g => ({
        type: g.dataset.type, stroke: g.getAttribute('stroke'), d: g.querySelector('path').getAttribute('d'),
        leader: !!g.querySelectorAll('path')[1], text: g.querySelector('text') ? [...g.querySelectorAll('tspan')].map(t => t.textContent).join('\n') : ''
    })));
    const selectionBox = () => page.evaluate(() => {
        const b = document.querySelector('.markup-selection');
        return b ? { w: parseFloat(b.style.width), h: parseFloat(b.style.height) } : null;
    });
    const toolPressed = label => page.$eval(`button[aria-label="${label}"]`, b => b.getAttribute('aria-pressed') === 'true');
    const noteDialog = () => page.evaluate(() => {
        const input = document.getElementById('note-text-input');
        const error = document.querySelector('[aria-labelledby="note-dialog-title"] .dialog-message');
        return { open: !!input, focused: !!input && document.activeElement === input,
                 title: input ? document.getElementById('note-dialog-title').textContent.trim() : '', error: error ? error.textContent.trim() : '' };
    });
    // Share of red-ish pixels in a CSS-pixel rectangle of the rendered canvas.
    const redShare = rect => page.evaluate(r => {
        const canvas = document.querySelector('.canvas-layer canvas');
        const k = canvas.width / parseFloat(canvas.style.width);
        const data = canvas.getContext('2d').getImageData(Math.round(r.x * k), Math.round(r.y * k), Math.round(r.w * k), Math.round(r.h * k)).data;
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 150 && data[i + 2] < 150) red++;   // anti-aliased edges are lighter
        return red / (data.length / 4);
    }, rect);

    await open('one-page.pdf'); await click('Actual size');
    await click('Rectangle'); s = await state();
    check('Rectangle tool: pressed, hint in the status bar', await toolPressed('Rectangle') && !(await toolPressed('Pan')) && s.status.startsWith('Rectangle:'), s.status);
    await drag(100, 100, 250, 180); let sh = await shapes(); let box = await selectionBox();
    check('Rectangle: drag draws a red rectangle, selected', sh.length === 1 && sh[0].type === 'rect' && sh[0].stroke === '#e01b24' &&
        box && near(box.w, 158, 1.5) && near(box.h, 88, 1.5), [sh, box]);
    await drag(300, 300, 302, 301); sh = await shapes();
    check('Rectangle: a tiny drag draws nothing', sh.length === 1, sh.length);
    await click('Ellipse');
    await page.keyboard.down('Shift'); await drag(300, 100, 400, 140); await page.keyboard.up('Shift');
    box = await selectionBox(); sh = await shapes();
    check('Ellipse: Shift draws a circle (selected after drawing)', sh[1].type === 'ellipse' && box && near(box.w, box.h, 1) && near(box.w, 108, 2), box);
    await click('Cloud'); await drag(80, 220, 260, 300); sh = await shapes();
    check('Cloud: scalloped outline', sh[2].type === 'cloud' && (sh[2].d.match(/A/g) || []).length >= 8, sh[2].d.slice(0, 60));
    await click('Line');
    await page.keyboard.down('Shift'); await drag(300, 220, 450, 228); await page.keyboard.up('Shift');
    box = await selectionBox(); sh = await shapes();
    check('Line: Shift snaps to horizontal', sh[3].type === 'line' && box && near(box.h, 8, 0.5) && near(box.w, 158, 2), box);
    await click('Arrow'); await drag(300, 260, 400, 320); sh = await shapes();
    check('Arrow: line plus an arrow head', sh[4].type === 'arrow' && (sh[4].d.match(/M/g) || []).length === 2, sh[4].d);
    await click('Freehand');
    const lb2 = await layerBox();
    await page.mouse.move(lb2.x + 100, lb2.y + 400); await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(lb2.x + 100 + i * 8, lb2.y + 400 + Math.sin(i / 2) * 20);
    await page.mouse.up(); await sleep(150); sh = await shapes();
    check('Freehand: follows the mouse', sh[5].type === 'pen' && (sh[5].d.match(/L/g) || []).length >= 15, (sh[5].d.match(/L/g) || []).length);

    await click('Text note'); await clickAt(100, 500); await sleep(150); let nd = await noteDialog();
    check('Text note: click opens the note dialog with the cursor in it', nd.open && nd.focused && nd.title === 'Text note', nd);
    await page.click('.dialog-footer .tool-primary'); await sleep(100); nd = await noteDialog();
    check('Text note: empty text is refused, cursor back in the text box', nd.open && nd.focused && nd.error === 'Type the note text.', nd);
    await page.keyboard.press('ArrowRight'); await sleep(100);
    check('Text note: page keys do not act behind the dialog', (await state()).pageStatus === 'Page: 1 / 1');
    await page.keyboard.type('B12 lap 50d'); await page.keyboard.press('Enter'); await page.keyboard.type('see S-301');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control'); await sleep(200);
    sh = await shapes(); nd = await noteDialog();
    check('Text note: Ctrl+Enter adds a two-line note', !nd.open && sh[6].type === 'text' && sh[6].text === 'B12 lap 50d\nsee S-301', sh[6]);
    await clickAt(200, 600); await sleep(150); await page.keyboard.type('never added'); await page.keyboard.press('Escape'); await sleep(100);
    check('Text note: Esc cancels', !(await noteDialog()).open && (await shapes()).length === 7);

    await click('Callout'); await drag(450, 450, 350, 380); await sleep(150); nd = await noteDialog();
    check('Callout: drag opens the note dialog', nd.open && nd.title === 'Callout', nd);
    await page.keyboard.type('Check column C3'); await page.click('.dialog-footer .tool-primary'); await sleep(200); sh = await shapes();
    check('Callout: note with a leader arrow to the point', sh[7].type === 'callout' && sh[7].leader && sh[7].text === 'Check column C3', sh[7]);

    await page.click('#ribbon-tab-markup'); await sleep(100);
    await page.click('.color-swatch[aria-label="Blue"]'); await click('Rectangle'); await drag(420, 560, 520, 620); sh = await shapes();
    check('Colour: Blue swatch draws blue', sh[8].stroke === '#1c71d8' && await page.$eval('.color-swatch[aria-label="Blue"]', b => b.getAttribute('aria-checked') === 'true' &&
        getComputedStyle(b).backgroundColor === 'rgb(28, 113, 216)'), sh[8].stroke);
    await page.click('.color-swatch[aria-label="Red"]');
    await page.keyboard.press('Escape'); await sleep(100);
    check('Esc returns to Pan', await toolPressed('Pan') && !(await toolPressed('Rectangle')));

    s = await state();
    const labels = await page.$$eval('.markup-row .markup-title', els => els.map(e => e.textContent.trim()));
    check('Markups panel lists every markup by type', labels.join('|') ===
        'Rectangle|Ellipse|Cloud|Line|Arrow|Freehand|Text note: B12 lap 50d|Callout: Check column C3|Rectangle', labels);
    await clickAt(375, 224); box = await selectionBox();
    check('Pan: clicking a line selects it', box && near(box.h, 8, 0.5), box);
    await page.keyboard.press('Delete'); await sleep(150); sh = await shapes();
    check('Delete removes the selected line', sh.length === 8 && !sh.some(x => x.type === 'line'), sh.map(x => x.type));
    await clickAt(150, 505); box = await selectionBox();
    check('Pan: clicking a note selects it', !!box, box);
    await page.click('.markup-selection .highlight-remove'); await sleep(150);
    check('× removes the selected note', !(await shapes()).some(x => x.type === 'text'));
    await click('Text note'); await clickAt(100, 500); await sleep(150);
    await page.keyboard.type('B12 lap 50d'); await page.click('.dialog-footer .tool-primary'); await sleep(200); await click('Text note');

    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('save markups reports the copy', /one-page-highlighted\.pdf with 8 markups/.test(s.status), s.status);
    if (canCheckDownloads) {
        const saved = await waitForDownload('one-page-highlighted.pdf');
        const raw = saved ? saved.toString('latin1') : '';
        check('saved copy has standard annotations (Square, Circle, Ink, Stamp)',
            ['Square', 'Circle', 'Ink', 'Stamp'].every(t => new RegExp('/Subtype\\s*/' + t + '\\b').test(raw)) &&
            (raw.match(/\/InkList/g) || []).length === 3, ['Square', 'Circle', 'Ink', 'Stamp'].filter(t => !new RegExp('/Subtype\\s*/' + t + '\\b').test(raw)));
        const unused = [...raw.matchAll(/(\d+) 0 obj\b/g)].map(m => m[1]).filter(n => !new RegExp('\\b' + n + ' 0 R\\b').test(raw));
        check('saved notes keep their text, no unused objects (popup appearances) in the copy',
            raw.includes('/Contents(Check column C3)') && raw.includes('/Contents(B12 lap 50d)') && unused.length === 0, unused);
        if (saved) {
            await (await page.$('.toolbar input[type=file]')).uploadFile(path.join(DOWNLOADS, 'one-page-highlighted.pdf'));
            await sleep(300); await settle(); await click('Actual size');
            const rectEdge = await redShare({ x: 98, y: 98, w: 154, h: 5 });
            const inside = await redShare({ x: 120, y: 120, w: 100, h: 40 });
            const cloud = await redShare({ x: 70, y: 210, w: 200, h: 100 });
            const note = await redShare({ x: 100, y: 500, w: 100, h: 30 });
            check(`saved markups are drawn in the copy (rect edge ${Math.round(rectEdge * 100)}%, inside ${Math.round(inside * 100)}%, cloud ${Math.round(cloud * 1000) / 10}%, note ${Math.round(note * 1000) / 10}%)`,
                rectEdge > 0.15 && inside < 0.02 && cloud > 0.02 && note > 0.01);
        }
    }

    // ===== Ribbon: tool categories =====
    const ribbon = () => page.evaluate(() => ({
        tabs: [...document.querySelectorAll('.ribbon-tab')].map(t => t.textContent.trim()),
        selected: document.querySelector('.ribbon-tab[aria-selected="true"]').textContent.trim(),
        visible: [...document.querySelectorAll('.ribbon-panel')].filter(p => p.offsetParent).map(p => p.id),
        focused: document.activeElement && document.activeElement.id,
        page: document.querySelector('.ribbon-page').textContent.replace(/\s+/g, ' ').trim(),
        zoomLevel: document.querySelector('.ribbon-zoom-level').textContent.trim()
    }));
    await open('ten-pages.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-file'); await sleep(100); let rb = await ribbon();
    check('ribbon: File, Zoom, Navigation, Markup tabs; one panel shown', rb.tabs.join('|') === 'File|Zoom|Navigation|Markup' &&
        rb.selected === 'File' && rb.visible.join() === 'ribbon-file', rb);
    await page.click('#ribbon-tab-zoom'); await sleep(100); rb = await ribbon();
    check('ribbon: Zoom tab shows the zoom tools and level', rb.visible.join() === 'ribbon-zoom' && rb.zoomLevel === '100%', rb);
    await page.click('#ribbon-zoom button[aria-label="Zoom in"]'); await settle(); rb = await ribbon(); s = await state();
    check('ribbon: Zoom in works from the ribbon', rb.zoomLevel === s.zoom && rb.zoomLevel !== '100%', [rb.zoomLevel, s.zoom]);
    await page.click('#ribbon-tab-navigation'); await sleep(100);
    await page.click('#ribbon-navigation button[aria-label="Next page"]'); await settle(); rb = await ribbon();
    check('ribbon: Navigation tab turns pages and shows the page', rb.visible.join() === 'ribbon-navigation' && rb.page === 'Page 2 of 10', rb);
    await page.focus('#ribbon-tab-navigation');
    await page.keyboard.press('ArrowRight'); await settle(); rb = await ribbon(); s = await state();
    check('ribbon: arrow keys on the tabs move to the next tab, not the next page',
        rb.selected === 'Markup' && rb.focused === 'ribbon-tab-markup' && rb.visible.join() === 'ribbon-markup' && rb.page === 'Page 2 of 10', rb);
    await page.keyboard.press('ArrowRight'); await sleep(100); rb = await ribbon();
    check('ribbon: arrow keys wrap around', rb.selected === 'File' && rb.focused === 'ribbon-tab-file', rb);
    await page.click('#ribbon-tab-markup'); await sleep(100);
    await page.click('#ribbon-markup button[aria-label="Rectangle"]'); await sleep(100);
    await page.click('#ribbon-tab-file'); await sleep(100);
    check('ribbon: the markup tool stays active on another tab', (await state()).status.startsWith('Rectangle:'));
    await page.keyboard.press('Escape'); await sleep(100); await click('Fit Page');

    // ===== Side panels =====
    await click('Thumbnails panel'); await click('Markups panel'); s = await state();
    const widePanelsClosed = await page.evaluate(() => getComputedStyle(document.querySelector('.thumbnails-panel')).display === 'none' &&
        getComputedStyle(document.querySelector('.markups-panel')).display === 'none');
    check('panel buttons hide both side panels', widePanelsClosed);
    const widerW = s.availW;
    await click('Thumbnails panel'); await click('Markups panel'); s = await state();
    check('page area shrinks when panels are shown', s.availW < widerW, [s.availW, widerW]);

    // ===== Recent files (web: kept in this browser) =====
    await openMenu('file');
    if ((await menuState()).recent.length) { await menuItem('file', 'Clear recent files'); } else { await page.keyboard.press('Escape'); }
    await open('one-page.pdf'); await open('ten-pages.pdf');
    await openMenu('file'); m = await menuState(); await page.keyboard.press('Escape');
    check('File menu lists recent files, newest first', m.recent.length === 2 &&
        m.recent[0] === 'Open recent: ten-pages.pdf' && m.recent[1] === 'Open recent: one-page.pdf', m.recent);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.toolbar'); await sleep(500);
    m = await menuState();
    check('recent files survive a reload, shown on the start screen', m.startRecent.join() === 'ten-pages.pdf,one-page.pdf', m.startRecent);
    await page.evaluate(() => [...document.querySelectorAll('.recent-start-item')].find(b => b.textContent.includes('one-page.pdf')).click());
    await settle(); s = await state();
    check('start screen: reopen a recent file', s.fileName === 'one-page.pdf' && s.pageStatus === 'Page: 1 / 1' && s.canvasW > 0 && !s.error, [s.fileName, s.pageStatus, s.error]);
    await openMenu('file'); m = await menuState();
    check('reopened file moves to the top', m.recent[0] === 'Open recent: one-page.pdf', m.recent);
    await page.evaluate(() => document.querySelector('#menu-file [aria-label="Open recent: ten-pages.pdf"]').click());
    await settle(); s = await state();
    check('File > Recent: reopen a file', s.fileName === 'ten-pages.pdf' && s.pageStatus === 'Page: 1 / 10', [s.fileName, s.pageStatus]);
    await openMenu('file'); await menuItem('file', 'Close PDF'); s = await state();
    check('File > Close PDF', s.empty && !s.fileName, s);
    await openMenu('file'); await menuItem('file', 'Clear recent files'); await sleep(200);
    await openMenu('file'); m = await menuState(); await page.keyboard.press('Escape');
    const noRecentText = await page.$eval('#menu-file', el => el.textContent.includes('No recent files'));
    check('Clear recent files empties the list and the start screen', m.recent.length === 0 && m.startRecent.length === 0 && noRecentText, m);
    if (BROWSER === 'chrome') {
        const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 3000 }), shortcut('KeyO')]);
        await chooser.accept([path.join(FIXTURES, 'one-page.pdf')]); await sleep(300); await settle(); s = await state();
        check('Ctrl+O opens the file picker', s.fileName === 'one-page.pdf', s.fileName);
        await openMenu('file'); await menuItem('file', 'Clear recent files');
    } else skip('Ctrl+O opens the file picker', 'file chooser interception is Chrome-only here');

    // ===== Find text =====
    const findState = () => page.evaluate(() => {
        const q = s => document.querySelector(s);
        const scroll = q('.viewer-scroll').getBoundingClientRect();
        const cur = q('.search-hit.is-current');
        const box = cur && cur.getBoundingClientRect();
        return {
            open: !!q('.find-bar'),
            count: q('.find-count') ? q('.find-count').textContent.trim() : '',
            query: q('#find-input') ? q('#find-input').value : '',
            focus: document.activeElement ? document.activeElement.id : '',
            page: Number(q('.page-input').value),
            canvasW: q('.canvas-layer canvas') ? parseFloat(q('.canvas-layer canvas').style.width) : 0,
            hits: [...document.querySelectorAll('.search-hit')].map(h => ({
                l: parseFloat(h.style.left), t: parseFloat(h.style.top), w: parseFloat(h.style.width), h: parseFloat(h.style.height),
                cur: h.classList.contains('is-current')
            })),
            curVisible: !!box && box.top >= scroll.top && box.bottom <= scroll.bottom && box.left >= scroll.left && box.right <= scroll.right
        };
    });
    // Waits until the search has finished ("3 of 12", "No matches"; "…" while it runs).
    const findDone = async () => {
        await page.waitForFunction(() => {
            const c = document.querySelector('.find-count');
            return c && c.textContent.trim() && !c.textContent.includes('…');
        }, { timeout: 30000 });
        await settle();
    };
    const typeFind = async text => {
        await page.focus('#find-input');
        await page.$eval('#find-input', el => el.select());
        await page.keyboard.type(text);
        await sleep(400);
        await findDone();
    };
    const pressFind = async (key, shift) => {
        if (shift) await page.keyboard.down('Shift');
        await page.keyboard.press(key);
        if (shift) await page.keyboard.up('Shift');
        await sleep(200); await settle();
    };
    const findButton = async label => { await page.click(`.find-bar button[aria-label="${label}"]`); await sleep(200); if (await page.$('.find-bar')) await findDone(); };
    let f;

    if (!(await state()).empty) { await openMenu('file'); await menuItem('file', 'Close PDF'); }
    await shortcut('KeyF'); f = await findState();
    check('find: Ctrl+F does nothing without a document', !f.open, f);

    await open('ten-pages.pdf'); await goTo(7);
    await shortcut('KeyF'); f = await findState();
    check('find: Ctrl+F opens the find bar with the cursor in it', f.open && f.focus === 'find-input', f);
    await typeFind('Page 7'); f = await findState();
    check('find: searches as you type and shows the match', f.count === '1 of 1' && f.page === 7 && f.hits.length === 1 && f.hits[0].cur, f);
    // "Page 7" is set in 26 pt Helvetica at x = 50, baseline 70 pt below the top of the page (at 100%).
    const title = f.hits[0];
    check('find: match box is on the text', near(title.l, 50, 2) && title.t < 70 && title.t + title.h > 70 && near(title.h, 26 * 1.2, 3) && title.w > 60 && title.w < 110, title);
    await shortcut('Equal'); f = await findState();
    check('find: match box follows zoom', near(f.hits[0].l / f.canvasW, title.l / 595, 0.002) && near(f.hits[0].h, title.h * 1.25, 1), [f.hits[0], f.canvasW]);
    await shortcut('Digit0');

    await typeFind('fox'); f = await findState();
    check('find: starts at the current page (30 matches per page)', f.count === '181 of 300' && f.page === 7 && f.hits.length === 30 && f.hits[0].cur, f.count);
    await pressFind('Enter'); f = await findState();
    check('find: Enter goes to the next match', f.count === '182 of 300' && f.hits[1].cur && !f.hits[0].cur, f.count);
    await pressFind('Enter', true); f = await findState();
    check('find: Shift+Enter goes to the previous match', f.count === '181 of 300' && f.hits[0].cur, f.count);

    await typeFind('Line 29 '); f = await findState();
    check('find: a match below the visible area is scrolled into view', f.curVisible && (await page.$eval('.viewer-scroll', el => el.scrollTop)) > 0, f);

    await typeFind('Page 1'); f = await findState();
    check('find: "Page 1" also matches "Page 10"; first match from page 7 on is on page 10', f.count === '2 of 2' && f.page === 10, f);
    await pressFind('Enter'); f = await findState();
    check('find: next match wraps around to the start', f.count === '1 of 2' && f.page === 1, f);
    await findButton('Whole words'); f = await findState();
    check('find: Whole words', f.count === '1 of 1' && f.page === 1, f);
    await findButton('Whole words');
    await typeFind('page 1'); f = await findState();
    check('find: ignores case by default', f.count.endsWith('of 2'), f.count);
    await findButton('Match case'); f = await findState();
    check('find: Match case', f.count === 'No matches' && f.hits.length === 0, f);
    await findButton('Match case');
    await typeFind('lazy   dog'); f = await findState();
    check('find: several spaces in the search count as one', f.count.endsWith('of 300'), f.count);

    await page.keyboard.press('Escape'); await sleep(200); f = await findState();
    check('find: Esc closes the bar and removes the marks', !f.open && f.hits.length === 0, f);
    const pageBeforeArrow = f.page;
    await page.keyboard.press('ArrowRight'); await settle();
    check('find: page keys work again after closing', (await findState()).page === pageBeforeArrow + 1);
    await page.keyboard.press('F3'); await sleep(300); await findDone(); f = await findState();
    check('find: F3 reopens the bar with the last search', f.open && f.query === 'lazy   dog' && f.count.endsWith('of 300'), f);
    await page.keyboard.press('F3'); await sleep(300); await settle();
    const afterF3 = await findState();
    check('find: F3 goes to the next match', afterF3.count !== f.count && afterF3.count.endsWith('of 300'), [f.count, afterF3.count]);
    await findButton('Close find');
    check('find: close button closes the bar', !(await findState()).open);

    await openMenu('edit'); await menuItem('edit', 'Find');
    f = await findState();
    check('find: Edit > Find opens the bar', f.open && f.focus === 'find-input', f);
    await findDone();
    await open('one-page.pdf'); await findDone(); f = await findState();
    check('find: opening another PDF searches it for the same text', f.count === '1 of 30' && f.page === 1, f.count);

    await open('rotated.pdf'); await typeFind('Page 1'); f = await findState();
    check('find: rotated page: match box turns with the text', f.count === '1 of 1' && f.hits.length === 1 && f.hits[0].h > f.hits[0].w * 2, f.hits);
    await open('image-based.pdf'); await typeFind('fox'); f = await findState();
    check('find: no matches', f.count === 'No matches' && f.hits.length === 0, f.count);
    await open('large-150.pdf'); await typeFind('the'); f = await findState();
    check('find: stops at 1000 matches', f.count === '1 of 1000+', f.count);
    if (hasFixture('tracemonkey.pdf')) {
        await open('tracemonkey.pdf'); await typeFind('trace'); f = await findState();
        const total = Number((f.count.match(/of (\d+)/) || [])[1]);
        check('find: real-world PDF', total > 100 && f.hits.length > 0 && f.hits.every(h => h.w > 5 && h.h > 5 && h.h < 30), [f.count, f.hits.slice(0, 3)]);
    } else skip('find: real-world PDF', 'tracemonkey.pdf missing');
    await shot('find');
    await page.keyboard.press('Escape'); await sleep(200);

    // ===== Light / dark theme =====
    const theme = () => page.evaluate(() => ({
        attr: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        pageBg: document.querySelector('.pdf-page') ? getComputedStyle(document.querySelector('.pdf-page')).backgroundColor : null,
        label: document.querySelector('.theme-toggle').getAttribute('aria-label')
    }));
    const LIGHT_BG = 'rgb(238, 240, 243)', DARK_BG = 'rgb(22, 24, 29)';
    let systemThemeSupported = true;
    try { await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]); } catch { systemThemeSupported = false; }
    await page.evaluate(() => localStorage.removeItem('pdfViewer.theme'));
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.toolbar'); await sleep(300);
    let th = await theme();
    if (systemThemeSupported) {
        check('theme follows system dark setting', th.attr === null && th.bg === DARK_BG && th.label === 'Switch to light mode', th);
    } else skip('theme follows system dark setting', 'media emulation unsupported in ' + BROWSER);
    await page.click('.theme-toggle'); await sleep(250); th = await theme();
    const firstChoice = th.attr;
    check('toggle switches theme', (firstChoice === 'light' && th.bg === LIGHT_BG) || (firstChoice === 'dark' && th.bg === DARK_BG), th);
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.toolbar'); await sleep(300); th = await theme();
    check('theme choice remembered after reload', th.attr === firstChoice, th);
    if (firstChoice === 'light') { await page.click('.theme-toggle'); await sleep(250); }
    await open('ten-pages.pdf'); th = await theme();
    check('dark mode: UI dark, PDF page stays white', th.attr === 'dark' && th.bg === DARK_BG && th.pageBg === 'rgb(255, 255, 255)', th);
    await click('Highlight'); await drag(40, 100, 300, 130); await click('Highlight');
    await shot('09-dark');
    await page.click('.theme-toggle'); await sleep(250); th = await theme();
    check('toggle back to light', th.attr === 'light' && th.bg === LIGHT_BG, th);
    await page.evaluate(() => localStorage.removeItem('pdfViewer.theme'));
    if (systemThemeSupported) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

    // ===== Tablet viewport =====
    await page.setViewport({ width: 768, height: 1024, isMobile: BROWSER === 'chrome', hasTouch: BROWSER === 'chrome' });
    await sleep(800);
    await open('ten-pages.pdf'); await click('Fit Width'); s = await state();
    const panelsHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.thumbnails-panel')).display === 'none');
    check('tablet: side panels closed by default', panelsHidden);
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

    // The pixel checks use getImageData, which makes Chrome log a performance hint.
    const unexpected = consoleErrors.filter(e => !/status of (400|413)/.test(e) && !/\b(400|413)\b.*Bad Request|Payload Too Large/i.test(e) && !/willReadFrequently/.test(e));
    check('no unexpected console errors', unexpected.length === 0, unexpected);

    await browser.close();
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped  (screenshots: tests/screenshots)`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

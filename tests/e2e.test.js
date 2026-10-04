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
    check('ArrowDown opens File menu, focus on first item', m.file && m.focus.startsWith('New PDF'), m);
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
    check('ribbon: File, Pages, Output, Zoom, Navigation, Markup, Measure, Review, Revision tabs; one panel shown', rb.tabs.join('|') === 'File|Pages|Output|Zoom|Navigation|Markup|Measure|Review|Revision' &&
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
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await sleep(100); }
    rb = await ribbon();
    check('ribbon: arrow keys wrap around', rb.selected === 'File' && rb.focused === 'ribbon-tab-file', rb);
    await page.click('#ribbon-tab-markup'); await sleep(100);
    await page.click('#ribbon-markup button[aria-label="Rectangle"]'); await sleep(100);
    await page.click('#ribbon-tab-file'); await sleep(100);
    check('ribbon: the markup tool stays active on another tab', (await state()).status.startsWith('Rectangle:'));
    await page.keyboard.press('Escape'); await sleep(100);

    // ===== Icon-only ribbon: name and shortcut on hover; one-key tool shortcuts =====
    const isPressed = label => page.$eval(`button[aria-label="${label}"]`, b => b.getAttribute('aria-pressed') === 'true');
    const tipState = () => page.evaluate(() => {
        const t = document.querySelector('.tool-tip');
        return { shown: !!t && !t.hidden, text: t ? t.textContent : '', key: t && t.querySelector('kbd') ? t.querySelector('kbd').textContent : '' };
    });
    await page.click('#ribbon-tab-markup'); await sleep(100);
    const labelsShown = await page.$$eval('#ribbon-markup .tool-labelled', bs => bs.filter(b => b.querySelector('svg') &&
        [...b.querySelectorAll('span')].some(sp => sp.offsetParent)).length);
    check('ribbon: buttons show only their icon', labelsShown === 0, labelsShown);
    await page.hover('#ribbon-markup button[aria-label="Rectangle"]'); await sleep(500); let tip = await tipState();
    check('ribbon: hovering shows the name and its shortcut', tip.shown && tip.text === 'RectangleR' && tip.key === 'R', tip);
    const titleHeld = await page.$eval('#ribbon-markup button[aria-label="Rectangle"]', b => !b.hasAttribute('title'));
    check("ribbon: the browser's own tooltip does not show over it", titleHeld);
    await page.hover('#ribbon-markup button[aria-label="Ellipse"]'); await sleep(100); tip = await tipState();
    check('ribbon: moving to the next button shows its name at once', tip.shown && tip.text === 'EllipseE', tip);
    await page.mouse.move(640, 500); await sleep(150); tip = await tipState();
    check('ribbon: the name goes away when the mouse leaves', !tip.shown &&
        await page.$eval('#ribbon-markup button[aria-label="Ellipse"]', b => b.hasAttribute('title')), tip);
    await page.click('#ribbon-tab-zoom'); await page.hover('#ribbon-zoom button[aria-label="Zoom in"]'); await sleep(500); tip = await tipState();
    check('ribbon: shortcuts with Ctrl are shown too', tip.shown && /^Zoom in/.test(tip.text) && /\+$/.test(tip.key), tip);
    await page.mouse.move(640, 500); await sleep(100);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('r'); await sleep(100); s = await state();
    check('shortcut: R picks Rectangle', s.status.startsWith('Rectangle:') && await isPressed('Rectangle'), s.status);
    await page.keyboard.press('d'); await sleep(100);
    check('shortcut: D picks Distance', await isPressed('Distance'));
    await page.keyboard.press('d'); await sleep(100);
    check('shortcut: the same key again goes back to Pan', !(await isPressed('Distance')) && await page.$eval('#ribbon-navigation button[aria-label="Pan tool"]', b => b.getAttribute('aria-pressed') === 'true'));
    await page.keyboard.down('Shift'); await page.keyboard.press('KeyT'); await page.keyboard.up('Shift'); await sleep(100);
    check('shortcut: Shift+T picks Replace text', await isPressed('Replace text'));
    await page.keyboard.press('v'); await sleep(100);
    check('shortcut: V goes back to Pan', await page.$eval('#ribbon-navigation button[aria-label="Pan tool"]', b => b.getAttribute('aria-pressed') === 'true'));
    await page.focus('.page-input'); await page.keyboard.press('r'); await sleep(100);
    check('shortcut: letters typed in a box are not shortcuts', !(await isPressed('Rectangle')));
    await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('End'); await settle(); s = await state();
    check('shortcut: End goes to the last page', s.pageStatus === 'Page: 10 / 10', s.pageStatus);
    await page.keyboard.press('Home'); await settle(); s = await state();
    check('shortcut: Home goes to the first page', s.pageStatus === 'Page: 1 / 10', s.pageStatus);

    // ===== More colours: any colour for markups =====
    const picker = () => page.evaluate(() => ({
        open: !!document.querySelector('.color-popover'),
        focused: document.activeElement && document.activeElement.className.split(' ')[0],
        hex: document.querySelector('.color-hex') ? document.querySelector('.color-hex').value : null,
        presets: document.querySelectorAll('[aria-label="Preset colours"] .color-cell').length,
        recent: [...document.querySelectorAll('[aria-label="Recent colours"] .color-cell')].map(c => c.title),
        custom: document.querySelector('.color-more').classList.contains('is-active')
    }));
    const lastStroke = () => page.$$eval('.markup-layer g.markup', gs => gs.length ? gs[gs.length - 1].getAttribute('stroke') : null);
    await page.click('#ribbon-tab-markup'); await sleep(100); await click('Rectangle');
    await page.click('button[aria-label="More colours"]'); await sleep(200); let cp = await picker();
    check('More colours: opens with the current colour, 72 presets, cursor in the colour square',
        cp.open && cp.hex === '#e01b24' && cp.presets === 72 && cp.focused === 'color-sv', cp);
    const svBox = await (await page.$('.color-sv')).boundingBox();
    await page.mouse.click(svBox.x + svBox.width / 2, svBox.y + svBox.height / 4); await sleep(100); cp = await picker();
    check('More colours: clicking the square sets saturation and brightness', cp.hex === '#bf6064' && cp.custom, cp);
    await page.$eval('.color-hue', e => { e.value = 120; e.dispatchEvent(new Event('input', { bubbles: true })); }); await sleep(100); cp = await picker();
    check('More colours: hue slider changes the hue', cp.hex === '#60bf60', cp);
    await page.focus('.color-sv'); await page.keyboard.down('Shift'); await page.keyboard.press('ArrowUp'); await page.keyboard.up('Shift'); await sleep(100); cp = await picker();
    check('More colours: arrow keys adjust the square (Shift: 10 steps)', cp.hex === '#6cd96c', cp);
    await page.click('.color-hex', { clickCount: 3 }); await page.keyboard.type('#zz'); await sleep(100);
    check('More colours: an invalid hex code is marked and ignored', await page.$eval('.color-hex', e => e.classList.contains('is-invalid')) && (await picker()).custom);
    await page.click('.color-hex', { clickCount: 3 }); await page.keyboard.type('#f80'); await sleep(100);
    await page.keyboard.press('Escape'); await sleep(150); cp = await picker(); s = await state();
    check('More colours: Esc closes the pop-up but keeps the drawing tool', !cp.open && cp.focused === 'tool' && s.status.startsWith('Rectangle:'), [cp, s.status]);
    await drag(100, 100, 250, 180);
    check('More colours: shape drawn in the typed colour (#f80)', await lastStroke() === '#ff8800', await lastStroke());
    await page.click('button[aria-label="More colours"]'); await sleep(200); cp = await picker();
    check('More colours: the colour is listed under Recent', cp.recent[0] === '#ff8800', cp.recent);
    await page.click('[aria-label="Preset colours"] .color-cell:nth-child(9)'); await sleep(100);
    const presetHex = (await picker()).hex;
    await page.mouse.click(5, (await page.evaluate(() => innerHeight)) - 60); await sleep(150);
    check('More colours: a click outside closes the pop-up', !(await picker()).open);
    await drag(300, 100, 400, 180);
    check('More colours: shape drawn in the preset colour', await lastStroke() === presetHex, [await lastStroke(), presetHex]);
    await page.click('.color-swatch[aria-label="Red"]'); await sleep(100);
    check('More colours: picking a quick swatch leaves custom colours', !(await picker()).custom);
    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('More colours: custom colours save into the PDF copy', /with 2 markups/.test(s.status), s.status);
    await click('Clear Markups'); await page.keyboard.press('Escape'); await sleep(100); await click('Fit Page');

    // ===== Annotations: polyline, sticky note, strikethrough, stamps, My markups =====
    const annLabels = () => page.$$eval('.markup-row .markup-title', els => els.map(e => e.textContent.trim()));
    // The box of a markup's outline (its first drawn path) and its text lines.
    const shapeOf = type => page.$$eval(`.markup-layer g.markup[data-type="${type}"]`, gs => gs.map(g => {
        const b = [...g.querySelectorAll('path')].find(p => p.getAttribute('d')).getBBox();
        return { x: b.x, y: b.y, w: b.width, h: b.height, text: [...g.querySelectorAll('tspan')].map(t => t.textContent.trim()).join(' ') };
    }));
    await open('one-page.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-markup'); await sleep(100);
    await page.click('button[aria-label="Polyline"]');
    await clickAt(80, 120); await clickAt(200, 160);
    await page.keyboard.down('Shift'); await clickAt(300, 170); await page.keyboard.up('Shift');
    await clickAt(380, 100); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter'); await sleep(150);
    let poly = await page.$$eval('.markup-layer g.markup[data-type="polyline"] path', ps => ps.map(p => p.getAttribute('d')).filter(Boolean));
    check('polyline: click the points, Enter finishes; Backspace took the last point back', (await annLabels()).join('|') === 'Polyline' &&
        poly.length === 1 && (poly[0].match(/[ML]/g) || []).length === 3, [await annLabels(), poly]);
    check('polyline: Shift keeps the segment level (45° steps)', / 160$/.test(poly[0].trim()), poly);
    await page.click('button[aria-label="Polyline"]');
    await clickAt(80, 300); await page.keyboard.press('Enter'); await sleep(100);
    check('polyline: one point is not a polyline', (await annLabels()).length === 1);
    await page.keyboard.press('Escape');

    await page.click('button[aria-label="Sticky note"]'); await clickAt(500, 80); await sleep(200);
    const noteTitle = await page.evaluate(() => (document.querySelector('#note-dialog-title') || {}).textContent);
    await page.keyboard.type('Check this'); await page.click('#note-form ~ .dialog-footer .tool-primary').catch(() => page.click('.dialog-footer .tool-primary'));
    await sleep(200);
    check('sticky note: on the Markup tab, a comment with a note icon', noteTitle === 'Comment' && (await annLabels()).includes('Comment: Check this') &&
        (await shapeOf('comment')).length === 1, [noteTitle, await annLabels()]);
    await page.click('#ribbon-tab-markup'); await page.click('button[aria-label="Strikethrough"]'); await drag(40, 200, 300, 214);
    check('strikethrough: on the Markup tab too', (await annLabels()).includes('Strikeout'), await annLabels());
    await page.keyboard.press('Escape');

    await page.click('button[aria-label="Stamp"]'); await sleep(200);
    const stampCount = await page.$$eval('.stamp-preview', s => s.map(x => x.textContent.trim()));
    check('stamp: picking shows the standard stamps', stampCount.length === 16 && stampCount[0] === 'APPROVED' && stampCount.includes('REJECTED'), stampCount);
    await page.$eval('[aria-label="Name on the stamp"]', e => { e.value = ''; }); await page.type('[aria-label="Name on the stamp"]', 'N. Kumar');
    await page.click('[aria-labelledby="stamp-dialog-title"] .tool-primary'); await sleep(100);
    await clickAt(300, 300); await sleep(200);
    let stamps = await shapeOf('stamp'); const today = new Date();
    const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    check('stamp: APPROVED, centred where clicked, with the name and date', (await annLabels()).includes('Stamp: APPROVED') && stamps.length === 1 &&
        stamps[0].text === 'APPROVED N. Kumar · ' + todayText && near(stamps[0].x + stamps[0].w / 2, 300, 4) && near(stamps[0].y + stamps[0].h / 2, 300, 4),
        [stamps, await annLabels()]);
    const stampColor = await page.$eval('.markup-layer g.markup[data-type="stamp"]', g => g.getAttribute('stroke'));
    check('stamp: the standard stamp has its own colour (green)', stampColor === '#26a269', stampColor);
    await clickAt(300, 420); await sleep(200);
    check('stamp: each click places another', (await shapeOf('stamp')).length === 2);
    await page.keyboard.press('v'); await sleep(50);
    await page.click('button[aria-label="Stamp"]'); await sleep(200);
    await page.click('#stamp-custom-input'); await page.keyboard.type('checked on site');
    await page.click('input[type=checkbox][ng-model="vm.stampDialog.withName"]');
    await page.click('[aria-labelledby="stamp-dialog-title"] .tool-primary'); await sleep(100); await clickAt(300, 520); await sleep(200);
    stamps = await shapeOf('stamp');
    check('stamp: your own text (in capitals), without the name line, in the Markup colour', (await annLabels()).includes('Stamp: CHECKED ON SITE') &&
        stamps[2].text === 'CHECKED ON SITE' && await page.$$eval('.markup-layer g.markup[data-type="stamp"]', gs => gs[2].getAttribute('stroke')) === '#e01b24', stamps);
    await page.keyboard.press('v'); await sleep(50);
    const lbs = await layerBox();
    await page.mouse.click(lbs.x + 300, lbs.y + 520, { clickCount: 2 }); await sleep(200);
    await page.$eval('#edit-text-input', e => { e.value = ''; }); await page.type('#edit-text-input', 'CHECKED');
    await page.click('[aria-labelledby="edit-dialog-title"] .tool-primary'); await sleep(200);
    stamps = await shapeOf('stamp');
    check('stamp: double-click changes its text; the box fits it', stamps[2].text === 'CHECKED' && (await annLabels()).includes('Stamp: CHECKED'), stamps);

    await clickAt(300, 300); await sleep(100);
    await click('Add to My markups'); await sleep(200);
    await page.$eval('#custom-name-input', e => { e.value = ''; }); await page.type('#custom-name-input', 'Approved (NK)');
    await page.click('[aria-labelledby="custom-save-title"] .tool-primary'); await sleep(150);
    s = await state();
    check('My markups: the selected stamp is added under a name', /"Approved \(NK\)" added to My markups/.test(s.status), s.status);
    await click('Clear Markups');
    await page.click('button[aria-label="My markups"]'); await sleep(200);
    const customItems = await page.$$eval('.custom-name', e => e.map(x => x.textContent.trim()));
    check('My markups: lists the saved markups', customItems.join('|') === 'Approved (NK)', customItems);
    await page.click('.custom-pick'); await sleep(100); await clickAt(200, 200); await clickAt(400, 450); await sleep(200);
    stamps = await shapeOf('stamp');
    check('My markups: each click places a copy, centred there', stamps.length === 2 && stamps[0].text.startsWith('APPROVED N. Kumar') &&
        near(stamps[0].x + stamps[0].w / 2, 200, 4) && near(stamps[1].y + stamps[1].h / 2, 450, 4), stamps);
    await page.keyboard.press('v');
    await page.click('#ribbon-tab-markup'); await page.click('button[aria-label="Polyline"]');
    await clickAt(100, 560); await clickAt(250, 540); await page.keyboard.press('Enter'); await sleep(100);
    await page.keyboard.press('v'); await sleep(50);
    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('annotations: stamps and polyline save into the PDF copy', /with 3 markups/.test(s.status), s.status);
    if (canCheckDownloads) {
        await sleep(500);
        const saved = fs.readdirSync(DOWNLOADS).filter(f => /^one-page-highlighted.*\.pdf$/.test(f))
            .map(f => path.join(DOWNLOADS, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const raw = saved ? fs.readFileSync(saved).toString('latin1') : '';
        check('annotations: saved as Stamp (bold text) and Ink', (raw.match(/\/Contents\(Stamp: APPROVED\)/g) || []).length === 2 &&
            raw.includes('Helvetica-Bold') && /\/Subtype\s*\/Ink/.test(raw), saved);
    }
    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.toolbar'); await sleep(300);
    await open('one-page.pdf'); await page.click('#ribbon-tab-markup');
    await page.click('button[aria-label="My markups"]'); await sleep(200);
    check('My markups: kept after reloading', (await page.$$eval('.custom-name', e => e.length)) === 1);
    await page.click('button[aria-label="Delete Approved (NK)"]'); await sleep(100);
    check('My markups: delete one', (await page.$$eval('.custom-name', e => e.length)) === 0);
    await page.keyboard.press('Escape'); await sleep(100);

    // ===== Measure: distances, areas, perimeter, scale =====
    const measureLabels = () => page.$$eval('.markup-row .markup-title', els => els.map(e => e.textContent.trim()));
    const scaleButton = () => page.$eval('.ribbon-scale', b => ({ text: b.textContent.trim(), unset: b.classList.contains('is-unset') }));
    const scaleDialog = () => page.evaluate(() => {
        const d = document.querySelector('[aria-labelledby="scale-dialog-title"]');
        const e = d && d.querySelector('.dialog-message');
        return { open: !!d, focused: document.activeElement && document.activeElement.id, error: e ? e.textContent.trim() : '' };
    });
    const pressed = label => page.$eval(`button[aria-label="${label}"]`, b => b.getAttribute('aria-pressed') === 'true');
    const corners = async (points, finish) => {
        for (const [x, y] of points) await clickAt(x, y);
        if (finish === 'enter') { await page.keyboard.press('Enter'); await sleep(150); }
    };
    await open('one-page.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-measure'); await sleep(100);
    let sb = await scaleButton();
    check('measure: no scale set at first (shown in red)', sb.text === '1:1 (not set)' && sb.unset, sb);
    await page.click('button[aria-label="Distance"]'); await drag(100, 300, 300, 300); s = await state();
    check('measure: without a scale a distance is the paper size, with a hint', /^Distance: 71 mm \(paper size/.test(s.status), s.status);
    await page.click('.ribbon-scale'); await sleep(200); let sd = await scaleDialog();
    check('measure: Scale opens the dialog with the cursor in the ratio box', sd.open && sd.focused === 'scale-ratio-input', sd);
    await page.click('#scale-ratio-input', { clickCount: 3 }); await page.keyboard.type('abc'); await page.keyboard.press('Enter'); await sleep(100);
    check('measure: an invalid scale is refused', (await scaleDialog()).error.startsWith('Enter the scale as a number'), await scaleDialog());
    await page.click('#scale-ratio-input', { clickCount: 3 }); await page.keyboard.type('1:100'); await page.keyboard.press('Enter'); await sleep(150);
    sb = await scaleButton(); let ml = await measureLabels();
    check('measure: 1:100 set; existing distance updates (200 pt = 7,056 mm)', sb.text === '1:100 \u00b7 mm' && !sb.unset && ml[0] === 'Distance: 7,056 mm', [sb, ml]);
    await page.click('button[aria-label="Horizontal distance"]'); await drag(100, 400, 300, 450);
    await page.click('button[aria-label="Vertical distance"]'); await drag(400, 400, 450, 600);
    ml = await measureLabels();
    check('measure: horizontal and vertical distances measure only their direction',
        ml[1] === 'Horizontal distance: 7,056 mm' && ml[2] === 'Vertical distance: 7,056 mm', ml);
    await page.click('button[aria-label="Area"]');
    await corners([[100, 100], [300, 100], [300, 200], [100, 200]], 'enter'); ml = await measureLabels();
    check('measure: area of 4 clicked corners, Enter finishes (24.89 m\u00b2)', ml[3] === 'Area: 24.89 m\u00b2', ml);
    await page.click('button[aria-label="Perimeter"]');
    await corners([[350, 100], [550, 100], [550, 200], [350, 200], [350, 100]]); ml = await measureLabels();
    check('measure: perimeter closes by clicking the first corner (21,167 mm)', ml[4] === 'Perimeter: 21,167 mm', ml);
    await page.click('button[aria-label="Area"]');
    // (The page runs under the status bar below y = 590 in this window.)
    await corners([[100, 480], [200, 480]]); await page.keyboard.press('Escape'); await sleep(100);
    check('measure: Esc cancels the unfinished area and keeps the tool', (await measureLabels()).length === 5 && await pressed('Area'));
    await corners([[100, 480], [200, 480], [200, 560]]); await page.keyboard.press('Backspace'); await page.keyboard.press('Enter'); await sleep(150);
    check('measure: Backspace removes the last corner; fewer than 3 corners adds nothing', (await measureLabels()).length === 5);
    const lbm = await layerBox();
    await corners([[100, 480], [200, 480]]); await page.mouse.click(lbm.x + 200, lbm.y + 560, { clickCount: 1 });
    await page.mouse.click(lbm.x + 200, lbm.y + 560, { clickCount: 2 }); await sleep(200); ml = await measureLabels();
    check('measure: double-click finishes an area (triangle, 4.98 m\u00b2)', ml[5] === 'Area: 4.98 m\u00b2', ml);
    await page.click('button[aria-label="Calibrate"]'); await drag(100, 580, 300, 580); await sleep(200); sd = await scaleDialog();
    check('measure: Calibrate opens the dialog with the cursor in the length box', sd.open && sd.focused === 'scale-length-input', sd);
    await page.keyboard.press('Enter'); await sleep(100);
    check('measure: calibration needs a length', (await scaleDialog()).error.startsWith('Enter the real length'), await scaleDialog());
    await page.keyboard.type('5000'); await page.keyboard.press('Enter'); await sleep(150);
    sb = await scaleButton(); ml = await measureLabels(); s = await state();
    check('measure: calibration (200 pt = 5000 mm) updates every measurement and returns to Pan',
        sb.text === 'Calibrated \u00b7 mm' && ml.join('|') === 'Distance: 5,000 mm|Horizontal distance: 5,000 mm|Vertical distance: 5,000 mm|' +
        'Area: 12.50 m\u00b2|Perimeter: 15,000 mm|Area: 2.50 m\u00b2' && await pressed('Pan') && /calibrated/.test(s.status), [sb, ml, s.status]);
    await page.click('.ribbon-scale'); await sleep(200);
    await page.click('#scale-ratio-input', { clickCount: 3 }); await page.keyboard.type('50');
    await page.select('[aria-labelledby="scale-dialog-title"] select', 'string:m'); await page.keyboard.press('Escape'); await sleep(100);
    check('measure: Esc closes the scale dialog without changing the scale', !(await scaleDialog()).open && (await scaleButton()).text === 'Calibrated \u00b7 mm');
    await page.click('.ribbon-scale'); await sleep(200);
    await page.click('#scale-ratio-input', { clickCount: 3 }); await page.keyboard.type('50');
    await page.select('[aria-labelledby="scale-dialog-title"] select', 'string:m');
    await page.click('[aria-labelledby="scale-dialog-title"] .tool-primary'); await sleep(150); ml = await measureLabels();
    check('measure: 1:50 in metres', (await scaleButton()).text === '1:50 \u00b7 m' && ml[0] === 'Distance: 3.53 m' && ml[3] === 'Area: 6.22 m\u00b2', ml);
    await clickAt(130, 180); let mbox = await selectionBox();
    check('measure: Pan click inside an area selects it', !!mbox && near(mbox.w, 208, 3), mbox);
    await clickAt(450, 101); mbox = await selectionBox();
    check('measure: Pan click on a perimeter line selects it', !!mbox && near(mbox.w, 208, 3) && near(mbox.h, 108, 3), mbox);
    await page.keyboard.press('Delete'); await sleep(150); ml = await measureLabels();
    check('measure: Delete removes the selected measurement', ml.length === 5 && !ml.some(l => l.startsWith('Perimeter')), ml);
    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('measure: measurements save into the PDF copy', /one-page-highlighted.*with 5 markups/.test(s.status), s.status);
    if (canCheckDownloads) {
        await sleep(500);
        const saved = fs.readdirSync(DOWNLOADS).filter(f => /^one-page-highlighted.*\.pdf$/.test(f))
            .map(f => path.join(DOWNLOADS, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const raw = saved ? fs.readFileSync(saved).toString('latin1') : '';
        check('measure: saved copy has the values as stamp text', raw.includes('/Contents(Distance: 3.53 m)') &&
            raw.includes('/Contents(Horizontal distance: 3.53 m)') && (raw.match(/\/Subtype\s*\/Stamp/g) || []).length === 5, saved);
        if (saved) {
            await (await page.$('.toolbar input[type=file]')).uploadFile(saved);
            await sleep(300); await settle(); await click('Actual size');
            const line = await redShare({ x: 150, y: 296, w: 100, h: 8 });
            // Share of light red (the 12 % area fill) inside the area, between the text lines.
            const fill = await page.evaluate(() => {
                const c = document.querySelector('.canvas-layer canvas'), k = c.width / parseFloat(c.style.width);
                const d = c.getContext('2d').getImageData(Math.round(105 * k), Math.round(105 * k), Math.round(190 * k), Math.round(90 * k)).data;
                let n = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] > 200 && d[i + 1] < 245 && d[i + 2] > 200 && d[i + 2] < 245) n++;
                return n / (d.length / 4);
            });
            check(`measure: saved copy draws the lines and the light area fill (line ${Math.round(line * 100)}%, fill ${Math.round(fill * 100)}%)`,
                line > 0.1 && fill > 0.3);
        }
    }
    await click('Fit Page');

    // ===== Measure: custom scale, units and precision, count, perpendicular distance =====
    const unitsDialog = async (settings) => {
        await page.click('button[aria-label="Units and precision"]'); await sleep(200);
        for (const [id, value] of Object.entries(settings)) {
            const option = await page.$eval('#' + id, (e, v) => [...e.options].find(o => o.value === v || o.value === 'string:' + v || o.value === 'number:' + v).value, value);
            await page.select('#' + id, option); await sleep(50);
        }
        const sample = await page.$eval('.units-sample', e => e.textContent.trim());
        await page.click('[aria-labelledby="units-dialog-title"] .tool-primary'); await sleep(150);
        return sample;
    };
    const label = async prefix => (await measureLabels()).filter(l => l.startsWith(prefix));
    await open('one-page.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-measure'); await sleep(100);
    await page.click('.ribbon-scale'); await sleep(200);
    const quarterInch = await page.$eval('.scale-presets', s => [...s.options].find(o => o.textContent.trim() === '1/4" = 1\'-0"').value);
    await page.select('.scale-presets', quarterInch); await page.click('[aria-labelledby="scale-dialog-title"] .tool-primary'); await sleep(150);
    await page.click('button[aria-label="Distance"]'); await drag(100, 300, 172, 300);
    check('measure: custom scale from the common list (1/4" = 1\'-0"): 1 inch on paper is 4 ft',
        (await scaleButton()).text === '1/4" = 1\'-0" · ft' && (await label('Distance'))[0] === 'Distance: 4.00 ft', [await scaleButton(), await measureLabels()]);
    await page.click('.ribbon-scale'); await sleep(200);
    await page.click('input[name="scale-mode"][value="custom"]');
    await page.$eval('#scale-paper-input', e => { e.value = ''; }); await page.type('#scale-paper-input', '1');
    await page.$eval('#scale-real-input', e => { e.value = ''; }); await page.type('#scale-real-input', '20');
    await page.click('[aria-labelledby="scale-dialog-title"] .tool-primary'); await sleep(150);
    check('measure: custom scale typed in (1" = 20\'): the distance is 20 ft',
        (await scaleButton()).text === '1" = 20\'-0" · ft' && (await label('Distance'))[0] === 'Distance: 20.00 ft', [await scaleButton(), await measureLabels()]);

    let sample = await unitsDialog({ 'units-length': 'ft-in', 'units-fraction': '16' });
    check('units: feet and inches (the example shows 3.5 m = 11\'-5 13/16")', sample === '11\'-5 13/16"' &&
        (await label('Distance'))[0] === 'Distance: 20\'-0"' && /ft-in/.test(await page.$eval('.ribbon-units', b => b.textContent)), [sample, await measureLabels()]);
    await page.click('button[aria-label="Area"]'); await corners([[100, 350], [172, 350], [172, 422], [100, 422]], 'enter');
    sample = await unitsDialog({ 'units-length': 'm', 'units-decimals': '3' });
    check('units: converted to metres with 3 decimals; the area follows (20 ft square = 37.161 m²)',
        (await label('Distance'))[0] === 'Distance: 6.096 m' && (await label('Area'))[0] === 'Area: 37.161 m²', await measureLabels());
    await unitsDialog({ 'units-area': 'ft²', 'units-decimals': '0' });
    check('units: area in ft², no decimals', (await label('Area'))[0] === 'Area: 400 ft²' && (await label('Distance'))[0] === 'Distance: 6 m', await measureLabels());
    check('units: the choice is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('pdfViewer.measureUnits')).area === 'ft²'));
    await unitsDialog({ 'units-length': 'scale', 'units-area': 'auto', 'units-decimals': 'auto' });

    await page.click('button[aria-label="Calibrate"]'); await drag(100, 560, 244, 560); await sleep(200);
    await page.keyboard.type('12\'6"'); await page.keyboard.press('Enter'); await sleep(150);
    check('measure: calibration accepts feet and inches (144 pt = 12\'6", so 72 pt = 6.25 ft)',
        (await scaleButton()).text === 'Calibrated · ft' && (await label('Distance'))[0] === 'Distance: 6.25 ft', [await scaleButton(), await measureLabels()]);

    await page.click('button[aria-label="Count"]');
    for (const [x, y] of [[300, 150], [350, 150], [400, 150]]) await clickAt(x, y);
    s = await state();
    check('count: each click adds an item to the count', (await label('Count'))[0] === 'Count: 3 items' && /^Count: 3 items/.test(s.status), [await measureLabels(), s.status]);
    await page.keyboard.press('Backspace'); await sleep(150);
    check('count: Backspace removes the last item', (await label('Count'))[0] === 'Count: 2 items', await measureLabels());
    await page.keyboard.press('Enter'); await clickAt(450, 250); await sleep(100);
    check('count: Enter starts a new count', (await label('Count')).join('|') === 'Count: 2 items|Count: 1 item', await measureLabels());
    const markers = await page.$$eval('.markup-layer g.markup[data-type="count"]', gs => gs.length);
    check('count: the counts are drawn on the page', markers === 2, markers);

    await page.click('button[aria-label="Perpendicular distance"]'); await drag(100, 500, 400, 500); await clickAt(250, 400);
    check('perpendicular: drag the reference line, click the point: the distance square to the line (100 pt = 8.68 ft)',
        (await label('Perpendicular'))[0] === 'Perpendicular distance: 8.68 ft', await measureLabels());
    await drag(300, 540, 380, 540); await clickAt(480, 440);
    check('perpendicular: a point beyond the end of the line measures to the line extended',
        (await label('Perpendicular'))[1] === 'Perpendicular distance: 8.68 ft', await measureLabels());
    await drag(300, 540, 380, 540); await page.keyboard.press('Escape'); await sleep(100); await clickAt(480, 440);
    check('perpendicular: Esc drops the reference line, the tool stays', (await label('Perpendicular')).length === 2 && await pressed('Perpendicular distance'),
        await measureLabels());
    await page.keyboard.press('Escape'); await sleep(100);
    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('count / perpendicular: they save into the PDF copy', /with 6 markups/.test(s.status), s.status);
    if (canCheckDownloads) {
        await sleep(500);
        const saved = fs.readdirSync(DOWNLOADS).filter(f => /^one-page-highlighted.*\.pdf$/.test(f))
            .map(f => path.join(DOWNLOADS, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const raw = saved ? fs.readFileSync(saved).toString('latin1') : '';
        check('count / perpendicular: the copy has their values', raw.includes('/Contents(Count: 2 items)') &&
            raw.includes('/Contents(Perpendicular distance: 8.68 ft)'), saved);
    }
    await click('Clear Markups'); await click('Fit Page');

    // ===== Review: comments, notes, strikeout, underline, replace text, edit, delete =====
    const reviewLabels = () => page.$$eval('.markup-row .markup-title', els => els.map(e => e.textContent.trim()));
    const textDialog = () => page.evaluate(() => {
        const h = document.querySelector('#note-dialog-title, #edit-dialog-title');
        const input = document.querySelector('#note-text-input, #edit-text-input');
        return h ? { title: h.textContent.trim(), text: input ? input.value : null, focused: document.activeElement === input,
                     button: document.querySelector('.dialog-footer .tool-primary').textContent.trim() } : null;
    });
    const reviewShape = type => page.$eval(`.markup-layer g.markup[data-type="${type}"]`, g => ({
        stroke: g.getAttribute('stroke'), d: g.querySelector('path').getAttribute('d'),
        text: [...g.querySelectorAll('tspan')].map(t => t.textContent).join('\n')
    })).catch(() => null);
    const okDialog = async () => { await page.click('.dialog-footer .tool-primary'); await sleep(200); };
    await open('one-page.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-review'); await sleep(100);
    check('review: Edit and Delete are off with nothing selected',
        await page.$eval('button[aria-label="Edit markup"]', b => b.disabled) && await page.$eval('button[aria-label="Delete markup"]', b => b.disabled));
    await page.click('button[aria-label="Strikeout"]'); await drag(50, 108, 200, 122);
    let rs = await reviewShape('strikeout');
    check('review: Strikeout draws a line through the middle of the marked text', !!rs && /^M50 115L200 115$/.test(rs.d) && rs.stroke === '#e01b24', rs);
    await page.click('button[aria-label="Underline"]'); await drag(50, 128, 200, 142);
    rs = await reviewShape('underline');
    check('review: Underline draws a line along the bottom', !!rs && /^M50 14[01](\.\d+)?L200 14[01](\.\d+)?$/.test(rs.d), rs);
    await drag(300, 300, 301, 301);
    check('review: a click (no drag) with Underline adds nothing', (await reviewLabels()).length === 2);
    await page.click('button[aria-label="Replace text"]'); await drag(220, 148, 300, 162); let td = await textDialog();
    check('review: Replace text asks for the correction', td && td.title === 'Replace text' && td.focused && td.button === 'Replace', td);
    await okDialog(); td = await textDialog();
    check('review: an empty correction is refused', td && (await page.$eval('.dialog-message', e => e.textContent.trim())) === 'Type the replacement text.');
    await page.keyboard.type('a quick red cat'); await okDialog(); rs = await reviewShape('replace');
    check('review: Replace text strikes the text and shows the correction', !!rs && rs.text === 'a quick red cat' && /^M220 155L300 155/.test(rs.d), rs);
    await page.click('button[aria-label="Comment"]'); await clickAt(470, 200); td = await textDialog();
    check('review: Comment asks for the comment', td && td.title === 'Comment' && td.button === 'Add comment', td);
    await page.keyboard.type('Please confirm the slab thickness'); await okDialog();
    let popup = await page.$eval('.comment-popup', e => e.textContent).catch(() => null);
    check('review: a new comment shows its icon and, selected, its text', !!(await reviewShape('comment')) && popup === 'Please confirm the slab thickness', popup);
    await page.click('button[aria-label="Add note"]'); await clickAt(350, 300); td = await textDialog();
    check('review: Add note is the text note tool', td && td.title === 'Text note' && await pressed('Add note') && await toolPressed('Text note'), td);
    await page.keyboard.type('Explanation here'); await okDialog();
    let rl = await reviewLabels();
    check('review: Markups panel lists the review marks', rl.join('|') ===
        'Strikeout|Underline|Replace text: a quick red cat|Comment: Please confirm the slab thickness|Text note: Explanation here', rl);
    await page.keyboard.press('Escape'); await sleep(100);
    await clickAt(470, 200); popup = await page.$eval('.comment-popup', e => e.textContent).catch(() => null);
    check('review: Pan click on a comment icon selects it and shows the text', popup === 'Please confirm the slab thickness', popup);
    await page.click('button[aria-label="Edit markup"]'); await sleep(200); td = await textDialog();
    check('review: Edit opens with the text, cursor in it', td && td.title === 'Edit Comment' && td.text === 'Please confirm the slab thickness' && td.focused, td);
    await page.$eval('#edit-text-input', e => e.select()); await page.keyboard.type('Slab is 250 mm?');
    await page.click('.edit-colour .color-swatch[aria-label="Edit colour Blue"]'); await okDialog();
    rs = await reviewShape('comment'); rl = await reviewLabels();
    check('review: Edit changes the text and colour', rs.stroke === '#1c71d8' && rl[3] === 'Comment: Slab is 250 mm?', [rs.stroke, rl[3]]);
    await clickAt(350, 300); await clickAt(350, 300); await page.mouse.click((await layerBox()).x + 360, (await layerBox()).y + 305, { clickCount: 2 }); await sleep(250);
    td = await textDialog();
    check('review: double-click a note opens Edit', td && td.title === 'Edit Text note' && td.text === 'Explanation here', td);
    await page.$eval('#edit-text-input', e => e.select()); await page.keyboard.type('A longer explanation here');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control'); await sleep(200);
    rs = await reviewShape('text'); const noteBox = await selectionBox();
    check('review: editing a note resizes its box to the text', rs.text === 'A longer explanation here' && noteBox && noteBox.w > 140, [rs.text, noteBox]);   // 'Explanation here' was about 115
    await clickAt(470, 200); const selBefore = await page.$eval('.markup-selection', e => [parseFloat(e.style.left), parseFloat(e.style.top)]);
    await drag(470, 200, 520, 260); const selAfter = await page.$eval('.markup-selection', e => [parseFloat(e.style.left), parseFloat(e.style.top)]);
    check('review: drag the selected markup to move it (Pan)', near(selAfter[0] - selBefore[0], 50) && near(selAfter[1] - selBefore[1], 60) &&
        (await reviewLabels()).length === 5, [selBefore, selAfter]);
    await drag(600, 400, 650, 450);
    check('review: dragging elsewhere still pans, the markup stays', (await page.$eval('.markup-selection', e => parseFloat(e.style.left))) === selAfter[0]);
    await page.click('button[aria-label="Delete markup"]'); await sleep(150); rl = await reviewLabels();
    check('review: Delete removes the selected markup', rl.length === 4 && !rl.some(l => l.startsWith('Comment')), rl);
    await page.click('button[aria-label="Comment"]'); await clickAt(470, 220); await page.keyboard.type('Second comment'); await okDialog();
    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('review: review marks save into the PDF copy', /with 5 markups/.test(s.status), s.status);
    if (canCheckDownloads) {
        await sleep(500);
        const saved = fs.readdirSync(DOWNLOADS).filter(f => /^one-page-highlighted.*\.pdf$/.test(f))
            .map(f => path.join(DOWNLOADS, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        const raw = saved ? fs.readFileSync(saved).toString('latin1') : '';
        const count = t => (raw.match(new RegExp('/Subtype\\s*/' + t + '\\b', 'g')) || []).length;
        check('review: saved as StrikeOut, Underline, Text (comment) and Stamps, with the texts',
            count('StrikeOut') === 1 && count('Underline') === 1 && count('Text') === 1 && count('Stamp') === 2 &&
            raw.includes('/Contents(Replace with: a quick red cat)') && raw.includes('/Contents(Second comment)') &&
            raw.includes('/Contents(A longer explanation here)'), ['StrikeOut', 'Underline', 'Text', 'Stamp'].map(t => t + count(t)));
        if (saved) {
            await (await page.$('.toolbar input[type=file]')).uploadFile(saved);
            await sleep(300); await settle(); await click('Actual size');
            const strike = await redShare({ x: 60, y: 113, w: 130, h: 5 });
            const under = await redShare({ x: 60, y: 137, w: 130, h: 6 });
            check(`review: saved copy draws the strikeout and underline (${Math.round(strike * 100)}%, ${Math.round(under * 100)}%)`, strike > 0.1 && under > 0.1);
        }
    }
    await click('Fit Page');

    // ===== Revision: compare, overlay, revision tracking, markup report =====
    const revisionState = () => page.evaluate(() => ({
        status: document.querySelector('.status-text').textContent.trim(),
        regions: [...document.querySelectorAll('.revision-region')].map(e => ({
            x: parseFloat(e.style.left), y: parseFloat(e.style.top), w: parseFloat(e.style.width), h: parseFloat(e.style.height),
            active: e.classList.contains('is-active') })),
        image: !!document.querySelector('.revision-image'),
        overlay: !!document.querySelector('.revision-image.is-overlay'),
        faded: !!document.querySelector('.pdf-page.is-comparing'),
        count: (document.querySelector('.compare-count') || { textContent: '' }).textContent.trim(),
        file: (document.querySelector('.compare-file') || { textContent: '' }).textContent.trim()
    }));
    // Red / green / blue / grey pixel counts of the comparison image in an area of the page (CSS px at the current zoom).
    const revisionColours = rect => page.evaluate(r => {
        const img = document.querySelector('.revision-image');
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        const k = img.naturalWidth / img.getBoundingClientRect().width;
        const d = ctx.getImageData(Math.round(r.x * k), Math.round(r.y * k), Math.round(r.w * k), Math.round(r.h * k)).data;
        const n = { red: 0, green: 0, blue: 0, grey: 0 };
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;
            const [R, G, B] = [d[i], d[i + 1], d[i + 2]];
            if (R > 180 && G < 90 && B < 90) n.red++;
            else if (G > 120 && R < 60 && B < 120) n.green++;
            else if (B > 180 && R < 80) n.blue++;
            else if (Math.abs(R - G) < 10 && Math.abs(G - B) < 10 && R < 120) n.grey++;
        }
        return n;
    }, rect);
    await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('pdfViewer.revisions:')).forEach(k => localStorage.removeItem(k)));
    await open('one-page-rev-b.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-revision'); await sleep(100);
    check('revision: comparison view buttons are off until a revision is open',
        await page.$eval('button[aria-label="Differences"]', b => b.disabled) && await page.$eval('button[aria-label="Next change"]', b => b.disabled));
    await (await page.$('.compare-input')).uploadFile(path.join(FIXTURES, 'one-page.pdf'));
    await page.waitForFunction(() => /changed area|no differences|Unable/.test(document.querySelector('.status-text').textContent), { timeout: 30000 });
    let rv = await revisionState();
    // Line 5 (y = 842 - 120 - 100 = 622 in PDF space, so about 210-222 from the top) is only in one-page.pdf;
    // the rectangle 380,300 150x80 (y 462-542 from the top) only in this revision.
    check('revision: Compare finds the 2 changed areas: removed line 5 and the added rectangle',
        rv.regions.length === 2 && rv.count === '2 changes' && rv.file === 'one-page.pdf' && rv.image && rv.faded &&
        near(rv.regions[0].y, 207, 6) && near(rv.regions[1].x, 376, 6) && near(rv.regions[1].y, 458, 6) && /2 changed areas/.test(rv.status), rv);
    const line5 = { x: 50, y: 208, w: 300, h: 16 }, rectEdge = { x: 375, y: 470, w: 10, h: 60 }, line6 = { x: 50, y: 228, w: 300, h: 16 };
    let c1 = await revisionColours(line5), c2 = await revisionColours(rectEdge), c3 = await revisionColours(line6);
    check('revision: removed text in red, added lines in green, unchanged clear',
        c1.red > 100 && c1.green === 0 && c2.green > 50 && c2.red === 0 && c3.red + c3.green === 0, [c1, c2, c3]);
    await page.click('button[aria-label="Next change"]'); await sleep(200); rv = await revisionState();
    check('revision: Next change selects the first changed area', rv.regions[0].active && !rv.regions[1].active && /Change 1 of 2/.test(rv.status), rv.status);
    await page.click('button[aria-label="Next change"]'); await sleep(200);
    await page.click('button[aria-label="Next change"]'); await sleep(300); rv = await revisionState();
    check('revision: after the last change, says there are no more', rv.regions[1].active && /No more changes after page 1/.test(rv.status), rv.status);
    await page.click('button[aria-label="Previous change"]'); await sleep(200); rv = await revisionState();
    check('revision: Previous change goes back', rv.regions[0].active, rv.regions);
    await page.click('button[aria-label="Overlay"]'); await sleep(400); rv = await revisionState();
    c1 = await revisionColours(line5); c2 = await revisionColours(rectEdge); c3 = await revisionColours(line6);
    check('revision: Overlay shows both revisions (other in red, this one in blue, both in grey), page not faded',
        rv.overlay && !rv.faded && rv.regions.length === 0 && c1.red > 100 && c2.blue > 50 && c3.grey > 100 && c3.red + c3.blue === 0, [c1, c2, c3]);
    await page.click('button[aria-label="Hide comparison"]'); await sleep(200); rv = await revisionState();
    check('revision: Off shows the plain page', !rv.image && !rv.faded);
    await page.click('button[aria-label="Differences"]'); await sleep(300);
    await page.click('button[aria-label="Revision tag"]'); await sleep(200);
    let rvd = await page.evaluate(() => {
        const d = document.querySelector('[aria-labelledby="revisions-dialog-title"]');
        return d ? { message: d.querySelector('.dialog-message').textContent.trim(), label: d.querySelector('.revision-label-input').value,
                     focused: document.activeElement.id } : null;
    });
    check('revision: the tag tool asks for a revision first; the dialog suggests A', rvd && /Add a revision first/.test(rvd.message) &&
        rvd.label === 'A' && rvd.focused === 'revision-description-input' && !(await pressed('Revision tag')), rvd);
    await page.keyboard.type('Issued for review'); await page.keyboard.press('Enter'); await sleep(150);
    await page.type('#revision-description-input', 'Opening added'); await page.keyboard.press('Enter'); await sleep(150);
    const revRows = await page.$$eval('.revision-table tbody tr', rs => rs.map(r => ({ text: r.innerText.replace(/\s+/g, ' ').trim(), current: r.classList.contains('is-current') })));
    check('revision: revisions A and B added, B current', revRows.length === 2 && revRows[0].text.startsWith('A ') &&
        /Issued for review/.test(revRows[0].text) && revRows[1].current && /^B .*Opening added/.test(revRows[1].text), revRows);
    await page.click('.revision-label-input', { clickCount: 3 }); await page.keyboard.type('a'); await page.keyboard.press('Enter'); await sleep(100);
    check('revision: a label that already exists is refused',
        (await page.$eval('[aria-labelledby="revisions-dialog-title"] .dialog-message.is-error', e => e.textContent.trim()).catch(() => '')) === 'Revision a already exists.' &&
        (await page.$$('.revision-table tbody tr')).length === 2);
    await page.click('[aria-labelledby="revisions-dialog-title"] .dialog-footer .tool-primary'); await sleep(100);
    check('revision: the ribbon shows the current revision', (await page.$eval('button[aria-label="Revisions"]', b => b.textContent.trim())) === 'Rev B');
    await page.click('button[aria-label="Cloud changes"]'); await sleep(300);
    await page.click('button[aria-label="Revision tag"]'); await clickAt(545, 450); await sleep(300);
    let ml2 = await page.$$eval('.markup-row', rs => rs.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
    const tag = await page.$eval('.markup-layer g.markup[data-type="revtag"]', g => ({ d: g.querySelector('path').getAttribute('d'), text: g.querySelector('tspan').textContent }));
    check('revision: Cloud changes adds a cloud per changed area; the tag shows B; all in Rev B',
        ml2.length === 3 && ml2.filter(t => /^Cloud Page 1 · Rev B/.test(t)).length === 2 && /^Revision tag: B Page 1 · Rev B/.test(ml2[2]) &&
        tag.text === 'B' && /Z?$/.test(tag.d), [ml2, tag]);
    await page.keyboard.press('Escape');
    await page.click('button[aria-label="Revisions"]'); await sleep(200);
    await page.click('.revision-table tbody tr:first-child input[type=radio]'); await sleep(100);
    await page.click('[aria-labelledby="revisions-dialog-title"] .dialog-footer .tool-primary'); await sleep(100);
    await page.click('#ribbon-tab-markup'); await click('Rectangle'); await drag(100, 560, 200, 580); await page.keyboard.press('Escape');
    await page.click('#ribbon-tab-revision'); await sleep(100);
    check('revision: markups made after switching to A belong to A', (await page.$$eval('.markup-meta', els => els.map(e => e.textContent)))[3].includes('Rev A'));
    await page.click('#ribbon-revision button[aria-label="Markup report"]'); await sleep(200);
    const report = () => page.evaluate(() => ({ total: document.querySelector('.report-total').textContent.replace(/\s+/g, ' ').trim(),
        rows: [...document.querySelectorAll('.report-table tbody tr')].map(r => [...r.cells].map(c => c.textContent.trim())) }));
    let rep = await report();
    check('revision: the markup report lists every markup with page, type, content, colour and revision',
        rep.rows.length === 4 && /^4 markups · 2 Cloud/.test(rep.total) && rep.rows[2].slice(1, 6).join('|') === '1|Revision tag|Revision B|#e01b24|B' &&
        rep.rows[3][5] === 'A', rep);
    await page.select('[aria-label="Report revision"]', 'B'); await sleep(150); rep = await report();
    check('revision: the report can show one revision', rep.rows.length === 3 && rep.rows.every(r => r[5] === 'B'), rep.total);
    await page.select('[aria-label="Report revision"]', ''); await sleep(100);
    await page.click('.dialog-footer .tool-outline'); await sleep(300); s = await state();
    check('revision: Save CSV downloads the report', s.status === 'Downloaded one-page-rev-b-markups.csv.', s.status);
    await page.click('.dialog-footer .tool-outline:nth-child(2)'); await sleep(300); s = await state();
    check('revision: Save printable report downloads an HTML page', s.status === 'Downloaded one-page-rev-b-markups.html.', s.status);
    if (canCheckDownloads) {
        const csv = await waitForDownload('one-page-rev-b-markups.csv');
        const html = await waitForDownload('one-page-rev-b-markups.html');
        const csvText = csv ? csv.toString('utf8') : '';
        check('revision: the CSV has a header and one row per markup (UTF-8 with BOM for Excel)',
            csvText.startsWith('\ufeffNo.,Page,Type,Content,Colour,Revision,Created\r\n') && csvText.trim().split('\r\n').length === 5 &&
            /\r\n3,1,Revision tag,Revision B,#e01b24,B,\d{4}-/.test(csvText), csvText.slice(0, 200));
        check('revision: the HTML report has the summary and table', !!html && /<h1>Markup report<\/h1>/.test(html.toString()) &&
            (html.toString().match(/<tr>/g) || []).length >= 4 + 1);
    }
    await page.click('[aria-labelledby="report-dialog-title"] .dialog-footer .tool-primary'); await sleep(100);
    await click('Save with markups');
    await page.waitForFunction(() => /markup|Unable/.test(document.querySelector('.status-text').textContent) &&
        !/Saving/.test(document.querySelector('.status-text').textContent), { timeout: 60000 });
    s = await state();
    check('revision: clouds and the revision tag save into the PDF copy', /with 4 markups/.test(s.status), s.status);
    await open('one-page.pdf'); await page.click('#ribbon-tab-revision'); await sleep(100); rv = await revisionState();
    check('revision: opening another PDF ends the comparison', !rv.image && rv.file === '' &&
        (await page.$eval('button[aria-label="Revisions"]', b => b.textContent.trim())) === 'Revisions');
    await open('one-page-rev-b.pdf'); await page.click('#ribbon-tab-revision'); await sleep(100);
    check('revision: the revision list is remembered for the file', (await page.$eval('button[aria-label="Revisions"]', b => b.textContent.trim())) === 'Rev A');
    await click('Fit Page');

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

    // ===== Pages: new, save, insert, delete, extract, reorder, duplicate, rotate, replace =====
    // Reads a PDF with pdf.js in the page: per page the first text, displayed size and /Rotate.
    const pdfPages = buf => page.evaluate(async b64 => {
        const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
        const out = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const p = await doc.getPage(i);
            const v = p.getViewport({ scale: 1 });
            const items = (await p.getTextContent()).items.filter(t => t.str.trim());
            out.push({ text: items.length ? items[0].str.trim() : '', w: Math.round(v.width), h: Math.round(v.height), rotate: p.rotate });
        }
        await doc.destroy();
        return out;
    }, buf.toString('base64'));
    const pagesDialog = () => page.evaluate(() => ({
        open: !!document.querySelector('#pages-form'),
        title: (document.querySelector('#pages-dialog-title') || {}).textContent || '',
        error: (document.querySelector('.dialog-message.is-error') || {}).textContent || ''
    }));
    const setField = async (selector, value) => {
        if (await page.$eval(selector, e => e.tagName) === 'SELECT') {
            // ng-options values look like "string:letter".
            const option = await page.$eval(selector, (e, v) => [...e.options].find(o => o.value === v || o.value === 'string:' + v).value, value);
            await page.select(selector, option);
            return;
        }
        await page.$eval(selector, e => { e.value = ''; });
        await page.type(selector, String(value));
    };
    // Opens a Pages tab dialog, fills it ({ selector: value }, `file` for the PDF to insert) and runs it.
    const pagesOp = async (label, fields = {}, file) => {
        await page.click('#ribbon-tab-pages'); await sleep(100);
        await page.click(`#ribbon-pages button[aria-label="${label}"]`); await sleep(200);
        for (const [selector, value] of Object.entries(fields)) {
            // true / false: tick or untick a checkbox.
            if (typeof value === 'boolean') { if (await page.$eval(selector, c => c.checked) !== value) await page.click(selector); continue; }
            await setField(selector, value);
        }
        if (file) { await (await page.$('#pages-form input[type=file]')).uploadFile(path.join(FIXTURES, file)); await sleep(200); }
        await page.click('.dialog-footer .tool-primary');
        await page.waitForFunction(() => !document.querySelector('#pages-form') || document.querySelector('.dialog-message.is-error'), { timeout: 30000 });
        await settle();
        return pagesDialog();
    };
    const docState = () => page.evaluate(() => ({
        modified: !!document.querySelector('.doc-modified'),
        unsaved: !!document.querySelector('#unsaved-title'),
        tabs: [...document.querySelectorAll('.ribbon-tab')].map(t => t.textContent.trim())
    }));
    const pageTotal = async () => Number((await state()).pageStatus.split('/')[1]);

    await open('ten-pages.pdf'); await click('Actual size');
    await goTo(2); await click('Highlight'); await drag(40, 100, 300, 130); await click('Highlight');
    let ds = await docState(); s = await state();
    check('pages: a Pages tab after File; a newly opened PDF is not modified',
        ds.tabs[1] === 'Pages' && !ds.modified && s.highlights.length === 1, [ds, s.highlights.length]);

    let po = await pagesOp('Delete pages', { '#pages-input': 'all' });
    check('pages: deleting every page is refused', po.open && /at least one page/.test(po.error), po);
    await setField('#pages-input', '3-99'); await page.click('.dialog-footer .tool-primary'); await sleep(200); po = await pagesDialog();
    check('pages: a page range outside the document is refused', po.open && /outside pages 1 to 10/.test(po.error), po);
    await setField('#pages-input', '1'); await page.click('.dialog-footer .tool-primary');
    await page.waitForFunction(() => !document.querySelector('#pages-form'), { timeout: 30000 }); await settle();
    s = await state(); ds = await docState();
    check('pages: delete page 1: 9 pages, marked as not saved, the highlight moved to page 1',
        s.pageStatus === 'Page: 1 / 9' && ds.modified && /^Deleted 1 page\./.test(s.status) && s.highlights.length === 1 &&
        s.thumbs.find(t => t.page === 1).marks === 1, [s.pageStatus, s.status, ds.modified, s.thumbs.slice(0, 2)]);

    po = await pagesOp('Duplicate pages', { '#pages-input': '1' }); s = await state();
    check('pages: duplicate page 1: the copy follows it with a copy of its highlight',
        !po.open && s.pageStatus === 'Page: 2 / 10' && s.markups.length === 2 && s.thumbs.filter(t => t.page <= 2 && t.marks === 1).length === 2,
        [po, s.pageStatus, s.markups.length]);

    await goTo(1); s = await state(); const before = s.highlights[0];
    po = await pagesOp('Rotate right', { '#pages-input': '1' }); s = await state();
    check('pages: rotate page 1 right: the page turns and its highlight turns with it',
        !po.open && s.canvasW > s.canvasH && s.highlights.length === 1 && near(s.highlights[0].w, before.h, 2) && near(s.highlights[0].h, before.w, 2),
        [s.canvasW, s.canvasH, before, s.highlights[0]]);

    po = await pagesOp('Move pages', { '#pages-input': '10', 'select[aria-label="Where"]': 'start' }); s = await state();
    check('pages: move the last page to the start', !po.open && s.pageStatus === 'Page: 1 / 10' && /^Moved 1 page/.test(s.status), [s.pageStatus, s.status]);

    po = await pagesOp('Blank page', { '#pages-count-input': 2, 'select[aria-label="Where"]': 'end' }); s = await state();
    check('pages: insert 2 blank pages at the end', !po.open && s.pageStatus === 'Page: 11 / 12' && /^Inserted 2 blank pages/.test(s.status), [s.pageStatus, s.status]);

    po = await pagesOp('Insert from file', { '#pages-at-input': 1, '#pages-file-pages-input': '2-3' }, 'landscape.pdf'); s = await state();
    check('pages: insert pages 2-3 of another PDF after page 1', !po.open && s.pageStatus === 'Page: 2 / 14' && /^Inserted 2 pages/.test(s.status), [po, s.pageStatus, s.status]);

    po = await pagesOp('Replace pages', { '#pages-input': '13-14' }, 'one-page.pdf'); s = await state();
    check('pages: replace the 2 blank pages with a 1-page PDF', !po.open && await pageTotal() === 13 && /^Replaced 2 pages/.test(s.status), [po, s.pageStatus, s.status]);

    po = await pagesOp('Extract pages', { '#pages-input': '1, 4-5', '#pages-form input[type=checkbox]': false }); s = await state();
    check('pages: extract pages 1, 4-5 into a new PDF (the document stays as it is)',
        !po.open && /Downloaded ten-pages-pages\.pdf \(3 pages\)/.test(s.status) && await pageTotal() === 13, s.status);
    if (canCheckDownloads) {
        const extracted = await waitForDownload('ten-pages-pages.pdf');
        const pp = extracted && await pdfPages(extracted);
        check('pages: the extracted PDF has those pages', pp && pp.map(p => p.text).join('|') === 'Page 10|Page 2|Page 2', pp);
    }

    await shortcut('KeyS'); await settle(); s = await state(); ds = await docState();
    check('pages: Ctrl+S saves the changed PDF (a download on the web)', /^Downloaded ten-pages\.pdf\. Markups are not in it/.test(s.status) && !ds.modified, [s.status, ds]);
    if (canCheckDownloads) {
        const saved = await waitForDownload('ten-pages.pdf');
        const pp = saved && await pdfPages(saved);
        const expected = 'Page 10|Page 2|Page 3|Page 2|Page 2|Page 3|Page 4|Page 5|Page 6|Page 7|Page 8|Page 9|Page 1';
        check('pages: the saved PDF has every change: order, copies, inserted, rotated and replaced pages',
            pp && pp.map(p => p.text).join('|') === expected && pp[1].w === 842 && pp[2].w === 842 && pp[3].rotate === 90 && pp[3].w === 842 && pp[4].rotate === 0,
            pp && pp.map(p => `${p.text} ${p.w}x${p.h} r${p.rotate}`));
    }

    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyS');
    await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await sleep(200);
    await setField('#save-as-input', 'edited copy'); await page.click('.dialog-footer .tool-primary'); await settle(); s = await state();
    check('pages: Save as asks for the name; the document takes it', s.fileName === 'edited copy.pdf' && /Downloaded edited copy\.pdf/.test(s.status), [s.fileName, s.status]);
    if (canCheckDownloads) check('pages: Save as downloads under the new name', !!(await waitForDownload('edited copy.pdf')));

    await pagesOp('Delete pages', { '#pages-input': '13' });
    await page.click('.doc-tab-close'); await sleep(200); ds = await docState();
    check('pages: closing with unsaved page changes asks first', ds.unsaved && (await state()).fileName === 'edited copy.pdf', ds);
    await click('Cancel'); ds = await docState();
    check('pages: Cancel keeps the document open', !ds.unsaved && ds.modified, ds);
    await (await page.$('.toolbar input[type=file]')).uploadFile(path.join(FIXTURES, 'one-page.pdf')); await sleep(300); ds = await docState();
    check('pages: opening another PDF over unsaved changes asks first', ds.unsaved, ds);
    await click("Don't save"); await settle(); s = await state(); ds = await docState();
    check("pages: Don't save opens the other PDF", s.fileName === 'one-page.pdf' && !ds.modified && !ds.unsaved, [s.fileName, ds]);

    await page.click('#ribbon-tab-file'); await sleep(100); await click('New PDF');
    await setField('#new-count-input', 3); await setField('#new-form select[aria-label="Page size"]', 'letter');
    await setField('#new-form select[aria-label="Orientation"]', 'landscape');
    await page.click('.dialog-footer .tool-primary'); await settle(); s = await state(); ds = await docState();
    check('new PDF: 3 blank Letter landscape pages, untitled and not saved',
        s.fileName === 'Untitled.pdf' && s.pageStatus === 'Page: 1 / 3' && ds.modified && s.canvasW > s.canvasH, [s.fileName, s.pageStatus, ds, s.canvasW, s.canvasH]);
    await click('Save'); await settle(); s = await state();
    check('new PDF: Save downloads it', /Downloaded Untitled\.pdf/.test(s.status) && !(await docState()).modified, s.status);
    if (canCheckDownloads) {
        const created = await waitForDownload('Untitled.pdf');
        const pp = created && await pdfPages(created);
        check('new PDF: the file has 3 blank 792 x 612 pages', pp && pp.length === 3 && pp.every(p => p.w === 792 && p.h === 612 && !p.text), pp);
    }
    await shot('pages');
    await click('Close');

    // ===== Output: annotated / flattened PDF, print, export pages, reports (PDF, Excel, CSV), review and change reports =====
    await page.evaluate(() => {
        // Printing is checked up to the print dialog: count the prepared pages, then close it at once.
        window.print = () => {
            window.__printed = (window.__printed || []).concat([[...document.querySelectorAll('.print-sheets img')].map(i => i.naturalWidth > 0)]);
            setTimeout(() => window.dispatchEvent(new Event('afterprint')), 20);
        };
    });
    // The newest finished download matching `pattern` written after the previous one this section took.
    let since = Date.now();
    const latestDownload = async pattern => {
        for (let t = 0; t < 30000; t += 250) {
            const f = fs.readdirSync(DOWNLOADS).filter(n => pattern.test(n) && !n.endsWith('.crdownload'))
                .map(n => path.join(DOWNLOADS, n)).filter(n => fs.statSync(n).mtimeMs >= since - 50)
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
            if (f && fs.statSync(f).size > 0 && !fs.existsSync(f + '.crdownload')) {
                await sleep(200);   // let the file be written completely
                since = Date.now();
                return fs.readFileSync(f);
            }
            await sleep(250);
        }
        return null;
    };
    const waitStatus = async re => {
        await page.waitForFunction(r => new RegExp(r).test(document.querySelector('.status-text').textContent), { timeout: 60000 }, re.source);
        return (await state()).status;
    };
    await open('ten-pages.pdf'); await click('Actual size');
    await page.keyboard.press('r'); await drag(100, 100, 200, 160);
    await goTo(3); await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('m'); await clickAt(300, 120); await sleep(200);
    await page.keyboard.type('Check the lap length'); await page.click('#note-form ~ .dialog-footer .tool-primary').catch(() => page.click('.dialog-footer .tool-primary')); await sleep(200);
    await page.keyboard.press('s'); await drag(40, 300, 300, 314); await page.keyboard.press('v'); await sleep(100);
    await page.click('#ribbon-tab-output'); await sleep(100);
    const outTools = await page.$$eval('#ribbon-output button', bs => bs.map(b => b.getAttribute('aria-label')));
    check('output: an Output tab with save, flatten, print, export and the reports', outTools.join('|') ===
        'Save annotated PDF|Flatten annotations|Print|Export pages|Export markup list|Markup report|Review report|Change report', outTools);

    await click('Flatten annotations'); await sleep(200);
    await page.click('[aria-labelledby="save-annotated-title"] .tool-primary');
    let os = await waitStatus(/Downloaded|Unable/);
    check('flatten: saves a flattened copy with the markups', /^Downloaded ten-pages-flattened\.pdf with 3 markups \(flattened\)\./.test(os), os);
    if (canCheckDownloads) {
        const flat = await latestDownload(/^ten-pages-flattened.*\.pdf$/);
        const raw = flat ? flat.toString('latin1') : '';
        check('flatten: the copy has no annotations left (part of the page)', !!flat && !raw.includes('/Annots') && (await pdfPages(flat)).length === 10, flat && flat.length);
    }
    await click('Save annotated PDF'); await sleep(200);
    await page.select('[aria-labelledby="save-annotated-title"] select[aria-label="Which pages"]', 'range');
    await page.click('[aria-labelledby="save-annotated-title"] input[aria-label="Page range"]', { clickCount: 3 });
    await page.keyboard.type('1-3');
    await page.click('[aria-labelledby="save-annotated-title"] .tool-primary');
    os = await waitStatus(/Downloaded ten-pages-highlighted|Unable/);
    check('annotated PDF: pages 1-3 with their markups as annotations', /with 3 markups\./.test(os), os);
    if (canCheckDownloads) {
        const copy = await latestDownload(/^ten-pages-highlighted.*\.pdf$/);
        const raw = copy ? copy.toString('latin1') : '';
        check('annotated PDF: 3 pages, the markups still editable annotations', !!copy && (await pdfPages(copy)).length === 3 &&
            /\/Subtype\s*\/Square/.test(raw) && /\/Subtype\s*\/StrikeOut/.test(raw) && /\/Subtype\s*\/Text/.test(raw), copy && copy.length);
    }

    await page.evaluate(() => { window.__printed = []; });
    await shortcut('KeyP'); await sleep(200);
    check('print: Ctrl+P opens the print dialog (not the browser printing the app)', !!(await page.$('#print-dialog-title')));
    await page.select('[aria-labelledby="print-dialog-title"] select[aria-label="Which pages"]', 'range');
    await page.click('[aria-labelledby="print-dialog-title"] input[aria-label="Page range"]', { clickCount: 3 });
    await page.keyboard.type('2-4');
    await page.click('[aria-labelledby="print-dialog-title"] .tool-primary');
    os = await waitStatus(/Sent|Unable/);
    let printed = await page.evaluate(() => window.__printed);
    check('print: the chosen pages are drawn and sent to the print dialog', os === 'Sent 3 pages to the print dialog.' &&
        printed.length === 1 && printed[0].length === 3 && printed[0].every(Boolean), [os, printed]);
    check('print: the prepared pages are removed afterwards', !(await page.$('.print-sheets')) &&
        !(await page.evaluate(() => document.body.classList.contains('is-printing'))));
    await page.evaluate(() => {
        const s = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch { return []; } })
            .filter(r => r.media && /print/.test(r.media.mediaText)).map(r => r.cssText).join(' ');
        window.__printCss = s;
    });
    check('print: in print, only the prepared pages show', /body\.is-printing > \*?:not\(\.print-sheets\)/.test(await page.evaluate(() => window.__printCss)),
        await page.evaluate(() => window.__printCss.slice(0, 200)));

    await click('Export pages'); await sleep(200);
    const withMarkups = await page.$eval('#pages-form input[type=checkbox]', c => c.checked);
    await page.$eval('#pages-input', e => { e.value = ''; }); await page.type('#pages-input', '1, 3');
    await page.click('.dialog-footer .tool-primary');
    os = await waitStatus(/Downloaded ten-pages-highlighted|Unable/);
    check('export pages: selected pages with their markups (the rectangle on 1, comment and strikeout on 3)', withMarkups && /with 3 markups\./.test(os), os);
    if (canCheckDownloads) {
        const pages = await latestDownload(/^ten-pages-highlighted.*\.pdf$/);
        check('export pages: the file has just those pages', !!pages && (await pdfPages(pages)).map(p => p.text).join('|') === 'Page 1|Page 3');
    }

    await click('Review report'); await sleep(300);
    let rpt = await page.evaluate(() => ({ title: document.querySelector('#report-dialog-title').textContent.trim(),
        total: document.querySelector('.report-total').textContent.replace(/\s+/g, ' ').trim(),
        rows: [...document.querySelectorAll('.report-table tbody tr')].map(r => [...r.cells].map(c => c.textContent.trim())) }));
    check('review report: the comment and the strikeout with what they ask for (the rectangle is not a review item)',
        rpt.title === 'Review report' && rpt.rows.length === 2 && rpt.rows.map(r => r[3]).join('|') === 'Check the lap length|Delete the struck-out text' &&
        /^2 review items/.test(rpt.total), rpt);
    await page.click('.dialog-footer .tool-outline:nth-child(4)'); os = await waitStatus(/Downloaded ten-pages-review\.pdf|Unable/);
    check('review report: saved as a PDF report', os === 'Downloaded ten-pages-review.pdf.', os);
    if (canCheckDownloads) {
        const pdf = await latestDownload(/^ten-pages-review.*\.pdf$/);
        const pp = pdf ? await page.evaluate(async b64 => {
            const doc = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)), isEvalSupported: false }).promise;
            const t = await (await doc.getPage(1)).getTextContent();
            return t.items.map(i => i.str).join(' ');
        }, pdf.toString('base64')) : '';
        check('review report: the PDF has the title, summary and rows', /Review report/.test(pp) && /By type: Comment 1/.test(pp) &&
            /Check the lap length/.test(pp) && /Page 1 of 1/.test(pp), pp.slice(0, 300));
    }
    await page.click('.dialog-footer .tool-outline:nth-child(3)'); os = await waitStatus(/Downloaded ten-pages-review\.xlsx|Unable/);
    check('review report: saved as an Excel workbook', os === 'Downloaded ten-pages-review.xlsx.', os);
    if (canCheckDownloads) {
        const xlsx = await latestDownload(/^ten-pages-review.*\.xlsx$/);
        const text = xlsx ? xlsx.toString('latin1') : '';
        check('review report: the workbook is a real .xlsx (zip with the report and summary sheets)', !!xlsx && text.startsWith('PK') &&
            text.includes('xl/worksheets/sheet2.xml'), xlsx && xlsx.length);
    }
    await page.select('[aria-label="Report kind"]', 'string:markups'); await sleep(200);
    rpt = await page.evaluate(() => document.querySelectorAll('.report-table tbody tr').length);
    check('markup list: every markup (export as Excel, CSV, PDF or HTML)', rpt === 3, rpt);
    await page.click('.dialog-footer .tool-outline:nth-child(3)'); os = await waitStatus(/Downloaded ten-pages-markups\.xlsx|Unable/);
    check('markup list: Excel export', os === 'Downloaded ten-pages-markups.xlsx.', os);
    await page.select('[aria-label="Report kind"]', 'string:changes'); await sleep(200);
    check('change report: needs a revision to compare with', /Open the revision to compare with first/.test(await page.$eval('.dialog-message.is-error', e => e.textContent)));
    await page.click('[aria-labelledby="report-dialog-title"] .tool-primary'); await sleep(100);

    await open('one-page-rev-b.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-revision'); await sleep(100);
    await (await page.$('#ribbon-revision input[type=file]')).uploadFile(path.join(FIXTURES, 'one-page.pdf'));
    await page.waitForFunction(() => /changed area|no differences/.test(document.querySelector('.status-text').textContent), { timeout: 30000 });
    await click('Cloud changes'); await sleep(200);
    await page.click('#ribbon-tab-output'); await click('Change report');
    await page.waitForFunction(() => /changes? on/.test((document.querySelector('.report-total') || {}).textContent || ''), { timeout: 30000 });
    rpt = await page.evaluate(() => ({ total: document.querySelector('.report-total').textContent.trim(),
        rows: [...document.querySelectorAll('.report-table tbody tr')].map(r => [...r.cells].map(c => c.textContent.trim())) }));
    check('change report: every changed area against the compared revision, where it is and whether it is clouded',
        rpt.total === '2 changes on 1 of 1 page' && rpt.rows.length === 2 && rpt.rows.every(r => r[2] === 'Changed area' && /mm at/.test(r[4]) && /^Yes/.test(r[5])), rpt);
    await page.click('.dialog-footer .tool-outline:nth-child(1)'); os = await waitStatus(/Downloaded one-page-rev-b-changes\.csv|Unable/);
    check('change report: CSV export', os === 'Downloaded one-page-rev-b-changes.csv.', os);
    await page.click('[aria-labelledby="report-dialog-title"] .tool-primary'); await sleep(100);
    await click('Close comparison'); await click('Clear Markups').catch(() => {});

    // ===== Search by drawing / beam / column number; page size; document properties =====
    const results = () => page.evaluate(() => ({
        count: (document.querySelector('.find-count') || {}).textContent || '',
        summary: ((document.querySelector('.find-summary') || {}).textContent || '').trim(),
        groups: [...document.querySelectorAll('.find-results li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
        kind: document.querySelector('.find-kind') ? document.querySelector('.find-kind').selectedOptions[0].textContent.trim() : '',
        page: Number(document.querySelector('.page-input').value)
    }));
    const searchDone = async () => {
        await sleep(450);   // typing starts the search after a short pause
        await page.waitForFunction(() => !/Searching|…/.test((document.querySelector('.find-count') || {}).textContent || ''), { timeout: 20000 });
        await sleep(200);
    };
    await open('drawing-set.pdf');
    await page.click('#ribbon-tab-navigation'); await sleep(100);
    await page.click('button[aria-label="Find drawing number"]'); await searchDone(); let sr = await results();
    check('search: drawing numbers of every page, the title block one first', sr.kind === 'Drawing no.' &&
        sr.groups.join('|') === 'Page 1 S-101 S-201|Page 2 S-102|Page 3 S-103' && sr.summary === '4 drawing numbers on 3 pages', sr);
    await page.type('#find-input', 's102'); await searchDone(); sr = await results(); await settle();
    check('search: a drawing number however it is typed (s102 finds S-102) goes to its page',
        sr.groups.join('|') === 'Page 2 S-102' && sr.count === '1 of 1' && sr.page === 2, sr);
    await page.click('button[aria-label="Find beam"]'); await searchDone(); sr = await results();
    check('search: every beam mark, by page', sr.groups.join('|') === 'Page 1 B1 B12 FB3|Page 2 B12 ×2 GB-4' &&
        sr.summary === '4 beam marks on 2 pages', sr);
    await page.type('#find-input', '12'); await searchDone(); sr = await results();
    check('search: beam number 12 (B12 on two pages, not B1)', sr.groups.join('|') === 'Page 1 B12|Page 2 B12 ×2' && sr.count.endsWith('of 3'), sr);
    await page.click('#find-input', { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type('#find-input', 'gb4'); await searchDone(); sr = await results();
    check('search: a beam mark however it is separated (gb4 finds GB-4)', sr.groups.join('|') === 'Page 2 GB-4', sr);
    await page.click('button[aria-label="Find column"]'); await searchDone(); sr = await results();
    check('search: every column mark', sr.groups.join('|') === 'Page 1 C1 C-2|Page 2 C1|Page 3 SC3', sr);
    await page.type('#find-input', '2'); await searchDone(); sr = await results(); await settle();
    check('search: column 2 finds C-2', sr.groups.join('|') === 'Page 1 C-2' && sr.page === 1, sr);
    await page.click('.find-hit'); await sleep(200);
    check('search: a result in the list shows its page', (await results()).page === 1);
    await page.select('.find-kind', 'string:text'); await page.click('#find-input', { clickCount: 3 }); await page.keyboard.press('Backspace');
    await page.type('#find-input', 'concrete'); await searchDone(); sr = await results();
    check('search: back to plain text', sr.groups.join('|') === 'Page 3 concrete' && sr.count === '1 of 1', sr);
    await page.click('button[aria-label="Results list"]'); await sleep(100);
    check('search: the list can be hidden', (await results()).groups.length === 0);
    await page.keyboard.press('Escape'); await sleep(100); await goTo(3);
    const sizeText = await page.$eval('.page-size', e => ({ text: e.textContent.trim(), title: e.title }));
    check('page size: the status bar shows the paper and size', sizeText.text === 'A3 · 420 × 297 mm' &&
        /16\.54 × 11\.69 in/.test(sizeText.title) && /landscape/.test(sizeText.title), sizeText);
    await shortcut('KeyD'); await page.waitForSelector('.properties-list'); await sleep(200);
    const props = await page.evaluate(() => {
        const rows = {};
        document.querySelectorAll('.properties-list > div').forEach(d => { rows[d.querySelector('dt').textContent.trim()] = d.querySelector('dd').textContent.trim(); });
        return { rows, sizes: [...document.querySelectorAll('.properties-sizes tbody tr')].map(r => [...r.cells].map(c => c.textContent.replace(/\s+/g, ' ').trim()).join(' | ')) };
    });
    check('properties: Ctrl+D shows the metadata', props.rows.Title === 'Structural drawings' && props.rows.Author === 'Test Engineer' &&
        props.rows.Subject === 'Ground floor' && props.rows.Keywords === 'beams, columns' && props.rows.Application === 'CAD Export' &&
        props.rows['PDF producer'] === 'Fixture writer', props.rows);
    check('properties: file, PDF version, pages and security', props.rows['File name'] === 'drawing-set.pdf' && props.rows['PDF version'] === '1.7' &&
        props.rows.Pages === '3' && props.rows.Security === 'None' && /bytes\)$/.test(props.rows['File size']), props.rows);
    check('properties: the creation date (with its time zone) is shown as a date',
        props.rows.Created === new Date(Date.UTC(2024, 0, 15, 4, 0, 0)).toLocaleString('en-US') || /2024/.test(props.rows.Created), props.rows.Created);
    check('properties: page sizes with paper names', props.sizes.join('|') === 'A3 landscape | 420 × 297 mm | 16.54 × 11.69 in | 3 (1-3)', props.sizes);
    await page.keyboard.press('Escape'); await sleep(100);
    await open('mixed-sizes.pdf'); await shortcut('KeyD'); await page.waitForSelector('.properties-sizes tbody tr'); await sleep(200);
    const mixed = await page.$$eval('.properties-sizes tbody tr td:first-child', tds => tds.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
    check('properties: every page size of a mixed set (Letter, A4, A3, custom)', mixed.join('|') ===
        'Letter portrait|A4 landscape|A3 portrait|Custom landscape|Custom landscape', mixed);
    await page.keyboard.press('Escape'); await sleep(100);

    // ===== Drawing navigation: single page / continuous scrolling, full screen, pan =====
    const view = () => page.evaluate(() => {
        const scroll = document.querySelector('.viewer-scroll');
        const slot = n => document.querySelector(`.page-slot[data-page="${n}"]`);
        return {
            continuous: scroll.classList.contains('is-continuous'),
            single: document.querySelector('button[aria-label="Single page"]').getAttribute('aria-pressed') === 'true',
            slots: [...document.querySelectorAll('.page-slot')].map(s => Number(s.dataset.page)),
            drawn: [...document.querySelectorAll('.page-slot canvas')].length,
            top: scroll.scrollTop,
            page: Number(document.querySelector('.page-input').value),
            slotTops: Object.fromEntries([...document.querySelectorAll('.page-slot')].map(s => [s.dataset.page, parseFloat(s.style.top)])),
            activeTop: parseFloat(document.querySelector('.pdf-page').style.top || '0'),
            page1Highlights: slot(1) ? slot(1).querySelectorAll('.slot-highlight').length : -1,
            page1Shapes: slot(1) ? slot(1).querySelectorAll('.slot-markups g.markup').length : -1,
            fullScreen: document.querySelector('.app').classList.contains('is-fullscreen'),
            toolbarShown: !!document.querySelector('.toolbar').offsetParent,
            bar: !!document.querySelector('.fullscreen-bar')
        };
    });
    const scrollViewer = async y => { await page.evaluate(v => { document.querySelector('.viewer-scroll').scrollTop = v; }, y); await sleep(400); await settle(); };
    await open('ten-pages.pdf'); await click('Actual size');
    await page.click('#ribbon-tab-navigation'); await sleep(100);
    let vw = await view();
    check('view: single page by default', vw.single && !vw.continuous && vw.slots.length === 0, vw);
    await click('Continuous'); await sleep(800); await settle(); vw = await view();
    check('view: continuous scrolling stacks the pages; the next one is drawn below', vw.continuous && !vw.single &&
        vw.slots[0] === 1 && vw.slots.includes(2) && vw.drawn >= 1 && vw.page === 1, vw);
    await click('Highlight'); await drag(40, 100, 300, 130); await click('Highlight');
    await click('Rectangle'); await drag(60, 300, 200, 380); await click('Rectangle');
    const page2Top = vw.slotTops[2];
    await scrollViewer(page2Top + 16); vw = await view();
    check('view: scrolling makes the page filling the view current', vw.page === 2 && near(vw.activeTop, page2Top, 1), [vw.page, vw.activeTop, page2Top]);
    check('view: page 1 above shows its highlight and rectangle on the image', vw.page1Highlights === 1 && vw.page1Shapes === 1, vw);
    s = await state();
    check('view: the thumbnail follows the scrolled page', s.thumbs.find(t => t.current).page === 2, s.thumbs.filter(t => t.current));
    await click('Next page'); vw = await view();
    check('view: Next page scrolls to the top of page 3', vw.page === 3 && Math.abs(vw.top - (vw.slotTops[3] + 16)) <= 16, [vw.page, vw.top, vw.slotTops[3]]);
    await goTo(7); await sleep(300); vw = await view();
    check('view: typing a page number scrolls to it', vw.page === 7 && vw.slots.includes(7), [vw.page, vw.slots]);
    const before7 = vw.top;
    const box7 = await (await page.$('.interaction-layer')).boundingBox();
    await page.mouse.move(box7.x + 200, box7.y + 300); await page.mouse.down();
    await page.mouse.move(box7.x + 200, box7.y + 100, { steps: 6 }); await page.mouse.up(); await sleep(400); vw = await view();
    check('view: pan (drag the page) scrolls through the pages', vw.top - before7 > 150, [before7, vw.top]);
    await click('Zoom out'); await click('Zoom out'); await click('Zoom out'); await sleep(500); await settle(); vw = await view();
    const other = vw.slots.find(n => n !== vw.page);
    await page.click(`.page-slot[data-page="${other}"]`); await sleep(300); await settle(); vw = await view();
    check('view: zoomed out, several pages show; a click on one makes it current', vw.slots.length >= 4 && vw.page === other, [vw.slots, vw.page, other]);
    await page.click('#ribbon-tab-zoom'); await click('Actual size'); await page.click('#ribbon-tab-navigation');

    await click('Full screen'); await sleep(300); vw = await view();
    check('full screen: only the page and the page controls', vw.fullScreen && !vw.toolbarShown && vw.bar, vw);
    const fsPage = vw.page;
    await page.keyboard.press('PageDown'); await sleep(300); await settle(); vw = await view();
    check('full screen: PageDown turns the page', vw.page === fsPage + 1, [fsPage, vw.page]);
    await page.keyboard.press('Escape'); await sleep(300); vw = await view();
    check('full screen: Esc leaves it', !vw.fullScreen && vw.toolbarShown && !vw.bar, vw);
    await shortcut('KeyL'); vw = await view();
    check('full screen: Ctrl+L enters it', vw.fullScreen, vw);
    await page.click('.fullscreen-bar button[aria-label="Exit full screen"]'); await sleep(300); vw = await view();
    check('full screen: the bar button leaves it', !vw.fullScreen, vw);

    await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.toolbar'); await sleep(300);
    await open('ten-pages.pdf'); vw = await view();
    check('view: continuous scrolling is remembered', vw.continuous && vw.slots.length > 0, vw);
    await click('Single page'); await sleep(300); vw = await view();
    check('view: back to single page', vw.single && !vw.continuous && vw.slots.length === 0 && vw.page >= 1, vw);
    await shot('continuous');

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

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
// The host's Recent Files list goes to a throwaway file, never the user's real list.
const RECENT_FILE = path.join(require('os').tmpdir(), `pdfviewer-test-recent-${process.pid}.json`);

async function startHost() {
    const project = path.join(__dirname, '..', 'desktop');
    const host = spawn(DOTNET, ['run', '--project', project], {
        env: { ...process.env, PDFVIEWER_TEST_PORT: PORT, PDFVIEWER_RECENT_FILE: RECENT_FILE, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
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

        // Stand-in for Photino's bridge: every message goes to the host's test endpoint, with the
        // answers for any native dialog taken from window.__dialog = { files, save, folder }.
        await page.evaluateOnNewDocument(() => {
            const listeners = [];
            const bridge = {
                sendMessage(raw) {
                    const message = JSON.parse(raw);
                    window.__sent = (window.__sent || []).concat(message.type);
                    fetch('/api/test/message', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(Object.assign({ message: raw }, window.__dialog || {}))
                    }).then(r => r.json()).then(replies => {
                        replies.forEach(reply => listeners.forEach(l => l(JSON.stringify(reply))));
                        if (message.type === 'open') window.__openReplies = (window.__openReplies || 0) + 1;
                        window.__replyCount = (window.__replyCount || 0) + 1;
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
                zoom: q('.zoom-value').value.trim(),
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
            await page.evaluate(p => { window.__dialog = { files: [p] }; }, path.isAbsolute(file) ? file : fixture(file));
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
        await open('rotated.pdf'); await click('Actual size'); s = await state();
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

        // ----- PDF tools (native dialogs answered by the test) -----
        const os = require('os');
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfviewer-tools-'));
        const dialogResult = () => page.evaluate(() => ({
            error: (document.querySelector('.dialog-message.is-error') || {}).textContent || '',
            result: (document.querySelector('.dialog-message.is-success') || {}).textContent || ''
        }));
        // Runs the tool and waits for the host's reply (a cancelled dialog shows no message).
        const runTool = async dialog => {
            const before = await page.evaluate(d => { window.__dialog = d; return window.__replyCount || 0; }, dialog);
            await page.click('.dialog-footer .tool-primary');
            await page.waitForFunction(n => (window.__replyCount || 0) > n, { timeout: 120000 }, before);
            await sleep(200);
            return dialogResult();
        };
        const closeDialog = async () => { await page.keyboard.press('Escape'); await sleep(200); };
        let r;

        await open('ten-pages.pdf');
        await click('Merge');
        await page.evaluate(d => { window.__dialog = d; }, { files: [fixture('one-page.pdf'), fixture('landscape.pdf')] });
        await page.click('.dialog .tool-outline');   // "Add PDF files" -> native multi-select
        await page.waitForFunction(() => document.querySelectorAll('.merge-list li').length === 3, { timeout: 10000 });
        const mergedPath = path.join(outDir, 'merged');   // the app adds .pdf
        r = await runTool({ save: mergedPath });
        check('desktop merge writes the chosen file', /Merged 3 files \(14 pages\) into merged\.pdf/.test(r.result) &&
            fs.readFileSync(mergedPath + '.pdf').subarray(0, 5).toString() === '%PDF-', r);
        r = await runTool({ save: fixture('ten-pages.pdf') });
        check('desktop merge refuses to overwrite an input file', /cannot replace one of the input files/.test(r.error), r.error);
        r = await runTool({});
        check('cancelling the save dialog does nothing', !r.error && !r.result, r);
        await closeDialog();

        await click('Split'); await page.click('input[value=chunks]');
        await page.$eval('.inline-number', e => { e.value = ''; }); await page.type('.inline-number', '4');
        await page.$eval('.inline-number', e => e.dispatchEvent(new Event('input')));
        r = await runTool({ folder: outDir });
        const splitDir = path.join(outDir, 'ten-pages-split');
        check('desktop split writes files into a new subfolder', /Created 3 PDF files/.test(r.result) &&
            fs.readdirSync(splitDir).sort().join(',') === 'ten-pages-p1-4.pdf,ten-pages-p5-8.pdf,ten-pages-p9-10.pdf', r);
        r = await runTool({ folder: outDir });
        check('second split goes to a separate folder', fs.existsSync(path.join(outDir, 'ten-pages-split (2)')), r);
        await closeDialog();

        await click('Convert'); await page.click('input[value=docx]');
        r = await runTool({ save: path.join(outDir, 'text.docx') });
        check('desktop convert to Word', /Saved text\.docx/.test(r.result) && fs.readFileSync(path.join(outDir, 'text.docx')).subarray(0, 2).toString() === 'PK', r);
        await page.click('input[value=png]'); await page.select('.choice-indent select', 'number:72');
        r = await runTool({ folder: outDir });
        check('desktop convert to PNG', /Saved 10 PNG images/.test(r.result) && fs.readdirSync(path.join(outDir, 'ten-pages-images')).length === 10, r);
        await closeDialog();

        await open('image-based.pdf');
        await click('Compress');
        r = await runTool({ save: path.join(outDir, 'small.pdf') });
        check('desktop compress', /% smaller|already compact|Ghostscript, which is not installed/.test(r.result + r.error) &&
            (!/smaller/.test(r.result) || fs.statSync(path.join(outDir, 'small.pdf')).size < fs.statSync(fixture('image-based.pdf')).size), r);
        await closeDialog();
        // Save highlights into a copy (PDFium writes the annotations; PDFium renders them on reopen)
        const yellowCount = () => page.evaluate(() => {
            const canvas = document.querySelector('.canvas-layer canvas');
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let yellow = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 170 && data[i + 2] < 120) yellow++;
            return yellow;
        });
        await open('ten-pages.pdf'); await click('Actual size');
        await click('Highlight'); await drag(60, 120, 360, 160); await click('Highlight');
        const saveHighlights = async dialog => {
            const before = await page.evaluate(d => { window.__dialog = d; return window.__replyCount || 0; }, dialog);
            await page.click('#ribbon-tab-markup');
            await page.click('button[aria-label="Save with markups"]');
            await page.waitForFunction(n => (window.__replyCount || 0) > n, { timeout: 60000 }, before);
            await sleep(200);
            return page.$eval('.status-text', e => e.textContent);
        };
        let status = await saveHighlights({ save: fixture('ten-pages.pdf') });
        check('desktop: saving highlights never overwrites the open PDF', /cannot replace one of the input files/.test(status), status);
        await dismiss();
        const highlightedPath = path.join(outDir, 'with-highlights.pdf');
        status = await saveHighlights({ save: highlightedPath });
        check('desktop: copy with highlights saved', /with-highlights\.pdf with 1 markup/.test(status) && fs.existsSync(highlightedPath), status);
        check('desktop: original PDF unchanged', fs.statSync(fixture('ten-pages.pdf')).size === fs.readFileSync(fixture('ten-pages.pdf')).length &&
            !fs.readFileSync(fixture('ten-pages.pdf')).includes('/Highlight'));
        await open(highlightedPath); await click('Actual size');
        check('desktop: reopened copy shows the highlight (PDFium)', (await state()).highlights.length === 0 && await yellowCount() > 5000, await yellowCount());

        // ----- Revision: compare with another revision (opened by the host), save the markup report -----
        const revisionState = () => page.evaluate(() => ({
            status: document.querySelector('.status-text').textContent.trim(),
            regions: document.querySelectorAll('.revision-region').length,
            file: (document.querySelector('.compare-file') || { textContent: '' }).textContent.trim()
        }));
        await open('one-page-rev-b.pdf'); await click('Actual size');
        await page.click('#ribbon-tab-revision');
        await page.evaluate(p => { window.__dialog = { files: [p] }; }, fixture('one-page.pdf'));
        await click('Compare with a revision');
        await page.waitForFunction(() => /changed area|no differences|Unable/.test(document.querySelector('.status-text').textContent), { timeout: 30000 });
        let rvs = await revisionState();
        check('desktop: Compare opens the other revision on the host (PDFium) and finds the 2 changed areas',
            rvs.regions === 2 && rvs.file === 'one-page.pdf' && /2 changed areas/.test(rvs.status), rvs);
        await page.evaluate(() => { window.__dialog = { files: [] }; });
        await click('Compare with a revision'); await sleep(500); rvs = await revisionState();
        check('desktop: cancelling the open dialog keeps the comparison', rvs.regions === 2 && rvs.file === 'one-page.pdf', rvs);
        await click('Cloud changes'); await sleep(300);
        await page.click('button[aria-label="Markup report"]'); await sleep(200);
        const reportPath = path.join(outDir, 'report');
        const saveReport = async (dialog, button) => {
            const before = await page.evaluate(d => { window.__dialog = d; return window.__replyCount || 0; }, dialog);
            await page.click(button);
            await page.waitForFunction(n => (window.__replyCount || 0) > n, { timeout: 30000 }, before);
            await sleep(200);
            return page.$eval('.status-text', e => e.textContent.trim());
        };
        status = await saveReport({ save: reportPath }, '.dialog-footer .tool-outline');
        const csvText = fs.existsSync(reportPath + '.csv') ? fs.readFileSync(reportPath + '.csv', 'utf8') : '';
        check('desktop: markup report saved as CSV where chosen (extension added, UTF-8 with BOM)',
            status === 'Saved report.csv.' && csvText.startsWith('\ufeffNo.,Page,Type,Content,Colour,Revision,Created') &&
            csvText.trim().split('\r\n').length === 3, [status, csvText.slice(0, 120)]);
        status = await saveReport({ save: reportPath + '.html' }, '.dialog-footer .tool-outline:nth-child(2)');
        check('desktop: printable report saved as HTML', status === 'Saved report.html.' &&
            /<h1>Markup report<\/h1>/.test(fs.readFileSync(reportPath + '.html', 'utf8')), status);
        await page.click('[aria-labelledby="report-dialog-title"] .dialog-footer .tool-primary'); await sleep(100);
        await click('Close comparison'); rvs = await revisionState();
        check('desktop: closing the comparison tells the host and clears the view',
            rvs.regions === 0 && rvs.file === '' && (await state()).sent.includes('close-compare'), rvs);

        // ----- Pages: edits go to a working copy; Save writes the file; Save As, Extract, New -----
        const pdfPages = file => page.evaluate(async b64 => {
            const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
            const out = [];
            for (let i = 1; i <= doc.numPages; i++) {
                const p = await doc.getPage(i);
                const v = p.getViewport({ scale: 1 });
                const items = (await p.getTextContent()).items.filter(t => t.str.trim());
                out.push({ text: items.length ? items[0].str.trim() : '', w: Math.round(v.width), rotate: p.rotate });
            }
            await doc.destroy();
            return out;
        }, fs.readFileSync(file).toString('base64'));
        // Runs `action` with the given answers for the native dialogs and waits for the host's reply.
        const withHost = async (dialog, action) => {
            const before = await page.evaluate(d => { window.__dialog = d; return window.__replyCount || 0; }, dialog);
            await action();
            await page.waitForFunction(n => (window.__replyCount || 0) > n, { timeout: 30000 }, before);
            await settle();
        };
        const pagesOp = async (label, fields, dialog = {}) => {
            await page.click('#ribbon-tab-pages'); await sleep(100);
            await page.click(`#ribbon-pages button[aria-label="${label}"]`); await sleep(200);
            for (const [selector, value] of Object.entries(fields)) {
                if (await page.$eval(selector, e => e.tagName) === 'SELECT') { await page.select(selector, value); continue; }
                await page.$eval(selector, e => { e.value = ''; }); await page.type(selector, String(value));
            }
            await withHost(dialog, () => page.click('.dialog-footer .tool-primary'));
        };
        const docInfo = () => page.evaluate(() => ({
            status: document.querySelector('.status-text').textContent.trim(),
            fileName: document.querySelector('.file-name') ? document.querySelector('.file-name').textContent.trim() : '',
            pages: document.querySelector('.page-total').textContent.replace('of', '').trim(),
            modified: !!document.querySelector('.doc-modified'),
            unsaved: !!document.querySelector('#unsaved-title'),
            dialog: !!document.querySelector('#pages-form')
        }));
        const workPath = path.join(outDir, 'pages-work.pdf');
        fs.copyFileSync(fixture('ten-pages.pdf'), workPath);
        const originalSize = fs.statSync(workPath).size;
        await open(workPath);
        await pagesOp('Delete pages', { '#pages-input': '1' }); let di = await docInfo();
        check('desktop pages: delete page 1 shows 9 pages, not saved; the file is unchanged',
            di.pages === '9' && di.modified && /^Deleted 1 page/.test(di.status) && fs.statSync(workPath).size === originalSize, [di, fs.statSync(workPath).size]);
        await page.click('#ribbon-pages button[aria-label="Insert from file"]'); await sleep(200);
        await withHost({ files: [fixture('landscape.pdf')] }, () => page.click('#pages-form button.tool-outline'));
        await page.select('#pages-form select[aria-label="Where"]', 'end');
        await withHost({}, () => page.click('.dialog-footer .tool-primary')); di = await docInfo();
        check('desktop pages: insert every page of a file picked in the native dialog', di.pages === '12' && /^Inserted 3 pages/.test(di.status) && !di.dialog, di);
        await pagesOp('Rotate right', { '#pages-input': '1' });
        await pagesOp('Duplicate pages', { '#pages-input': '2' }); di = await docInfo();
        check('desktop pages: rotate and duplicate', di.pages === '13' && /^Duplicated 1 page/.test(di.status), di);

        await withHost({}, async () => { await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); });
        di = await docInfo();
        let pp = await pdfPages(workPath);
        check('desktop pages: Ctrl+S writes the changes to the file', /^Saved pages-work\.pdf\./.test(di.status) && !di.modified &&
            pp.length === 13 && pp[0].text === 'Page 2' && pp[0].rotate === 90 && pp[1].text === 'Page 3' && pp[2].text === 'Page 3' &&
            pp.slice(10).every(p => p.w === 842), [di.status, pp.map(p => `${p.text} ${p.w} r${p.rotate}`)]);

        const saveAsPath = path.join(outDir, 'pages-save-as');   // the app adds .pdf
        await page.click('#ribbon-tab-file');
        await withHost({ save: saveAsPath }, () => page.click('button[aria-label="Save as"]')); di = await docInfo();
        check('desktop pages: Save as writes another file, which the document then belongs to',
            di.fileName === 'pages-save-as.pdf' && fs.existsSync(saveAsPath + '.pdf') && (await pdfPages(saveAsPath + '.pdf')).length === 13, di);
        await withHost({}, () => page.click('button[aria-label="Save as"]')); di = await docInfo();
        check('desktop pages: cancelling Save as saves nothing', di.status === 'Not saved.' && di.fileName === 'pages-save-as.pdf', di);

        const extractPath = path.join(outDir, 'extracted.pdf');
        await pagesOp('Extract pages', { '#pages-input': '1-2, 13' }, { save: extractPath }); di = await docInfo();
        pp = fs.existsSync(extractPath) ? await pdfPages(extractPath) : [];
        check('desktop pages: extract pages into a new file (save dialog)', /Saved 3 pages as extracted\.pdf/.test(di.status) && pp.length === 3 &&
            pp[0].text === 'Page 2' && pp[2].w === 842 && di.pages === '13', [di.status, pp]);

        await pagesOp('Delete pages', { '#pages-input': '13' });
        await page.evaluate(p => { window.__dialog = { files: [p] }; }, fixture('one-page.pdf'));
        await page.click('#ribbon-tab-file'); await click('Open PDF'); di = await docInfo();
        check('desktop pages: opening another PDF over unsaved changes asks first', di.unsaved && di.fileName === 'pages-save-as.pdf', di);
        const openBefore = await page.evaluate(() => window.__openReplies || 0);
        await click("Don't save");
        await page.waitForFunction(n => (window.__openReplies || 0) > n, { timeout: 30000 }, openBefore); await settle(); di = await docInfo();
        check("desktop pages: Don't save opens the other PDF and leaves the saved file as it was",
            di.fileName === 'one-page.pdf' && !di.modified && (await pdfPages(saveAsPath + '.pdf')).length === 13, di);

        await click('New PDF'); await page.$eval('#new-count-input', e => { e.value = ''; }); await page.type('#new-count-input', '2');
        await withHost({}, () => page.click('.dialog-footer .tool-primary')); di = await docInfo();
        check('desktop pages: New PDF opens 2 blank pages, untitled and not saved', di.fileName === 'Untitled.pdf' && di.pages === '2' && di.modified, di);
        const newPath = path.join(outDir, 'brand-new.pdf');
        await withHost({ save: newPath }, () => page.click('button[aria-label="Save"]')); di = await docInfo();
        pp = fs.existsSync(newPath) ? await pdfPages(newPath) : [];
        check('desktop pages: Save of a new PDF asks where, then writes it', di.fileName === 'brand-new.pdf' && !di.modified &&
            pp.length === 2 && pp.every(p => p.w === 595 && !p.text), [di, pp]);
        const recentNames = await page.evaluate(() => [...document.querySelectorAll('.menu-recent-name')].map(e => e.textContent.trim()));
        check('desktop pages: saved files join Recent files', recentNames[0] === 'brand-new.pdf' && recentNames.includes('pages-save-as.pdf'), recentNames);
        await click('Close');

        const leftovers = fs.readdirSync(outDir).filter(f => f.endsWith('.tmp'));
        check('no temporary files left behind', leftovers.length === 0, leftovers);
        fs.rmSync(outDir, { recursive: true, force: true });

        // ----- Recent files (desktop: paths kept by the host, reopened from disk) -----
        const recentDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pdfviewer-recent-'));
        const movable = path.join(recentDir, 'movable.pdf');
        fs.copyFileSync(fixture('one-page.pdf'), movable);
        // A real PDF that is never opened, so it is never on the recent list.
        const neverOpened = path.join(recentDir, 'never-opened.pdf');
        fs.copyFileSync(fixture('one-page.pdf'), neverOpened);
        const sendAndWait = async (message) => {
            const before = await page.evaluate(() => window.__replyCount || 0);
            await page.evaluate(m => window.external.sendMessage(JSON.stringify(m)), message);
            await page.waitForFunction(n => (window.__replyCount || 0) > n, { timeout: 30000 }, before);
            await sleep(200);
        };
        const recentState = () => page.evaluate(() => ({
            menu: [...document.querySelectorAll('#menu-file .menu-item-recent')].map(b => b.getAttribute('aria-label')),
            start: [...document.querySelectorAll('.recent-start-item')].map(b => ({
                name: b.querySelector('.recent-start-name').textContent.trim(),
                detail: b.querySelector('.recent-start-detail').textContent.trim(),
                missing: b.classList.contains('is-missing')
            }))
        }));
        const reloadApp = async () => {
            await page.reload({ waitUntil: 'load' }); await page.waitForSelector('.toolbar');
            await page.waitForFunction(() => (window.__replyCount || 0) > 0, { timeout: 30000 }); await sleep(300);
        };

        await open(movable);
        let rs = await recentState();
        check('desktop recent: opened file is first in File menu', rs.menu[0] === 'Open recent: movable.pdf', rs.menu);
        const saved = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
        check('desktop recent: list saved with full paths', saved[0].path === movable && saved.some(e => e.path === fixture('ten-pages.pdf')), saved.map(e => e.path));
        check('desktop recent: failed opens are not remembered', !saved.some(e => /corrupt|empty|notes/.test(e.path)), saved.map(e => e.path));

        await reloadApp(); rs = await recentState();
        check('desktop recent: host sends the list on ready (start screen)', rs.start[0] && rs.start[0].name === 'movable.pdf' && rs.start[0].detail === recentDir, rs.start);
        await page.evaluate(() => [...document.querySelectorAll('.recent-start-item')].find(b => b.textContent.includes('ten-pages.pdf')).click());
        await page.waitForFunction(() => document.querySelector('.file-name'), { timeout: 30000 }); await settle(); s = await state();
        check('desktop recent: reopen from start screen (from disk)', s.fileName === 'ten-pages.pdf' && s.pageStatus === 'Page: 1 / 10' && s.inked > 1000, [s.fileName, s.pageStatus]);

        fs.rmSync(movable);
        await reloadApp(); rs = await recentState();
        const gone = rs.start.find(f => f.name === 'movable.pdf');
        check('desktop recent: a deleted file is shown as missing', gone && gone.missing && gone.detail.startsWith('Missing'), rs.start);
        await page.evaluate(() => [...document.querySelectorAll('.recent-start-item')].find(b => b.textContent.includes('movable.pdf')).click());
        await page.waitForFunction(() => document.querySelector('.alert'), { timeout: 30000 }); await sleep(200);
        s = await state(); rs = await recentState();
        check('desktop recent: opening it explains and removes it', /movable\.pdf was moved or deleted/.test(s.error) && !rs.start.some(f => f.name === 'movable.pdf'), [s.error, rs.start]);
        await dismiss();

        await sendAndWait({ type: 'open-recent', path: neverOpened });
        s = await state();
        check('desktop recent: host refuses paths that are not on the list', s.error === 'That file is not in the recent files list.' && s.empty, s.error);
        await dismiss();

        await page.click('#menu-file-button'); await sleep(100);
        await page.evaluate(() => [...document.querySelectorAll('#menu-file .menu-item')].find(b => b.textContent.includes('Clear recent files')).click());
        await sleep(600); rs = await recentState();
        check('desktop recent: Clear empties the list and the saved file', rs.menu.length === 0 && rs.start.length === 0 &&
            JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')).length === 0, rs);
        fs.rmSync(recentDir, { recursive: true, force: true });

        // ----- Find (PDFium search on the host) -----
        const findState = () => page.evaluate(() => {
            const q = s => document.querySelector(s);
            return {
                open: !!q('.find-bar'),
                count: q('.find-count') ? q('.find-count').textContent.trim() : '',
                page: Number(q('.page-input').value),
                hits: [...document.querySelectorAll('.search-hit')].map(h => ({
                    l: parseFloat(h.style.left), t: parseFloat(h.style.top), w: parseFloat(h.style.width), h: parseFloat(h.style.height),
                    cur: h.classList.contains('is-current')
                }))
            };
        });
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
        let f;

        await open('ten-pages.pdf'); await click('Actual size');
        await page.keyboard.down('Control'); await page.keyboard.press('KeyF'); await page.keyboard.up('Control');
        await sleep(200); f = await findState();
        check('desktop find: Ctrl+F opens the find bar', f.open, f);
        await typeFind('Page 7'); f = await findState();
        check('desktop find: finds text with PDFium', f.count === '1 of 1' && f.page === 7 && f.hits.length === 1 && f.hits[0].cur, f);
        // "Page 7" is set in 26 pt Helvetica at x = 50, baseline 70 pt below the top of the page.
        const title = f.hits[0] || {};
        check('desktop find: match box is on the text', near(title.l, 50, 3) && title.t < 70 && title.t + title.h > 60 && title.w > 60 && title.w < 110, title);
        await typeFind('fox'); f = await findState();
        check('desktop find: all pages searched (30 matches per page)', f.count.endsWith('of 300') && f.page === 7, f.count);
        await page.keyboard.press('Enter'); await sleep(200); await settle(); f = await findState();
        check('desktop find: Enter goes to the next match', /^\d+ of 300$/.test(f.count) && f.hits.some(h => h.cur), f.count);
        await typeFind('Page 1'); await page.click('.find-bar button[aria-label="Whole words"]'); await sleep(200); await findDone(); f = await findState();
        check('desktop find: Whole words', f.count === '1 of 1' && f.page === 1, f.count);
        await page.click('.find-bar button[aria-label="Whole words"]'); await sleep(200); await findDone();
        await typeFind('page 1'); await page.click('.find-bar button[aria-label="Match case"]'); await sleep(200); await findDone(); f = await findState();
        check('desktop find: Match case', f.count === 'No matches' && f.hits.length === 0, f.count);
        await page.click('.find-bar button[aria-label="Match case"]'); await sleep(200); await findDone();

        await open('rotated.pdf'); await typeFind('Page 1'); f = await findState();
        check('desktop find: rotated page: match box turns with the text', f.count === '1 of 1' && f.hits.length === 1 && f.hits[0].h > f.hits[0].w * 2, f.hits);
        await open('image-based.pdf'); await typeFind('fox'); f = await findState();
        check('desktop find: no matches', f.count === 'No matches' && f.hits.length === 0, f.count);
        await open('large-150.pdf'); await typeFind('the'); f = await findState();
        check('desktop find: stops at 1000 matches', f.count === '1 of 1000+', f.count);
        await page.keyboard.press('Escape'); await sleep(200);
        check('desktop find: Esc closes the bar', !(await findState()).open);

        const searchProbe = await page.evaluate(async () => {
            const base = '/api/local/00000000-0000-0000-0000-000000000000/search';
            return {
                unknown: await fetch(base + '?q=fox').then(r => r.status),
                empty: await fetch(base + '?q=').then(r => r.status),
                tooLong: await fetch(base + '?q=' + 'x'.repeat(201)).then(r => r.status),
                badPage: await fetch(base + '?q=fox&from=0').then(r => r.status)
            };
        });
        check('desktop find: unknown token -> 404, bad input -> 400', searchProbe.unknown === 404 && searchProbe.empty === 400 &&
            searchProbe.tooLong === 400 && searchProbe.badPage === 400, searchProbe);

        // ----- Continuous scrolling and full screen (pages drawn by the host) -----
        const view = () => page.evaluate(() => ({
            slots: [...document.querySelectorAll('.page-slot')].map(s => Number(s.dataset.page)),
            drawn: document.querySelectorAll('.page-slot canvas').length,
            page: Number(document.querySelector('.page-input').value),
            fullScreen: document.querySelector('.app').classList.contains('is-fullscreen'),
            stackHeight: parseFloat(document.querySelector('.page-stack').style.height || '0')
        }));
        await open('large-150.pdf'); await click('Actual size');
        await page.click('#ribbon-tab-navigation'); await click('Continuous'); await sleep(1500); let vw = await view();
        check('desktop view: continuous scrolling draws the next pages (PDFium)', vw.slots[0] === 1 && vw.drawn >= 2 && vw.page === 1, vw);
        await click('Last page'); await sleep(1500); vw = await view();
        check('desktop view: Last page jumps to page 150; only pages near it are laid out', vw.page === 150 && vw.slots.includes(150) &&
            vw.drawn >= 1 && vw.stackHeight < 101 * 900, vw);
        await page.evaluate(() => { document.querySelector('.viewer-scroll').scrollTop -= 3000; }); await sleep(1500); vw = await view();
        check('desktop view: scrolling up makes an earlier page current', vw.page < 150 && vw.page > 140, vw);
        await click('Full screen'); await sleep(200); vw = await view();
        check('desktop full screen: the window is asked to go full screen', vw.fullScreen && (await state()).sent.includes('full-screen'), vw);
        await page.keyboard.press('Escape'); await sleep(200);
        check('desktop full screen: Esc leaves it', !(await view()).fullScreen);
        await click('Single page'); await sleep(300);
        check('desktop view: back to single page', (await view()).slots.length === 0);

        // ----- Search by drawing / beam / column number and document properties (on the host) -----
        const results = () => page.evaluate(() => ({
            count: (document.querySelector('.find-count') || {}).textContent || '',
            groups: [...document.querySelectorAll('.find-results li')].map(li => li.textContent.replace(/\s+/g, ' ').trim())
        }));
        const searchDone = async () => {
            await sleep(450);
            await page.waitForFunction(() => !/Searching|…/.test((document.querySelector('.find-count') || {}).textContent || ''), { timeout: 20000 });
            await sleep(200);
        };
        await open('drawing-set.pdf');
        await page.click('#ribbon-tab-navigation'); await page.click('button[aria-label="Find drawing number"]'); await searchDone();
        let sr = await results();
        check('desktop search: drawing numbers of every page (PDFium text, pattern on the host)',
            sr.groups.join('|') === 'Page 1 S-101 S-201|Page 2 S-102|Page 3 S-103', sr);
        await page.click('button[aria-label="Find beam"]'); await searchDone(); sr = await results();
        check('desktop search: every beam mark', sr.groups.join('|') === 'Page 1 B1 B12 FB3|Page 2 B12 ×2 GB-4', sr);
        await page.type('#find-input', '12'); await searchDone(); sr = await results();
        check('desktop search: beam 12', sr.groups.join('|') === 'Page 1 B12|Page 2 B12 ×2', sr);
        await page.click('button[aria-label="Find column"]'); await searchDone(); sr = await results();
        check('desktop search: every column mark', sr.groups.join('|') === 'Page 1 C1 C-2|Page 2 C1|Page 3 SC3', sr);
        const badPattern = await page.evaluate(async () => {
            const res = await fetch('/api/local/00000000-0000-0000-0000-000000000000/search?pattern=(');
            return res.status;
        });
        check('desktop search: an invalid pattern is refused', badPattern === 400, badPattern);
        await page.keyboard.press('Escape'); await sleep(100);
        await page.keyboard.down('Control'); await page.keyboard.press('KeyD'); await page.keyboard.up('Control');
        await page.waitForSelector('.properties-list', { timeout: 10000 }); await sleep(200);
        const props = await page.evaluate(() => {
            const rows = {};
            document.querySelectorAll('.properties-list > div').forEach(d => { rows[d.querySelector('dt').textContent.trim()] = d.querySelector('dd').textContent.trim(); });
            return rows;
        });
        check('desktop properties: metadata and PDF version from the host', props.Title === 'Structural drawings' && props.Author === 'Test Engineer' &&
            props['PDF version'] === '1.7' && props.Pages === '3', props);
        await page.keyboard.press('Escape'); await sleep(100);
        check('desktop page size: shown in the status bar', (await page.$eval('.page-size', e => e.textContent.trim())) === 'A3 · 420 × 297 mm');

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
        fs.rmSync(RECENT_FILE, { force: true });
    }
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(exitCode || (failed ? 1 : 0));
})();

/**
 * Generates the test PDFs used by e2e.test.js into tests/fixtures/.
 * Most files are written directly (no dependencies). Optional extras:
 *   - password-protected PDF: needs Ghostscript (`gs`)
 *   - real-world PDF: downloaded from the pdf.js test corpus (needs internet)
 * Missing extras are skipped and their tests are reported as SKIP.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

// ----- Minimal PDF writer -----
function buildPdf(pages, extra = {}) {
    const objects = [];          // index + 1 = object number
    const add = body => { objects.push(body); return objects.length; };

    const catalog = add(null);   // filled in later
    const pagesObj = add(null);
    const font = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
    const fontBold = add(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'));

    const pageRefs = [];
    const annotRefs = [];
    for (const p of pages) {
        let content = '';
        const xobjects = [];
        if (p.image) {
            const img = add(stream(
                `/Type /XObject /Subtype /Image /Width ${p.image.width} /Height ${p.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
                p.image.data));
            xobjects.push(`/Im1 ${img} 0 R`);
            content += `q ${p.width} 0 0 ${p.height} 0 0 cm /Im1 Do Q\n`;
        }
        if (p.title) {
            content += `BT /F2 26 Tf 50 ${p.height - 70} Td (${p.title}) Tj ET\n`;
        }
        for (let i = 0; i < (p.lines || 0); i++) {
            if (p.skipLines && p.skipLines.includes(i)) continue;
            content += `BT /F1 12 Tf 50 ${p.height - 120 - i * 20} Td (Line ${i} - The quick brown fox jumps over the lazy dog. Sample text for highlighting.) Tj ET\n`;
        }
        if (p.drawing) {
            content += p.drawing + '\n';
        }
        const contents = add(stream('', Buffer.from(content)));
        const annots = [];
        if (p.textField) {
            const ap = add(stream('/Type /XObject /Subtype /Form /BBox [0 0 250 24]',
                Buffer.from('0.9 0.95 1 rg 0 0 250 24 re f 0 0 0.6 RG 0 0 250 24 re S BT /F1 12 Tf 4 7 Td (Form field value) Tj ET')));
            const field = add(Buffer.from(
                `<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Form field value) /Rect [50 ${p.height - 300} 300 ${p.height - 276}] ` +
                `/F 4 /DA (/F1 12 Tf 0 g) /AP << /N ${ap} 0 R >> /P ${objects.length + 2} 0 R >>`));
            annots.push(field);
            annotRefs.push(field);
        }
        const page = add(Buffer.from(
            `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.width} ${p.height}]` +
            (p.rotate ? ` /Rotate ${p.rotate}` : '') +
            ` /Resources << /Font << /F1 ${font} 0 R /F2 ${fontBold} 0 R >>` +
            (xobjects.length ? ` /XObject << ${xobjects.join(' ')} >>` : '') + ' >>' +
            ` /Contents ${contents} 0 R` + (annots.length ? ` /Annots [${annots.map(a => a + ' 0 R').join(' ')}]` : '') + ' >>'));
        pageRefs.push(page);
    }

    // Document information (title, author, …) when given.
    const info = extra.info ? add(Buffer.from('<< ' + Object.entries(extra.info).map(([k, v]) => `/${k} (${v})`).join(' ') + ' >>')) : 0;
    objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageRefs.map(r => r + ' 0 R').join(' ')}] /Count ${pageRefs.length} >>`);
    objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R` +
        (annotRefs.length ? ` /AcroForm << /Fields [${annotRefs.map(r => r + ' 0 R').join(' ')}] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 ${font} 0 R >> >> >>` : '') +
        (extra.catalog || '') + ' >>');

    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
        const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
        offsets.push(offset);
        offset += obj.length;
        chunks.push(obj);
    });
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ''} >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref));
    return Buffer.concat(chunks);
}

function stream(dict, data) {
    return Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
}

function gradientImage(width, height) {
    const data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            data[i] = (x * 255 / width) | 0;
            data[i + 1] = (y * 255 / height) | 0;
            data[i + 2] = ((x ^ y) & 0xff);
        }
    }
    return { width, height, data };
}

const textPage = (n, width = 595, height = 842, extra = {}) => ({ width, height, title: `Page ${n}`, lines: 30, ...extra });
const range = n => Array.from({ length: n }, (_, i) => i + 1);
const write = (name, data) => { fs.writeFileSync(path.join(OUT, name), data); console.log('  ' + name.padEnd(22) + (data.length / 1024).toFixed(0).padStart(7) + ' KB'); };

console.log('Writing fixtures to ' + OUT);
write('one-page.pdf', buildPdf([textPage(1)]));
// A later revision of one-page.pdf for Compare / Overlay: line 5 removed, a rectangle added.
write('one-page-rev-b.pdf', buildPdf([textPage(1, 595, 842, { skipLines: [5], drawing: '2 w 380 300 150 80 re S' })]));
// Revision C of it: line 8 removed, the rectangle made wider (changed), a line added at the bottom.
write('one-page-rev-c.pdf', buildPdf([textPage(1, 595, 842, { skipLines: [5, 8], drawing: '2 w 380 300 190 80 re S\n2 w 60 60 m 300 60 l S' })]));
const tenPages = buildPdf(range(10).map(n => textPage(n)));
write('ten-pages.pdf', tenPages);
write('large-150.pdf', buildPdf(range(150).map(n => textPage(n, 612, 792))));
write('landscape.pdf', buildPdf(range(3).map(n => textPage(n, 842, 595, { lines: 20 }))));
write('mixed-sizes.pdf', buildPdf([
    { width: 612, height: 792, title: 'Letter portrait', lines: 5 },
    { width: 842, height: 595, title: 'A4 landscape', lines: 5 },
    { width: 842, height: 1191, title: 'A3 portrait', lines: 5 },
    { width: 300, height: 200, title: 'Small card' },
    { width: 1400, height: 400, title: 'Wide banner', lines: 5 }
]));
// A4 portrait pages with /Rotate: shown as landscape (90) and upside down (180).
write('rotated.pdf', buildPdf([textPage(1, 595, 842, { rotate: 90 }), textPage(2, 595, 842, { rotate: 180 })]));
write('image-based.pdf', buildPdf(range(3).map(n => ({ width: 595, height: 842, title: `Scanned page ${n}`, image: gradientImage(600, 850) }))));
// A small structural drawing set: A3 landscape sheets with beam and column marks and a title block
// (drawing number bottom right; page 1 also refers to another drawing near the top).
const sheet = (n, marks, extra = '') => ({
    width: 1191, height: 842, title: `General arrangement ${n}`,
    drawing: marks.map(([text, x, y]) => `BT /F1 12 Tf ${x} ${y} Td (${text}) Tj ET`).join('\n') +
        `\nBT /F1 10 Tf 960 70 Td (DRG NO) Tj ET\nBT /F2 16 Tf 1020 68 Td (S-10${n}) Tj ET\n1 w 940 40 230 60 re S` + extra
});
write('drawing-set.pdf', buildPdf([
    sheet(1, [['SEE S-201', 60, 740], ['B1', 200, 500], ['B12', 400, 500], ['FB3', 600, 500], ['C1', 200, 300], ['C-2', 400, 300]]),
    sheet(2, [['B12', 200, 500], ['B12', 400, 450], ['GB-4', 600, 500], ['C1', 200, 300]]),
    sheet(3, [['SC3', 300, 300], ['Notes: all beams in M25 concrete', 60, 160]])
], { info: { Title: 'Structural drawings', Author: 'Test Engineer', Subject: 'Ground floor', Keywords: 'beams, columns',
             Creator: 'CAD Export', Producer: 'Fixture writer', CreationDate: "D:20240115093000+05'30'" } }));
write('form.pdf', buildPdf([textPage(1, 595, 842, { lines: 5, textField: true })]));
// ~45 MB valid PDF (uncompressed image), just under the 50 MB limit.
write('large-45mb.pdf', buildPdf([{ width: 595, height: 842, title: 'Large file', image: gradientImage(3870, 3870) }, textPage(2)]));

// Invalid / damaged files
write('corrupt.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 'garbage ')]));
write('truncated.pdf', tenPages.subarray(0, Math.floor(tenPages.length * 0.6)));
write('fake.pdf', Buffer.from('this is not a pdf\n'));
write('empty.pdf', Buffer.alloc(0));
write('notes.txt', Buffer.from('hello\n'));
write('too-large.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(55 * 1024 * 1024)]));

// Huge sparse PDFs for the desktop app (the gap in the middle takes no disk space).
// Skipped on Windows, where the gap would be written out in full.
function writeSparsePdf(name, sizeGB, classicIndex) {
    const file = path.join(OUT, name);
    const fd = fs.openSync(file, 'w');
    let pos = 0;
    const offsets = {};
    const put = text => { const b = Buffer.from(text, 'latin1'); fs.writeSync(fd, b, 0, b.length, pos); pos += b.length; };
    const obj = (n, body) => { offsets[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
    const content = label => { const c = `BT /F1 36 Tf 60 700 Td (${label}) Tj ET`; return `<< /Length ${c.length} >>\nstream\n${c}\nendstream`; };
    const pageObj = contents => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R >>`;
    const gap = Math.floor(sizeGB * 1024 ** 3);

    put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    obj(4, content('Page 1 - start of file'));
    obj(5, pageObj(4));
    offsets[6] = pos; put(`6 0 obj\n<< /Length ${gap} >>\nstream\n`); pos += gap; put('\nendstream\nendobj\n');
    obj(7, content(`Page 2 - ${sizeGB} GB into the file`));
    obj(8, pageObj(7));
    obj(2, '<< /Type /Pages /Kids [5 0 R 8 0 R] /Count 2 >>');

    if (classicIndex) {
        const xref = pos;
        put('xref\n0 9\n0000000000 65535 f \n');
        for (let n = 1; n <= 8; n++) put(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
        put(`trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    } else {
        offsets[9] = pos;
        const rows = Buffer.alloc(11 * 10);
        rows.writeUInt16BE(0xffff, 9);
        for (let n = 1; n <= 9; n++) { rows[n * 11] = 1; rows.writeBigUInt64BE(BigInt(offsets[n]), n * 11 + 1); }
        put(`9 0 obj\n<< /Type /XRef /Size 10 /W [1 8 2] /Root 1 0 R /Length ${rows.length} >>\nstream\n`);
        fs.writeSync(fd, rows, 0, rows.length, pos); pos += rows.length;
        put(`\nendstream\nendobj\nstartxref\n${offsets[9]}\n%%EOF\n`);
    }
    fs.closeSync(fd);
    console.log('  ' + name.padEnd(22) + `${sizeGB} GB (sparse)`.padStart(18));
}

if (process.platform === 'win32') {
    console.log('  huge-*.pdf             skipped on Windows (sparse files)');
} else {
    writeSparsePdf('huge-8gb-classic.pdf', 8, true);
    writeSparsePdf('huge-60gb-xrefstream.pdf', 60, false);
}

// Optional: password-protected (Ghostscript)
try {
    execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-sOwnerPassword=owner', '-sUserPassword=secret',
        '-o', path.join(OUT, 'password.pdf'), path.join(OUT, 'one-page.pdf')], { stdio: 'ignore' });
    console.log('  password.pdf           (Ghostscript)');
} catch {
    console.log('  password.pdf           skipped (Ghostscript not installed)');
}

// Optional: real-world PDF from the pdf.js test corpus
const realWorld = path.join(OUT, 'tracemonkey.pdf');
if (fs.existsSync(realWorld)) {
    console.log('  tracemonkey.pdf        (already downloaded)');
} else {
    https.get('https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/tracemonkey.pdf', res => {
        if (res.statusCode !== 200) { console.log('  tracemonkey.pdf        skipped (HTTP ' + res.statusCode + ')'); res.resume(); return; }
        res.pipe(fs.createWriteStream(realWorld)).on('finish', () => console.log('  tracemonkey.pdf        (downloaded)'));
    }).on('error', () => console.log('  tracemonkey.pdf        skipped (offline)'));
}

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
            content += `BT /F1 12 Tf 50 ${p.height - 120 - i * 20} Td (Line ${i} - The quick brown fox jumps over the lazy dog. Sample text for highlighting.) Tj ET\n`;
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
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
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

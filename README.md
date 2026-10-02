# PDF Viewer

A simple, lightweight web PDF viewer: **Open → View → Zoom → Fit → Highlight.**

- Backend: ASP.NET Core (.NET 10) — PDF upload, validation and file access
- Frontend: AngularJS 1.8 + pdf.js 3.11 (bundled in `frontend/lib`, no internet or npm needed)
- No database, no login

Two ways to use it:

| | Web app | Desktop app |
| --- | --- | --- |
| Runs in | your browser | its own window (Linux, Windows) |
| Opening a file | uploaded to the local server | read directly from disk, no copy |
| Page rendering | pdf.js in the browser | PDFium (Chrome's PDF engine) on the C# side |
| File size | up to 50 MB | very large files (see limits below) |

## Run the web app

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
cd backend
dotnet run
```

Open http://localhost:5000.

## Run the desktop app

```bash
cd desktop
dotnet run                      # or: dotnet run -- /path/to/file.pdf
```

Linux needs WebKitGTK 4.1 (`sudo apt install libwebkit2gtk-4.1-0`, already present on Ubuntu desktops).
Windows 10/11 already include the required WebView2 runtime.

Build a standalone app folder (includes .NET, no install needed on the target PC):

```bash
cd desktop
dotnet publish -c Release -r win-x64   --self-contained -o ../dist/PdfViewer-win-x64     # Windows: PdfViewer.exe
dotnet publish -c Release -r linux-x64 --self-contained -o ../dist/PdfViewer-linux-x64   # Linux: ./PdfViewer
```

Copy the whole folder to the target computer and run `PdfViewer.exe` / `PdfViewer`.

### Large file limits (desktop)

PDFium reads only the parts of a file it needs, so opening is fast regardless of size
(an 8 GB test PDF opens in about 1 second). The limits come from the PDF format and PDFium:

- **Up to 4 GB**: any valid PDF.
- **4 GB to ~9 GB**: PDFs saved with a classic page index (`xref` table) work. PDFs that use a
  compressed index (cross-reference stream) cannot be read above 4 GB; the app says so immediately
  instead of hanging.
- **Above ~9.3 GB**: not possible with PDFium; the classic index cannot address beyond 10 digits.
  (Adobe Acrobat's own documented maximum PDF size is 10 GB.)
- Damaged PDFs without a page index can only be repaired up to 512 MB (repair means scanning the whole file).

## Features

- Open a PDF (validated in the browser and on the server: `.pdf` only, non-empty, max 50 MB, real `%PDF-` header)
- Page navigation: Prev / Next, type a page number, or ← / → keys
- Zoom in / out (25%–300%), click the percentage to reset to 100%
- Fit Page and Fit Width (kept when changing pages or resizing the window)
- Highlight mode: drag over the page to add transparent highlights
  - Click a highlight to select it, then press **Remove**, the **×** button or **Delete**
  - **Clear Highlights** removes all highlights; **Esc** leaves highlight mode
  - Highlights are kept in memory in PDF coordinates, so they stay in place at any zoom/fit/window size.
    The original PDF is never modified.
- Light and dark mode: follows the system setting; the sun/moon button in the header switches it and the
  choice is remembered in the browser. The PDF page itself always stays white.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/pdf/upload` | Upload a PDF (multipart field `file`). Returns `{ id, fileName, size }` |
| GET | `/api/pdf/{id}` | Download an uploaded PDF (supports range requests) |

Uploads are stored under random GUID names in the system temp folder (`pdf-viewer-uploads`) and
deleted automatically after `PdfStorage:RetentionMinutes` (default 60); a background task checks
on startup and every 10 minutes. Size limit is
`PdfStorage:MaxFileSizeMB` in `backend/appsettings.json` (also update `maxFileSizeMB` in `frontend/app/app.js`).

## Structure

```text
backend/
  Controllers/PdfController.cs    upload + download endpoints
  Services/PdfService.cs          validation, filename sanitising, temp storage, cleanup
  Services/PdfCleanupService.cs   periodic deletion of expired uploads
  Models/PdfFileModel.cs          response model, options, validation exception
  Program.cs                      serves ../frontend, security headers, size limits, error handling
  appsettings.json
frontend/
  index.html
  app/app.js                      module + config (zoom steps, size limit)
  app/controllers/pdfViewerController.js   toolbar/status state and commands
  app/services/pdfService.js      validate, upload, load and render pages (pdf.js)
  app/services/highlightService.js  in-memory highlight store
  app/services/themeService.js    light / dark theme
  app/services/desktopService.js  bridge to the desktop host (inactive in a normal browser)
  app/directives/pdfViewerDirective.js  canvas layer + interaction layer + highlight overlay
  app/directives/fileInputDirective.js  file input change binding
  app/views/pdf-viewer.html       layout: toolbar, viewer, status bar
  css/pdf-viewer.css
  lib/                            angular, pdf.js, pdf.js worker
desktop/
  Program.cs                      starts the local server (127.0.0.1, random port) and the native window
  DesktopBridge.cs                messages between UI and host: native open dialog, open results
  LinuxEnvironment.cs             fixes snap environment leaks (e.g. VS Code snap terminal) for WebKit
  Controllers/LocalPdfController.cs  page sizes and rendered page images for the opened file
  Services/PdfiumService.cs       open with PDFium, render pages
  Services/PdfPreflight.cs        detects files PDFium cannot read before trying
  Services/PngEncoder.cs          small PNG writer for rendered pages
tests/
  make-fixtures.js                generates test PDFs into tests/fixtures/
  e2e.test.js                     web app browser tests (Chrome or Firefox, headless)
  desktop.test.js                 desktop app (PDFium mode) tests, starts the host itself
```

## Tests

End-to-end tests drive the real app in a headless browser (Chrome or Firefox must be installed; needs Node.js 18+).

```bash
cd backend && dotnet run            # terminal 1: start the app

cd tests                            # terminal 2
npm install
npm run fixtures                    # generate test PDFs (once)
npm test                            # Chrome
npm run test:firefox                # Firefox
npm run test:desktop                # desktop app's PDFium mode (no need to start anything)
```

Covered: invalid / empty / oversized / corrupt / truncated / password-protected files, 1, 10 and 150-page PDFs,
a 45 MB PDF, landscape, rotated and mixed page sizes, image-based and form PDFs, a real-world PDF
(pdf.js test corpus, downloaded by `npm run fixtures`), navigation, zoom limits, Fit Page / Fit Width,
highlight create / select / remove / clear and their positions after zoom, fit, page change and window resize,
render failure recovery, light / dark theme, tablet viewport with touch highlighting, and no console errors.
`password.pdf` needs Ghostscript and `tracemonkey.pdf` needs internet; those tests are skipped otherwise.
The desktop tests also open sparse 8 GB and 60 GB PDFs (generated on Linux/macOS only; they use a few KB of disk).

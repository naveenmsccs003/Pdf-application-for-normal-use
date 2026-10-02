# PDF Viewer

A simple, lightweight web PDF viewer: **Open → View → Zoom → Fit → Highlight.**

- Backend: ASP.NET Core (.NET 10) — PDF upload, validation and file access
- Frontend: AngularJS 1.8 + pdf.js 3.11 (bundled in `frontend/lib`, no internet or npm needed)
- No database, no login

## Run

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
cd backend
dotnet run
```

Open http://localhost:5000.

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
  app/directives/pdfViewerDirective.js  canvas layer + interaction layer + highlight overlay
  app/directives/fileInputDirective.js  file input change binding
  app/views/pdf-viewer.html       layout: toolbar, viewer, status bar
  css/pdf-viewer.css
  lib/                            angular, pdf.js, pdf.js worker
tests/
  make-fixtures.js                generates test PDFs into tests/fixtures/
  e2e.test.js                     browser tests (Chrome or Firefox, headless)
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
```

Covered: invalid / empty / oversized / corrupt / truncated / password-protected files, 1, 10 and 150-page PDFs,
a 45 MB PDF, landscape, rotated and mixed page sizes, image-based and form PDFs, a real-world PDF
(pdf.js test corpus, downloaded by `npm run fixtures`), navigation, zoom limits, Fit Page / Fit Width,
highlight create / select / remove / clear and their positions after zoom, fit, page change and window resize,
render failure recovery, tablet viewport with touch highlighting, and no console errors.
`password.pdf` needs Ghostscript and `tracemonkey.pdf` needs internet; those tests are skipped otherwise.

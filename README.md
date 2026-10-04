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

## Layout

A desktop-style PDF workspace (layout inspired by professional PDF markup tools such as Bluebeam Revu):

- **Title bar** with the open file name and the light/dark switch
- **Menu bar**: **File** (Open, Close PDF, Save copy with highlights, Recent files, Clear recent files),
  **Edit** (Find, Find next, Find previous) and **Zoom** (Zoom in / out, Fit to page, Fit to width, Actual size, Custom zoom). Keyboard: arrow keys move
  through and between menus, Esc closes them
- **Tool bar** (ribbon): category tabs, each showing its tools in captioned groups; panel switches on the right.
  Arrow keys, Home and End move between the tabs.
  - **File**: Open PDF, Save copy, Close; Merge, Split, Compress, Convert
  - **Zoom**: zoom out / level (click for a custom zoom) / zoom in; Fit page, Fit width, Actual size
  - **Navigation**: first / previous / page / next / last; Find
  - **Markup**: Pan, Highlight; shapes (rectangle, ellipse, cloud, line, arrow, freehand); text note, callout;
    colour; Remove, Clear all, Save copy
  - **Colour**: four quick colours, or **More colours** for any colour (16.7 million): a saturation/brightness
    square, hue slider and hex code box (`#f80` or `#ff8800`), 72 presets, and the last 10 custom colours
    (remembered in this browser / app). Saved copies keep the exact colour.
  - **Measure**: Distance, Horizontal, Vertical; Area, Perimeter; Calibrate and the page's scale (see below)
  - **Review**: Comment, Add note; Strikeout, Underline, Replace text; Edit, Delete (see below)
  - **Revision**: Compare, Differences / Overlay, previous / next change, Cloud changes; Revisions, Tag; Markup report (see below)
- **Thumbnails panel** (left): page previews; click to jump; badges show highlights per page.
  Only visible thumbnails are created and rendered, so 100,000-page documents stay fast.
- **Document tab** with the file name and a close button
- **Markups panel** (right): every highlight with page and time; click to jump to it, delete it,
  or save a copy of the PDF with all highlights
- **Status bar**: first / previous / page number / next / last, status text, zoom out / % / zoom in
  (type a percentage such as `135` into the zoom box for a custom zoom)
- On narrow windows and tablets the panels close and slide over the page when opened

## Measurement

On the **Measure** tab (web and desktop):

| Tool | How | Shows |
| --- | --- | --- |
| **Distance** | drag between two points (Shift: 45° steps) | straight-line length |
| **Horizontal** / **Vertical** | drag between two points | only the horizontal / vertical part, drawn as a dimension line |
| **Area** | click each corner; double-click, **Enter** or click the first corner to finish | area in m² (mm, cm, m) or ft² (in, ft) |
| **Perimeter** | click each corner of the boundary, finish the same way | length of the closed boundary |
| **Calibrate** | drag along a dimension you know (e.g. between two grid lines), enter its real length | sets the scale |

- **Backspace** removes the last corner, **Esc** cancels the unfinished area. Measurements use the colour chosen on the
  Markup tab and are listed (with their values) in the Markups panel.
- The **scale** button shows the current page's scale; click it to pick a ratio such as 1:100 and the unit (mm, cm, m,
  in, ft). A scale applies to all pages or to one page (drawing sets often mix scales). Until a scale is set (shown in
  red), values are paper sizes at 1:1. Changing the scale updates every measurement on those pages.
- Scales are kept for the open document only. **Save copy with markups** writes each measurement as a Stamp annotation
  with its lines, area fill and value, so it looks the same in other PDF viewers.

## Review

On the **Review** tab (web and desktop):

| Tool | How | Saved in the copy as |
| --- | --- | --- |
| **Comment** | click where it goes, type the comment; a note icon marks it, select it to read the text | Text annotation (sticky note) |
| **Add note** | click, type the explanation; shown in a box on the page (same as Text note) | Stamp with the box and text |
| **Strikeout** | drag over incorrect text: a line through the middle | StrikeOut annotation |
| **Underline** | drag over important text: a line along the bottom | Underline annotation |
| **Replace text** | drag over the text, type the correction: the text is struck out and the correction shown above it | Stamp; the comment text is "Replace with: …" |
| **Edit** | change the selected markup's text and colour (or double-click a markup) | |
| **Delete** | remove the selected markup (or press Delete) | |

- With the **Pan** tool, drag a selected markup to move it; dragging anywhere else still pans.
- Review marks use the colour chosen on the Markup tab. Strikeout and underline follow the box you drag, like Highlight;
  mark one line of text at a time.

## Revision

On the **Revision** tab (web and desktop):

- **Compare…**: open another revision of the PDF (usually the previous issue). Page N is compared with page N.
  - **Differences**: what this revision added in green, what it removed (only in the other revision) in red, changed
    areas boxed; unchanged content is faded. **↑ / ↓** go to the previous / next changed area, on later or earlier
    pages too. **Cloud changes** marks every changed area on the page with a revision cloud.
  - **Overlay**: both revisions drawn together: this one in blue, the other in red, unchanged content in grey.
  - **Off** shows the plain page; **×** stops comparing. Pages are compared at about 1800 px (a moment per page).
- **Revisions**: the document's revision list (label, date, description, by) and the current revision. New markups belong
  to the current revision (shown in the Markups panel and the report). The list is remembered for the file (name and
  size) in this browser / app.
- **Tag**: a revision triangle with the current revision's label (saved in the copy as a Stamp).
- **Markup report**: every markup with page, type, content (text or measured value), colour, revision and time, with
  counts by type and page; for all markups or one revision. **Save CSV** (opens in Excel) or **Save printable
  report** (an HTML page to print or save as PDF). Web: downloads; desktop: asks where to save.

## PDF tools

On the **File** tab of the toolbar, in the **PDF tools** group (web and desktop):

| Tool | What it does | Output (web) | Output (desktop) |
| --- | --- | --- | --- |
| **Merge** | Combines up to 20 PDFs in the order you choose (the open document is listed first) | `merged.pdf` download | file you choose |
| **Split** | One file per page, every N pages, or page ranges like `1-3, 5, 8-10` | ZIP download | new subfolder in a folder you choose |
| **Compress** | Ghostscript with three levels: smallest (72 dpi), balanced (150 dpi), high quality (300 dpi). Never returns a bigger file | PDF download | file you choose |
| **Convert** | Word (.docx) or Excel (.xlsx) **text only**, or PNG images (72/150/300 dpi) | download (PNG as ZIP) | file / subfolder you choose |

Notes:

- **Compress needs [Ghostscript](https://ghostscript.com/releases/)** installed on the computer that runs the
  backend or desktop app (`sudo apt install ghostscript`; on Windows the default install location is found
  automatically, or set `PDFVIEWER_GHOSTSCRIPT` to `gswin64c.exe`). Ghostscript is AGPL-licensed: fine for
  personal and internal use; check the licence before selling or distributing the app.
  Scanned and image-heavy PDFs shrink most; text-only PDFs shrink little.
- **Word/Excel conversion is text only.** Word gets one paragraph per line and a page break per page;
  Excel gets one sheet per page (one sheet with a Page column above 200 pages), and text separated by
  tabs or wide gaps goes into separate columns. Layout, images and table formatting are not kept, and
  scanned pages contain no text. Layout-preserving conversion would need a commercial library.
- Merge, split and PNG export use PDFium (BSD licence); Word/Excel files are written with the
  Open XML SDK (MIT licence).

## Features

- Open a PDF (validated in the browser and on the server: `.pdf` only, non-empty, max 50 MB, real `%PDF-` header)
- Page navigation: Prev / Next, type a page number, or ← / → keys
- **Pan** (hand tool, the default): drag the page with the mouse to move around a zoomed-in drawing.
  The middle mouse button pans in any tool, and holding **Space** pans while in Highlight mode.
  A click without moving still selects a highlight. On touch screens, scroll with your finger as usual.
- Zoom in / out (25%–300%), or set any percentage in that range with **Zoom > Custom zoom…** (a small dialog) or by
  typing it into the zoom box in the status bar (values outside are clamped)
- Shortcuts (Cmd on macOS): **Ctrl+O** open, **Ctrl+S** save a copy with highlights, **Ctrl+=** / **Ctrl+−**
  zoom, **Ctrl+0** actual size. Close has no shortcut because browsers reserve Ctrl+W.
- **Recent files** in the File menu and on the start screen:
  - Desktop: the last 10 file paths, reopened from disk, stored in `~/.config/PdfViewer/recent-files.json`
    (Windows: `%APPDATA%\PdfViewer`). Moved or deleted files are marked *Missing* and removed when clicked.
    The host only reopens paths that are on that list.
  - Web: a browser cannot reopen a file by its path and uploads expire after an hour, so the last 5 PDFs
    are kept in the browser's own storage (IndexedDB) and never leave the computer. Empty in private windows.
  - **Clear recent files** deletes the list (and, on the web, the stored copies).
- **Find** (**Ctrl+F** or Edit > Find): searches the whole document as you type and shows "3 of 12".
  **Enter** / **Shift+Enter** (also **F3** / **Shift+F3**, **Ctrl+G** / **Ctrl+Shift+G**) step through the matches,
  wrapping around; **Esc** closes the bar. Options: **Match case** and **Whole words**. Matches are marked on the page
  and follow zoom and rotation; spaces and line breaks count as one space, so a phrase is found across lines.
  The search starts at the current page and stops at 1,000 matches. Web: pdf.js text in the browser.
  Desktop: PDFium searches on the host in short steps, so very large files stay responsive.
  Scanned pages contain no text and find nothing.
- Fit Page and Fit Width (kept when changing pages or resizing the window)
- Highlight mode: drag over the page to add transparent highlights
  - Click a highlight to select it, then press **Remove**, the **×** button or **Delete**
  - **Clear Highlights** removes all highlights; **Esc** leaves highlight mode
  - Highlights are kept in memory in PDF coordinates, so they stay in place at any zoom/fit/window size.
    The original PDF is never modified.
  - **Save with highlights** (toolbar save icon, or the button under the Markups list) writes a *copy* of the
    PDF with the highlights as standard PDF Highlight annotations (yellow, printable, with appearance
    streams), so Adobe Reader, browsers and other PDF tools show them and can edit them.
    Web: downloads `<name>-highlighted.pdf`. Desktop: asks where to save; it refuses to overwrite the open file.
    Reopening a saved copy shows the highlights as part of the page (they are not loaded back into the
    Markups list for editing).
- Light and dark mode: follows the system setting; the sun/moon button in the header switches it and the
  choice is remembered in the browser. The PDF page itself always stays white.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/pdf/upload` | Upload a PDF (multipart field `file`). Returns `{ id, fileName, size }` |
| GET | `/api/pdf/{id}` | Download an uploaded PDF (supports range requests) |
| POST | `/api/tools/merge` | `items` (`id:{guid}` or `file:{n}`, in order) + `files` |
| POST | `/api/tools/split` | `id` or `file`, `mode` (`pages`/`chunks`/`ranges`), `pagesPerFile`, `ranges` |
| POST | `/api/tools/compress` | `id` or `file`, `level` (`small`/`medium`/`high`) |
| POST | `/api/tools/convert` | `id` or `file`, `format` (`docx`/`xlsx`/`png`), `dpi` |

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
  Controllers/ToolsController.cs  merge / split / compress / convert endpoints
  Models/PdfFileModel.cs          response model, options, validation exception
  Program.cs                      serves ../frontend, security headers, size limits, error handling
  appsettings.json
frontend/
  index.html
  app/app.js                      module + config (zoom steps, size limit)
  app/controllers/pdfViewerController.js   toolbar/status state and commands
  app/services/pdfService.js      validate, upload, load and render pages (pdf.js)
  app/services/highlightService.js  in-memory highlight store
  app/services/searchService.js   text search (pdf.js on the web, PDFium host on desktop)
  app/controllers/findController.js  find bar and its keyboard shortcuts
  app/services/themeService.js    light / dark theme
  app/services/desktopService.js  bridge to the desktop host (inactive in a normal browser)
  app/services/recentFilesService.js  web Recent Files (copies kept in IndexedDB)
  app/services/toolsService.js    tools: web downloads or desktop host messages
  app/controllers/toolsController.js  tools dialog
  app/directives/pdfViewerDirective.js  canvas layer + interaction layer + highlight overlay
  app/directives/thumbnailsDirective.js virtualized page thumbnails panel
  app/directives/fileInputDirective.js  file input change binding
  app/directives/menuBarDirective.js    File / Edit / Zoom menu bar (WAI-ARIA menubar keyboard handling)
  app/views/pdf-viewer.html       layout: title bar, toolbar, panels, document tab, status bar, icons
  css/pdf-viewer.css
  lib/                            angular, pdf.js, pdf.js worker
shared/PdfViewer.Tools/          PDF tools used by both apps
  PdfTools.cs                     merge, split, PNG export, text extraction (PDFium)
  OfficeExport.cs                 text-only Word and Excel files (Open XML SDK)
  Ghostscript.cs                  compression via Ghostscript
  PageRanges.cs                   "1-3, 5" parsing, chunks
  Pdfium.cs                       shared PDFium lock, open and save helpers
  PngEncoder.cs                   small PNG writer
desktop/
  Program.cs                      starts the local server (127.0.0.1, random port) and the native window
  DesktopBridge.cs                messages between UI and host: open, close, recent files, tools
  DesktopTools.cs                 tools on disk with native save / folder dialogs
  FileDialogs.cs                  native dialogs (and preset answers for tests)
  LinuxEnvironment.cs             fixes snap environment leaks (e.g. VS Code snap terminal) for WebKit
  Controllers/LocalPdfController.cs  page sizes and rendered page images for the opened file
  Controllers/LocalSearchController.cs  text search in the opened file, in steps
  Services/PdfiumService.cs       open with PDFium, render pages, find text
  Services/PdfPreflight.cs        detects files PDFium cannot read before trying
  Services/RecentFiles.cs         recent file paths (JSON in the user's app data folder)
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
menu bar, shortcuts, custom zoom, pan (drag, Space, middle button), find (as you type, next / previous, match case, whole words, rotated pages,
1,000-match limit; web and desktop), recent files (web and desktop, including moved files and Clear),
render failure recovery, light / dark theme, tablet viewport with touch highlighting, and no console errors.
`password.pdf` needs Ghostscript and `tracemonkey.pdf` needs internet; those tests are skipped otherwise.
The desktop tests also open sparse 8 GB and 60 GB PDFs (generated on Linux/macOS only; they use a few KB of disk).

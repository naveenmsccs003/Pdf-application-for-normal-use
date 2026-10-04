using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using PDFiumCore;
using X = DocumentFormat.OpenXml.Spreadsheet;

namespace PdfViewer.Tools;

/// <summary>A report column: its heading, its share of the width (PDF) and whether it holds numbers.</summary>
public sealed record ReportColumn(string Label, double Width = 1, bool Number = false);

/// <summary>Counts shown above the table, e.g. markups by type.</summary>
public sealed record ReportCount(string Name, int Count);
public sealed record ReportSummary(string Label, IReadOnlyList<ReportCount> Items);

/// <summary>A table report (markup list, review report, change report) as the viewer builds it.</summary>
public sealed record ReportTable(string Title, string? Subtitle, IReadOnlyList<ReportColumn> Columns,
                                 IReadOnlyList<IReadOnlyList<string>> Rows, IReadOnlyList<ReportSummary>? Summaries);

/// <summary>Writes a <see cref="ReportTable"/> as an Excel workbook or a PDF.</summary>
public static class ReportWriter
{
    public const int MaxRows = 20_000;
    private const int MaxColumns = 12;
    private const int MaxCellLength = 2000;

    public static void Validate(ReportTable report)
    {
        if (report.Columns is null || report.Columns.Count is 0 or > MaxColumns)
            throw new ToolException("The report has no columns.");
        if (report.Rows is null || report.Rows.Count > MaxRows)
            throw new ToolException($"A report can have up to {MaxRows:N0} rows.");
        if (report.Rows.Any(r => r is null || r.Count != report.Columns.Count || r.Any(c => c is not null && c.Length > MaxCellLength)))
            throw new ToolException("The report rows do not match its columns.");
        if (report.Columns.Any(c => !double.IsFinite(c.Width) || c.Width <= 0 || c.Width > 100))
            throw new ToolException("The report has an invalid column.");
    }

    // ----- Excel -----

    /// <summary>One sheet with the title and the table (numbers as numbers), and a Summary sheet with the counts.</summary>
    public static void WriteXlsx(ReportTable report, Stream output)
    {
        Validate(report);
        using var document = SpreadsheetDocument.Create(output, SpreadsheetDocumentType.Workbook);
        var workbookPart = document.AddWorkbookPart();
        AddStyles(workbookPart);
        var sheets = new X.Sheets();
        workbookPart.Workbook = new X.Workbook(sheets);

        var rows = new List<X.Row>();
        uint index = 0;
        X.Row Row(params X.Cell[] cells) { var row = new X.Row { RowIndex = ++index }; row.Append(cells); rows.Add(row); return row; }
        Row(TextCell(report.Title, StyleTitle));
        if (!string.IsNullOrWhiteSpace(report.Subtitle)) Row(TextCell(report.Subtitle, 0));
        index++;   // a blank row
        Row(report.Columns.Select(c => TextCell(c.Label, StyleHeader)).ToArray());
        var headerRow = index;
        foreach (var r in report.Rows)
            Row(r.Select((value, i) => report.Columns[i].Number && double.TryParse(value, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var n) ? new X.Cell { CellValue = new X.CellValue(n) } : TextCell(value, 0)).ToArray());

        var widths = report.Columns.Select((c, i) => Math.Clamp(
            Math.Max(c.Label.Length, report.Rows.Select(r => (r[i] ?? "").Length).DefaultIfEmpty(0).Max()) + 2, 6, 60)).ToList();
        AddSheet(workbookPart, sheets, "Report", rows, widths, headerRow);

        if (report.Summaries is { Count: > 0 })
        {
            var summary = new List<X.Row>();
            uint s = 0;
            foreach (var block in report.Summaries)
            {
                var head = new X.Row { RowIndex = ++s };
                head.Append(TextCell(block.Label, StyleHeader), TextCell("Count", StyleHeader));
                summary.Add(head);
                foreach (var item in block.Items)
                {
                    var row = new X.Row { RowIndex = ++s };
                    row.Append(TextCell(item.Name, 0), new X.Cell { CellValue = new X.CellValue(item.Count) });
                    summary.Add(row);
                }
                s++;
            }
            AddSheet(workbookPart, sheets, "Summary", summary, [30, 10], 0);
        }
    }

    private const uint StyleTitle = 1, StyleHeader = 2;

    private static void AddStyles(WorkbookPart workbookPart)
    {
        var styles = workbookPart.AddNewPart<WorkbookStylesPart>();
        styles.Stylesheet = new X.Stylesheet(
            new X.Fonts(new X.Font(), new X.Font(new X.Bold(), new X.FontSize { Val = 14 }), new X.Font(new X.Bold())) { Count = 3 },
            new X.Fills(new X.Fill(new X.PatternFill { PatternType = X.PatternValues.None }),
                        new X.Fill(new X.PatternFill { PatternType = X.PatternValues.Gray125 }),
                        new X.Fill(new X.PatternFill(new X.ForegroundColor { Rgb = "FFEEF0F3" }) { PatternType = X.PatternValues.Solid })) { Count = 3 },
            new X.Borders(new X.Border()) { Count = 1 },
            new X.CellFormats(
                new X.CellFormat(),
                new X.CellFormat { FontId = 1, ApplyFont = true },
                new X.CellFormat { FontId = 2, FillId = 2, ApplyFont = true, ApplyFill = true }) { Count = 3 });
    }

    private static X.Cell TextCell(string? value, uint style) => new()
    {
        DataType = X.CellValues.InlineString,
        StyleIndex = style == 0 ? null : style,
        InlineString = new X.InlineString(new X.Text(CleanText(value ?? "")) { Space = SpaceProcessingModeValues.Preserve })
    };

    private static void AddSheet(WorkbookPart workbookPart, X.Sheets sheets, string name, List<X.Row> rows, IReadOnlyList<int> widths, uint frozenRow)
    {
        var sheetPart = workbookPart.AddNewPart<WorksheetPart>();
        var worksheet = new X.Worksheet();
        if (frozenRow > 0)
        {
            // Keep the header row in view while scrolling.
            worksheet.Append(new X.SheetViews(new X.SheetView(new X.Pane
            {
                VerticalSplit = frozenRow, TopLeftCell = $"A{frozenRow + 1}", ActivePane = X.PaneValues.BottomLeft, State = X.PaneStateValues.Frozen
            }) { WorkbookViewId = 0 }));
        }
        worksheet.Append(new X.Columns(widths.Select((w, i) => new X.Column { Min = (uint)i + 1, Max = (uint)i + 1, Width = w, CustomWidth = true })));
        var data = new X.SheetData();
        data.Append(rows);
        worksheet.Append(data);
        sheetPart.Worksheet = worksheet;
        sheets.Append(new X.Sheet { Id = workbookPart.GetIdOfPart(sheetPart), SheetId = (uint)sheets.ChildElements.Count + 1, Name = name });
    }

    private static string CleanText(string text) =>
        new(text.Where(c => c == '\t' || c == '\n' || (c >= 0x20 && c != 0xFFFE && c != 0xFFFF && !char.IsSurrogate(c))).ToArray());

    // ----- PDF -----

    private const double PageWidth = 842, PageHeight = 595, Margin = 36;   // A4 landscape
    private const double FontSize = 8.5, LineHeight = 11, CellPad = 4;

    /// <summary>A4 landscape: title, summary counts, then the table (wrapped cells, header repeated on each page).</summary>
    public static void WritePdf(ReportTable report, Stream output)
    {
        Validate(report);
        var columns = report.Columns;
        var tableWidth = PageWidth - 2 * Margin;
        var totalWeight = columns.Sum(c => c.Width);
        var widths = columns.Select(c => tableWidth * c.Width / totalWeight).ToArray();

        // Layout first (so the footer can say "of N"): which rows go on which page, and their lines.
        var header = columns.Select((c, i) => Wrap(c.Label, widths[i] - 2 * CellPad, true)).ToArray();
        var headerHeight = header.Max(l => l.Count) * LineHeight + 2 * CellPad;
        var rows = report.Rows.Select(r => r.Select((v, i) => Wrap(v ?? "", widths[i] - 2 * CellPad, false)).ToArray()).ToList();

        var summaryLines = (report.Summaries ?? [])
            .Select(s => s.Label + ": " + string.Join(" · ", s.Items.Select(i => $"{i.Name} {i.Count}")))
            .SelectMany(line => Wrap(line, tableWidth, false)).ToList();
        var firstTop = Margin + 26 + (string.IsNullOrWhiteSpace(report.Subtitle) ? 0 : 14) + summaryLines.Count * LineHeight + 10;
        var bottom = PageHeight - Margin - 14;

        var pages = new List<(int From, int To)>();
        var y = firstTop + headerHeight;
        var start = 0;
        for (var i = 0; i < rows.Count; i++)
        {
            var height = RowHeight(rows[i]);
            if (y + height > bottom && i > start)
            {
                pages.Add((start, i));
                start = i;
                y = Margin + headerHeight;
            }
            y += height;
        }
        pages.Add((start, rows.Count));

        Pdfium.EnsureInitialized();
        lock (Pdfium.Lock)
        {
            var document = fpdf_edit.FPDF_CreateNewDocument();
            try
            {
                for (var p = 0; p < pages.Count; p++)
                {
                    var page = fpdf_edit.FPDFPageNew(document, p, PageWidth, PageHeight);
                    try
                    {
                        var top = Margin;
                        if (p == 0)
                        {
                            Text(document, page, report.Title, Margin, top + 14, 15, true, 0x1f2933);
                            top += 26;
                            if (!string.IsNullOrWhiteSpace(report.Subtitle))
                            {
                                Text(document, page, report.Subtitle, Margin, top + 8, 9, false, 0x616e7c);
                                top += 14;
                            }
                            foreach (var line in summaryLines)
                            {
                                Text(document, page, line, Margin, top + 8, FontSize, false, 0x1f2933);
                                top += LineHeight;
                            }
                            top += 10;
                        }

                        // Header row on every page.
                        Rect(page, Margin, top, tableWidth, headerHeight, 0xeef0f3, true);
                        DrawRow(document, page, header, widths, top, headerHeight, true, columns);
                        top += headerHeight;
                        for (var i = pages[p].From; i < pages[p].To; i++)
                        {
                            var height = RowHeight(rows[i]);
                            DrawRow(document, page, rows[i], widths, top, height, false, columns);
                            top += height;
                        }
                        if (rows.Count == 0)
                            Text(document, page, "Nothing to report.", Margin, top + 14, 9, false, 0x616e7c);

                        Text(document, page, $"Page {p + 1} of {pages.Count}", PageWidth - Margin - 60, PageHeight - Margin + 4, 8, false, 0x616e7c);
                        fpdf_edit.FPDFPageGenerateContent(page);
                    }
                    finally
                    {
                        fpdfview.FPDF_ClosePage(page);
                    }
                }
                Pdfium.Save(document, output);
            }
            finally
            {
                fpdfview.FPDF_CloseDocument(document);
            }
        }
    }

    private static double RowHeight(List<string>[] cells) => Math.Max(1, cells.Max(l => l.Count)) * LineHeight + 2 * CellPad;

    private static void DrawRow(FpdfDocumentT document, FpdfPageT page, List<string>[] cells, double[] widths, double top, double height,
                                bool bold, IReadOnlyList<ReportColumn> columns)
    {
        var x = Margin;
        for (var c = 0; c < cells.Length; c++)
        {
            Rect(page, x, top, widths[c], height, 0xd5d9e0, false);
            for (var l = 0; l < cells[c].Count; l++)
            {
                var line = cells[c][l];
                // Numbers line up on the right.
                var left = columns[c].Number && !bold ? x + widths[c] - CellPad - TextWidth(line, false) : x + CellPad;
                Text(document, page, line, left, top + CellPad + 8 + l * LineHeight, FontSize, bold, 0x1f2933);
            }
            x += widths[c];
        }
    }

    /// <summary>Text with its baseline at (x, y) from the top-left of the page.</summary>
    private static void Text(FpdfDocumentT document, FpdfPageT page, string text, double x, double y, double size, bool bold, int rgb)
    {
        if (text.Length == 0) return;
        var obj = fpdf_edit.FPDFPageObjNewTextObj(document, bold ? "Helvetica-Bold" : "Helvetica", (float)size)
                  ?? throw new ToolException("Could not write the report.");
        var utf16 = text.Select(c => (ushort)c).Append((ushort)0).ToArray();
        fpdf_edit.FPDFTextSetText(obj, ref utf16[0]);
        fpdf_edit.FPDFPageObjSetFillColor(obj, (uint)(rgb >> 16) & 0xff, (uint)(rgb >> 8) & 0xff, (uint)rgb & 0xff, 255);
        fpdf_edit.FPDFPageObjTransform(obj, 1, 0, 0, 1, x, PageHeight - y);
        fpdf_edit.FPDFPageInsertObject(page, obj);
    }

    /// <summary>A filled (header) or outlined (cell) rectangle, top-left origin.</summary>
    private static void Rect(FpdfPageT page, double x, double top, double width, double height, int rgb, bool fill)
    {
        var rect = fpdf_edit.FPDFPageObjCreateNewRect((float)x, (float)(PageHeight - top - height), (float)width, (float)height);
        uint r = (uint)(rgb >> 16) & 0xff, g = (uint)(rgb >> 8) & 0xff, b = (uint)rgb & 0xff;
        if (fill)
        {
            fpdf_edit.FPDFPageObjSetFillColor(rect, r, g, b, 255);
            fpdf_edit.FPDFPathSetDrawMode(rect, 1, 0);
        }
        else
        {
            fpdf_edit.FPDFPageObjSetStrokeColor(rect, r, g, b, 255);
            fpdf_edit.FPDFPageObjSetStrokeWidth(rect, 0.5f);
            fpdf_edit.FPDFPathSetDrawMode(rect, 0, 1);
        }
        fpdf_edit.FPDFPageInsertObject(page, rect);
    }

    // Helvetica character widths (1/1000 em) for ASCII 32-126, from the standard font metrics.
    private static readonly int[] HelveticaWidths =
    [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
        556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
        556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
    ];

    private static double TextWidth(string text, bool bold) =>
        text.Sum(c => c >= 32 && c <= 126 ? HelveticaWidths[c - 32] : 556) * FontSize / 1000 * (bold ? 1.08 : 1);

    /// <summary>Breaks text into lines that fit the width (at spaces where possible; line breaks kept).</summary>
    private static List<string> Wrap(string text, double width, bool bold)
    {
        var lines = new List<string>();
        foreach (var paragraph in text.Replace("\r", "").Split('\n'))
        {
            var line = "";
            foreach (var word in paragraph.Split(' '))
            {
                var candidate = line.Length == 0 ? word : line + " " + word;
                if (TextWidth(candidate, bold) <= width) { line = candidate; continue; }
                if (line.Length > 0) lines.Add(line);
                // A word longer than the column is cut.
                line = word;
                while (TextWidth(line, bold) > width && line.Length > 1)
                {
                    var fit = line.Length - 1;
                    while (fit > 1 && TextWidth(line[..fit], bold) > width) fit--;
                    lines.Add(line[..fit]);
                    line = line[fit..];
                }
            }
            lines.Add(line);
        }
        return lines;
    }
}

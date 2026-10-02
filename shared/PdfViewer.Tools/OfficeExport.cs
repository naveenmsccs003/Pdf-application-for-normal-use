using System.Text;
using System.Text.RegularExpressions;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using W = DocumentFormat.OpenXml.Wordprocessing;
using X = DocumentFormat.OpenXml.Spreadsheet;

namespace PdfViewer.Tools;

/// <summary>
/// Text-only Word and Excel export. Layout, images and tables are not reproduced:
/// Word gets each page's lines as paragraphs; Excel gets each line as a row.
/// </summary>
public static partial class OfficeExport
{
    // Above this many pages, Excel gets one sheet with a Page column instead of a sheet per page.
    private const int MaxSheets = 200;
    private const int MaxCellLength = 32_767;

    public static void WriteDocx(IReadOnlyList<string[]> pages, Stream output)
    {
        using var document = WordprocessingDocument.Create(output, WordprocessingDocumentType.Document);
        var body = new W.Body();

        for (var p = 0; p < pages.Count; p++)
        {
            var lines = pages[p].Length > 0 ? pages[p] : [string.Empty];
            for (var i = 0; i < lines.Length; i++)
            {
                var run = new W.Run(new W.Text(Clean(lines[i])) { Space = SpaceProcessingModeValues.Preserve });
                // Page break before the first line of every page after the first.
                if (p > 0 && i == 0)
                    run.InsertAt(new W.Break { Type = W.BreakValues.Page }, 0);
                body.Append(new W.Paragraph(run));
            }
        }

        document.AddMainDocumentPart().Document = new W.Document(body);
    }

    public static void WriteXlsx(IReadOnlyList<string[]> pages, Stream output)
    {
        using var document = SpreadsheetDocument.Create(output, SpreadsheetDocumentType.Workbook);
        var workbookPart = document.AddWorkbookPart();
        var sheets = new X.Sheets();
        workbookPart.Workbook = new X.Workbook(sheets);

        if (pages.Count <= MaxSheets)
        {
            for (var p = 0; p < pages.Count; p++)
                AddSheet(workbookPart, sheets, $"Page {p + 1}", pages[p].Select(line => SplitColumns(line)));
        }
        else
        {
            var rows = pages.SelectMany((lines, p) => lines.Select(line => SplitColumns(line).Prepend((p + 1).ToString()).ToArray()));
            AddSheet(workbookPart, sheets, "Text", rows.Prepend(["Page", "Text"]));
        }
    }

    private static void AddSheet(WorkbookPart workbookPart, X.Sheets sheets, string name, IEnumerable<string[]> rows)
    {
        var sheetData = new X.SheetData();
        uint rowIndex = 0;
        foreach (var cells in rows)
        {
            var row = new X.Row { RowIndex = ++rowIndex };
            foreach (var value in cells)
            {
                row.Append(new X.Cell
                {
                    DataType = X.CellValues.InlineString,
                    InlineString = new X.InlineString(new X.Text(Truncate(Clean(value))) { Space = SpaceProcessingModeValues.Preserve })
                });
            }
            sheetData.Append(row);
        }

        var sheetPart = workbookPart.AddNewPart<WorksheetPart>();
        sheetPart.Worksheet = new X.Worksheet(sheetData);
        sheets.Append(new X.Sheet
        {
            Id = workbookPart.GetIdOfPart(sheetPart),
            SheetId = (uint)sheets.ChildElements.Count + 1,
            Name = name
        });
    }

    // Columns in PDF text usually show up as tabs or runs of spaces.
    private static string[] SplitColumns(string line) =>
        line.Length == 0 ? [] : ColumnGap().Split(line.Trim());

    private static string Truncate(string value) => value.Length > MaxCellLength ? value[..MaxCellLength] : value;

    /// <summary>Removes characters that are not allowed in XML (e.g. control characters from PDFs).</summary>
    private static string Clean(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var c in text)
        {
            if (c == '\t' || c >= 0x20 && c != 0xFFFE && c != 0xFFFF && !char.IsSurrogate(c))
                builder.Append(c);
            else if (char.IsSurrogate(c))
                builder.Append(c);   // surrogate pairs are validated below
        }
        // Drop unpaired surrogates.
        return InvalidSurrogate().Replace(builder.ToString(), string.Empty);
    }

    [GeneratedRegex(@"\t+| {2,}")]
    private static partial Regex ColumnGap();

    [GeneratedRegex(@"[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]")]
    private static partial Regex InvalidSurrogate();
}

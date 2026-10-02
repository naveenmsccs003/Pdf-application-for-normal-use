namespace PdfViewer.Tools;

/// <summary>A 1-based, inclusive page range.</summary>
public readonly record struct PageRange(int First, int Last)
{
    public int Count => Last - First + 1;

    /// <summary>PDFium page range syntax, e.g. "3-7" or "4".</summary>
    public string ToPdfiumRange() => First == Last ? First.ToString() : $"{First}-{Last}";

    public string ToFileSuffix() => First == Last ? $"p{First}" : $"p{First}-{Last}";
}

public static class PageRanges
{
    public static List<PageRange> EveryPage(int pageCount) =>
        Enumerable.Range(1, pageCount).Select(p => new PageRange(p, p)).ToList();

    public static List<PageRange> Chunks(int pageCount, int pagesPerFile)
    {
        if (pagesPerFile < 1)
            throw new ToolException("Pages per file must be at least 1.");
        var ranges = new List<PageRange>();
        for (var first = 1; first <= pageCount; first += pagesPerFile)
            ranges.Add(new PageRange(first, Math.Min(pageCount, first + pagesPerFile - 1)));
        return ranges;
    }

    /// <summary>Parses "1-3, 5, 8-10" into ranges, validated against the page count.</summary>
    public static List<PageRange> Parse(string? text, int pageCount)
    {
        var ranges = new List<PageRange>();
        foreach (var part in (text ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var bounds = part.Split('-', StringSplitOptions.TrimEntries);
            if (bounds.Length > 2
                || !int.TryParse(bounds[0], out var first)
                || !int.TryParse(bounds[^1], out var last))
                throw new ToolException($"\"{part}\" is not a valid page range. Use for example: 1-3, 5, 8-10");
            if (first < 1 || last > pageCount || first > last)
                throw new ToolException($"Page range \"{part}\" is outside pages 1 to {pageCount}.");
            ranges.Add(new PageRange(first, last));
        }

        if (ranges.Count == 0)
            throw new ToolException("Enter at least one page range, for example: 1-3, 5");
        return ranges;
    }
}

using PdfViewer.Tools;

namespace PdfViewer.Api.Models;

/// <summary>
/// Markups to write into a copy of an uploaded PDF (coordinates as the viewer stores them); flattened, and only
/// some pages, when asked.
/// </summary>
public record SaveHighlightsRequest(Guid Id, string? Name, List<Markup>? Highlights, bool Flatten = false, List<int>? Pages = null);

/// <summary>A report to write as "pdf" or "xlsx".</summary>
public record ReportRequest(string? Format, string? Name, ReportTable? Report);

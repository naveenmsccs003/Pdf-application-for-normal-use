using PdfViewer.Tools;

namespace PdfViewer.Api.Models;

/// <summary>Markups to write into a copy of an uploaded PDF (coordinates as the viewer stores them).</summary>
public record SaveHighlightsRequest(Guid Id, string? Name, List<Markup>? Highlights);

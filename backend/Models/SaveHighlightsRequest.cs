namespace PdfViewer.Api.Models;

/// <summary>Highlights to write into a copy of an uploaded PDF (coordinates as the viewer stores them).</summary>
public record SaveHighlightsRequest(Guid Id, string? Name, List<HighlightModel>? Highlights);

public record HighlightModel(int PageNumber, double X, double Y, double Width, double Height);

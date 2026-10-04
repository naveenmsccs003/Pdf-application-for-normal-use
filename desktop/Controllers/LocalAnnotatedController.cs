using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PdfViewer.Desktop.Services;
using PdfViewer.Tools;

namespace PdfViewer.Desktop.Controllers;

/// <summary>
/// The open document with its markups (and flattened / only some pages when asked) as PDF bytes, for printing:
/// the viewer draws its pages and prints them. Nothing is written next to the user's file.
/// </summary>
[ApiController]
[Route("api/local/{token:guid}/annotated")]
public class LocalAnnotatedController(PdfiumService pdfium) : ControllerBase
{
    [HttpPost]
    [RequestSizeLimit(20 * 1024 * 1024)]
    public async Task<IActionResult> Annotated(Guid token, [FromBody] JsonElement body)
    {
        var path = pdfium.PathFor(token);
        if (path is null)
            return NotFound();
        try
        {
            var markups = body.TryGetProperty("highlights", out var h)
                ? h.Deserialize<List<Markup?>>(JsonSerializerOptions.Web)?.OfType<Markup>().ToList() ?? []
                : [];
            var options = DesktopTools.ReadAnnotatedOptions(body);
            var output = new MemoryStream();
            await Task.Run(() => PdfTools.SaveAnnotated(path, markups, options, output));
            output.Position = 0;
            return File(output, "application/pdf");
        }
        catch (ToolException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return BadRequest(new { error = "Invalid request." });
        }
    }
}

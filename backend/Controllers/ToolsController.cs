using System.IO.Compression;
using Microsoft.AspNetCore.Mvc;
using PdfViewer.Api.Models;
using PdfViewer.Api.Services;
using PdfViewer.Tools;

namespace PdfViewer.Api.Controllers;

/// <summary>
/// Merge, split, compress, convert, protect, remove a password and sign. Each request uses either the open document
/// (<c>id</c> of an earlier upload) or a newly uploaded <c>file</c>; uploads go through the same
/// validation as the viewer. Results are streamed from temp files that delete themselves.
/// </summary>
[ApiController]
[Route("api/tools")]
public class ToolsController(PdfService pdfService, ILogger<ToolsController> logger) : ControllerBase
{
    private const int MaxMergeFiles = 20;
    private const long MaxMergeRequestBytes = 1100L * 1024 * 1024;   // 20 files x 50 MB plus overhead

    /// <summary>
    /// Merges PDFs in the order given by <paramref name="items"/>: "id:{guid}" for an earlier upload,
    /// "file:{index}" for the n-th file in <paramref name="files"/>.
    /// </summary>
    [HttpPost("merge")]
    [RequestSizeLimit(MaxMergeRequestBytes)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxMergeRequestBytes)]
    public Task<IActionResult> Merge([FromForm] List<string> items, [FromForm] List<IFormFile> files, CancellationToken ct) =>
        Run(async () =>
        {
            if (items.Count < 2)
                throw new ToolException("Choose at least two PDF files to merge.");
            if (items.Count > MaxMergeFiles)
                throw new ToolException($"You can merge up to {MaxMergeFiles} files at a time.");

            var inputs = new List<(string Path, string Name)>();
            foreach (var item in items)
            {
                if (item.StartsWith("id:", StringComparison.Ordinal) && Guid.TryParse(item[3..], out var id))
                    inputs.Add((StoredPath(id), "Current document"));
                else if (item.StartsWith("file:", StringComparison.Ordinal) && int.TryParse(item[5..], out var index) && index >= 0 && index < files.Count)
                {
                    var saved = await pdfService.SaveAsync(files[index], ct);
                    inputs.Add((StoredPath(saved.Id), saved.FileName));
                }
                else
                    throw new ToolException("Invalid merge request.");
            }

            var output = CreateTempFile();
            var pages = await Task.Run(() => PdfTools.Merge(inputs, output), ct);
            Response.Headers["X-Page-Count"] = pages.ToString();
            return Download(output, "application/pdf", "merged.pdf");
        });

    /// <param name="mode">"pages" (one file per page), "chunks" (every <paramref name="pagesPerFile"/> pages) or "ranges".</param>
    [HttpPost("split")]
    public Task<IActionResult> Split([FromForm] Guid? id, IFormFile? file, [FromForm] string? name,
        [FromForm] string mode, [FromForm] int pagesPerFile, [FromForm] string? ranges, CancellationToken ct) =>
        Run(async () =>
        {
            var (path, baseName) = await ResolveInputAsync(id, file, name, ct);
            var pageCount = await Task.Run(() => PdfTools.GetPageCount(path), ct);
            var parts = mode switch
            {
                "pages" => PageRanges.EveryPage(pageCount),
                "chunks" => PageRanges.Chunks(pageCount, pagesPerFile),
                "ranges" => PageRanges.Parse(ranges, pageCount),
                _ => throw new ToolException("Choose how to split the PDF.")
            };

            var output = CreateTempFile();
            await Task.Run(() =>
            {
                using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
                PdfTools.Split(path, parts, baseName, entryName => zip.CreateEntry(entryName, CompressionLevel.Fastest).Open());
            }, ct);
            Response.Headers["X-File-Count"] = parts.Count.ToString();
            return Download(output, "application/zip", $"{baseName}-split.zip");
        });

    /// <param name="level">"small", "medium" or "high".</param>
    [HttpPost("compress")]
    public Task<IActionResult> Compress([FromForm] Guid? id, IFormFile? file, [FromForm] string? name,
        [FromForm] string level, CancellationToken ct) =>
        Run(async () =>
        {
            var quality = level switch
            {
                "small" => CompressionQuality.Small,
                "high" => CompressionQuality.High,
                "medium" => CompressionQuality.Medium,
                _ => throw new ToolException("Choose a compression level.")
            };
            var (path, baseName) = await ResolveInputAsync(id, file, name, ct);

            var tempPath = Path.Combine(Path.GetTempPath(), $"pdf-viewer-gs-{Guid.NewGuid():N}.pdf");
            try
            {
                await Ghostscript.CompressAsync(path, tempPath, quality, ct);
                var originalSize = new FileInfo(path).Length;
                var compressedSize = new FileInfo(tempPath).Length;

                // Never hand back a bigger file: keep the original if compression did not help.
                var output = CreateTempFile();
                await using (var source = System.IO.File.OpenRead(compressedSize < originalSize ? tempPath : path))
                    await source.CopyToAsync(output, ct);

                Response.Headers["X-Original-Size"] = originalSize.ToString();
                Response.Headers["X-Result-Size"] = Math.Min(originalSize, compressedSize).ToString();
                return Download(output, "application/pdf", $"{baseName}-compressed.pdf");
            }
            finally
            {
                System.IO.File.Delete(tempPath);
            }
        });

    /// <param name="format">"docx", "xlsx" (text only) or "png".</param>
    [HttpPost("convert")]
    public Task<IActionResult> Convert([FromForm] Guid? id, IFormFile? file, [FromForm] string? name,
        [FromForm] string format, [FromForm] int dpi, CancellationToken ct) =>
        Run(async () =>
        {
            var (path, baseName) = await ResolveInputAsync(id, file, name, ct);
            var output = CreateTempFile();

            switch (format)
            {
                case "docx":
                    await Task.Run(() => OfficeExport.WriteDocx(PdfTools.ExtractText(path, ct), output), ct);
                    return Download(output, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", $"{baseName}.docx");
                case "xlsx":
                    await Task.Run(() => OfficeExport.WriteXlsx(PdfTools.ExtractText(path, ct), output), ct);
                    return Download(output, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", $"{baseName}.xlsx");
                case "png":
                    await Task.Run(() =>
                    {
                        using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
                        // PNGs are already compressed.
                        PdfTools.ExportPng(path, dpi, baseName, entryName => zip.CreateEntry(entryName, CompressionLevel.NoCompression).Open(), ct);
                    }, ct);
                    return Download(output, "application/zip", $"{baseName}-png.zip");
                default:
                    throw new ToolException("Choose an output format.");
            }
        });

    /// <summary>A copy protected with AES-256: an open password and / or a permissions (owner) password.</summary>
    /// <param name="password">The open document's own password, if it has one.</param>
    [HttpPost("protect")]
    public Task<IActionResult> Protect([FromForm] Guid? id, IFormFile? file, [FromForm] string? name, [FromForm] string? password,
        [FromForm] string? userPassword, [FromForm] string? ownerPassword, [FromForm] bool allowPrint, [FromForm] bool allowCopy,
        [FromForm] bool allowModify, [FromForm] bool allowAnnotate, [FromForm] bool allowForms, [FromForm] bool allowAssemble,
        CancellationToken ct) =>
        Run(async () =>
        {
            var (path, baseName) = await ResolveInputAsync(id, file, name, ct);
            var output = CreateTempFile();
            var options = new ProtectOptions(userPassword, ownerPassword, allowPrint, allowCopy, allowModify, allowAnnotate, allowForms, allowAssemble);
            await Task.Run(() => PdfSecurity.Protect(path, password, output, options), ct);
            return Download(output, "application/pdf", $"{baseName}-protected.pdf");
        });

    /// <summary>A copy without the password and permissions (needs the owner password, if there is one).</summary>
    [HttpPost("unprotect")]
    public Task<IActionResult> Unprotect([FromForm] Guid? id, IFormFile? file, [FromForm] string? name, [FromForm] string? password,
        CancellationToken ct) =>
        Run(async () =>
        {
            var (path, baseName) = await ResolveInputAsync(id, file, name, ct);
            var output = CreateTempFile();
            await Task.Run(() => PdfSecurity.RemovePassword(path, password, output), ct);
            return Download(output, "application/pdf", $"{baseName}-unlocked.pdf");
        });

    /// <summary>A signed copy, with the certificate (.pfx / .p12) sent with the request; the certificate is not stored.</summary>
    /// <param name="page">The page showing the signature; 0 for an invisible signature.</param>
    /// <param name="corner">"bottom-right", "bottom-left", "top-right" or "top-left".</param>
    [HttpPost("sign")]
    public Task<IActionResult> Sign([FromForm] Guid? id, IFormFile? file, [FromForm] string? name, IFormFile? certificate,
        [FromForm] string? certificatePassword, [FromForm] string? reason, [FromForm] string? location, [FromForm] string? contact,
        [FromForm] int page, [FromForm] string? corner, CancellationToken ct) =>
        Run(async () =>
        {
            if (certificate is null || certificate.Length == 0 || certificate.Length > PdfSecurity.MaxCertificateBytes)
                throw new ToolException("Choose a certificate file (.pfx or .p12).");
            var (path, baseName) = await ResolveInputAsync(id, file, name, ct);
            using var buffer = new MemoryStream();
            await certificate.CopyToAsync(buffer, ct);
            var output = CreateTempFile();
            var result = await PdfSecurity.SignAsync(path, output, buffer.ToArray(), certificatePassword,
                new SignOptions(reason, location, contact, page, corner));
            Response.Headers["X-Signer"] = Uri.EscapeDataString(result.Signer);
            Response.Headers["X-Signature-Visible"] = result.Visible ? "true" : "false";
            return Download(output, "application/pdf", $"{baseName}-signed.pdf");
        });

    /// <summary>Returns a copy of the open document with its markups as PDF annotations.</summary>
    [HttpPost("save-highlights")]
    public Task<IActionResult> SaveHighlights([FromBody] SaveHighlightsRequest request, CancellationToken ct) =>
        Run(async () =>
        {
            var path = StoredPath(request.Id);
            var highlights = request.Highlights ?? [];

            var output = CreateTempFile();
            var options = new AnnotatedOptions(request.Flatten, request.Pages);
            var count = await Task.Run(() => PdfTools.SaveAnnotated(path, highlights, options, output), ct);
            Response.Headers["X-Highlight-Count"] = count.ToString();
            var suffix = request.Flatten ? "-flattened" : "-highlighted";
            return Download(output, "application/pdf", $"{BaseName(request.Name)}{suffix}.pdf");
        });

    /// <summary>A markup, review or change report built by the viewer, as a PDF or an Excel workbook.</summary>
    [HttpPost("report")]
    public Task<IActionResult> Report([FromBody] ReportRequest request, CancellationToken ct) =>
        Run(async () =>
        {
            var report = request.Report ?? throw new ToolException("There is no report to save.");
            var output = CreateTempFile();
            switch (request.Format)
            {
                case "pdf":
                    await Task.Run(() => ReportWriter.WritePdf(report, output), ct);
                    return Download(output, "application/pdf", $"{BaseName(request.Name)}.pdf");
                case "xlsx":
                    await Task.Run(() => ReportWriter.WriteXlsx(report, output), ct);
                    return Download(output, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", $"{BaseName(request.Name)}.xlsx");
                default:
                    throw new ToolException("Choose PDF or Excel.");
            }
        });

    private async Task<IActionResult> Run(Func<Task<IActionResult>> action)
    {
        try
        {
            return await action();
        }
        catch (Exception ex) when (ex is ToolException or PdfValidationException)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "PDF tool failed");
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "Something went wrong. Please try again." });
        }
    }

    private async Task<(string Path, string BaseName)> ResolveInputAsync(Guid? id, IFormFile? file, string? name, CancellationToken ct)
    {
        if (file is not null)
        {
            var saved = await pdfService.SaveAsync(file, ct);
            return (StoredPath(saved.Id), BaseName(saved.FileName));
        }
        if (id is { } existing)
            return (StoredPath(existing), BaseName(name));
        throw new ToolException("Please select a PDF file.");
    }

    private string StoredPath(Guid id) =>
        pdfService.GetStoredPath(id) ?? throw new ToolException("The document is no longer available. Please open it again.");

    private static string BaseName(string? fileName)
    {
        var name = Path.GetFileNameWithoutExtension(PdfService.SanitizeFileName(fileName));
        return string.IsNullOrWhiteSpace(name) ? "document" : name;
    }

    private static FileStream CreateTempFile() =>
        new(Path.Combine(Path.GetTempPath(), $"pdf-viewer-out-{Guid.NewGuid():N}"),
            FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.DeleteOnClose);

    private FileStreamResult Download(FileStream output, string contentType, string fileName)
    {
        output.Position = 0;
        return File(output, contentType, fileName);
    }
}

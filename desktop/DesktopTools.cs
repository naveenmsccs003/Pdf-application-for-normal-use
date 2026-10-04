using System.Text.Json;
using PdfViewer.Desktop.Models;
using PdfViewer.Desktop.Services;
using PdfViewer.Tools;

namespace PdfViewer.Desktop;

/// <summary>
/// Merge, split, compress and convert for the desktop app. Inputs and outputs are chosen with
/// native dialogs and processed straight on disk. The UI only ever sees opaque ids for picked files,
/// never paths, and can only use files the user picked or the document open in the viewer.
/// </summary>
public class DesktopTools(PdfiumService pdfium, ILogger<DesktopTools> logger)
{
    private static readonly (string, string[])[] PdfFilter = [("PDF files", ["*.pdf"])];
    private const int MaxReportLength = 20_000_000;
    private readonly Dictionary<string, string> _picked = new();

    /// <summary>Shows the open dialog (multi-select) and returns the picked files for the UI.</summary>
    public object PickPdfs(IFileDialogs dialogs)
    {
        var paths = dialogs.OpenFiles("Add PDF files", true, PdfFilter);
        var files = paths.Where(File.Exists).Select(path =>
        {
            var id = Guid.NewGuid().ToString("N");
            _picked[id] = path;
            return new { id, name = Path.GetFileName(path), size = new FileInfo(path).Length };
        }).ToList();
        return new { type = "picked-pdfs", files };
    }

    /// <summary>Asks where to save (on the UI thread), then runs the tool in the background.</summary>
    public async Task<object> RunAsync(IFileDialogs dialogs, JsonElement message)
    {
        try
        {
            var tool = message.GetProperty("tool").GetString();
            var options = message.TryGetProperty("options", out var o) ? o : default;
            var inputs = ResolveInputs(message.GetProperty("inputs"));

            switch (tool)
            {
                case "merge":
                {
                    var output = AskSaveFile(dialogs, "Save merged PDF", inputs[0].Path, ".pdf", inputs);
                    if (output is null) return Cancelled;
                    var pages = await WriteFileAsync(output, stream => PdfTools.Merge(inputs, stream));
                    return Done($"Merged {inputs.Count} files ({pages} pages) into {Path.GetFileName(output)}.");
                }
                case "split":
                {
                    var (path, name) = Single(inputs);
                    var folder = AskFolder(dialogs, "Choose a folder for the split files", path);
                    if (folder is null) return Cancelled;
                    var ranges = await Task.Run(() => SplitRanges(path, options));
                    var target = CreateUniqueFolder(folder, $"{BaseName(name)}-split");
                    await Task.Run(() => PdfTools.Split(path, ranges, BaseName(name), file => File.Create(Path.Combine(target, file))));
                    return Done($"Created {ranges.Count} PDF files in {target}.");
                }
                case "compress":
                {
                    var (path, name) = Single(inputs);
                    var output = AskSaveFile(dialogs, "Save compressed PDF", path, ".pdf", inputs, $"{BaseName(name)}-compressed");
                    if (output is null) return Cancelled;
                    return Done(await CompressAsync(path, output, options));
                }
                case "convert":
                {
                    var (path, name) = Single(inputs);
                    var format = options.GetProperty("format").GetString();
                    if (format == "png")
                    {
                        var folder = AskFolder(dialogs, "Choose a folder for the images", path);
                        if (folder is null) return Cancelled;
                        var dpi = options.TryGetProperty("dpi", out var d) ? d.GetInt32() : 150;
                        var target = CreateUniqueFolder(folder, $"{BaseName(name)}-images");
                        var count = 0;
                        await Task.Run(() => PdfTools.ExportPng(path, dpi, BaseName(name), file =>
                        {
                            count++;
                            return File.Create(Path.Combine(target, file));
                        }));
                        return Done($"Saved {count} PNG images in {target}.");
                    }
                    if (format is not ("docx" or "xlsx"))
                        throw new ToolException("Choose an output format.");

                    var extension = "." + format;
                    var output = AskSaveFile(dialogs, format == "docx" ? "Save Word document" : "Save Excel workbook", path, extension, inputs);
                    if (output is null) return Cancelled;
                    await WriteFileAsync(output, stream =>
                    {
                        var pages = PdfTools.ExtractText(path);
                        if (format == "docx") OfficeExport.WriteDocx(pages, stream);
                        else OfficeExport.WriteXlsx(pages, stream);
                        return 0;
                    });
                    return Done($"Saved {Path.GetFileName(output)} (text only).");
                }
                case "save-report":
                {
                    // A report built by the UI: CSV or a printable HTML page as text, or PDF / Excel written here.
                    var (path, name) = Single(inputs);
                    var requested = options.GetProperty("format").GetString();
                    if (requested is "pdf" or "xlsx")
                    {
                        var report = options.GetProperty("report").Deserialize<ReportTable>(JsonSerializerOptions.Web)
                                     ?? throw new ToolException("There is no report to save.");
                        ReportWriter.Validate(report);
                        var fileName = options.TryGetProperty("name", out var n) ? n.GetString() : null;
                        var target = AskSaveFile(dialogs, "Save report", path, "." + requested, inputs, fileName ?? $"{BaseName(name)}-report");
                        if (target is null) return Cancelled;
                        await WriteFileAsync(target, stream =>
                        {
                            if (requested == "pdf") ReportWriter.WritePdf(report, stream); else ReportWriter.WriteXlsx(report, stream);
                            return 0;
                        });
                        return Done($"Saved {Path.GetFileName(target)}.");
                    }
                    var format = requested == "html" ? "html" : "csv";
                    var content = options.GetProperty("content").GetString() ?? "";
                    if (content.Length > MaxReportLength)
                        throw new ToolException("The report is too large.");
                    var suggested = options.TryGetProperty("name", out var nm) ? nm.GetString() : null;
                    var output = AskSaveFile(dialogs, "Save report", path, "." + format, inputs, suggested ?? $"{BaseName(name)}-markups");
                    if (output is null) return Cancelled;
                    // CSV with a byte order mark, so Excel reads the text as UTF-8.
                    await WriteFileAsync(output, stream =>
                    {
                        using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(format == "csv"));
                        writer.Write(content);
                        return 0;
                    });
                    return Done($"Saved {Path.GetFileName(output)}.");
                }
                case "extract":
                {
                    // Selected pages into a new file; the open document stays as it is.
                    var (path, name) = Single(inputs);
                    var layout = ReadLayout(options);
                    var output = AskSaveFile(dialogs, "Save the extracted pages", path, ".pdf", inputs, $"{BaseName(name)}-pages");
                    if (output is null) return Cancelled;
                    var pages = await WriteFileAsync(output, stream => PageEditor.Rearrange(path, layout, [], stream));
                    return Done($"Saved {pages} page{(pages == 1 ? "" : "s")} as {Path.GetFileName(output)}.");
                }
                case "save-highlights":
                {
                    var (path, name) = Single(inputs);
                    var highlights = options.GetProperty("highlights").Deserialize<List<Markup?>>(JsonSerializerOptions.Web)
                        ?.OfType<Markup>().ToList() ?? [];
                    var annotated = ReadAnnotatedOptions(options);
                    if (highlights.Count == 0 && !annotated.Flatten && annotated.Pages is null)
                        throw new ToolException("There are no markups to save.");

                    // A copy: the open document is never overwritten (enforced in AskSaveFile).
                    var suffix = annotated.Flatten ? "-flattened" : "-highlighted";
                    var output = AskSaveFile(dialogs, annotated.Flatten ? "Save a flattened copy" : "Save a copy with markups", path, ".pdf",
                        inputs, $"{BaseName(name)}{suffix}");
                    if (output is null) return Cancelled;
                    var count = await WriteFileAsync(output, stream => PdfTools.SaveAnnotated(path, highlights, annotated, stream));
                    return Done($"Saved {Path.GetFileName(output)} with {count} markup{(count == 1 ? "" : "s")}" +
                                (annotated.Flatten ? " (flattened)." : "."));
                }
                default:
                    throw new ToolException("Unknown tool.");
            }
        }
        catch (ToolException ex)
        {
            return new { type = "tool-error", message = ex.Message };
        }
        catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException or FormatException)
        {
            logger.LogWarning(ex, "Malformed tool request");
            return new { type = "tool-error", message = "Invalid request." };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(ex, "Tool could not write output");
            return new { type = "tool-error", message = "Could not write the output. Check the folder permissions and free disk space." };
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Tool failed");
            return new { type = "tool-error", message = "Something went wrong. Please try again." };
        }
    }

    /// <summary>New document with blank pages, shown in the viewer as an unsaved working copy.</summary>
    public async Task<object> NewDocumentAsync(JsonElement message)
    {
        try
        {
            var count = message.GetProperty("count").GetInt32();
            var width = message.GetProperty("width").GetDouble();
            var height = message.GetProperty("height").GetDouble();
            var temp = PdfiumService.NewWorkingPath();
            await WriteFileAsync(temp, stream => { PageEditor.CreateBlank(count, width, height, stream); return 0; });
            var info = await Task.Run(() => pdfium.OpenWorkingCopy(temp, "Untitled.pdf", null));
            return new { type = "opened", info.Token, info.FileName, info.Size, info.PageCount, untitled = true };
        }
        catch (Exception ex)
        {
            return new { type = "open-error", message = ErrorMessage(ex, "Unable to create the PDF.") };
        }
    }

    /// <summary>
    /// Page edit: the open document rebuilt with the pages in <c>layout</c> (a list of <see cref="PageSpec"/>),
    /// with <c>inputs</c> (picked files) as sources 1..n. The result replaces the document in the viewer as a
    /// working copy; the user's file is not changed until Save.
    /// </summary>
    public async Task<object> EditPagesAsync(JsonElement message)
    {
        try
        {
            var current = pdfium.Current ?? throw new ToolException("Open a PDF first.");
            var savePath = pdfium.SavePath;
            var layout = ReadLayout(message);
            var others = message.TryGetProperty("inputs", out var i) && i.GetArrayLength() > 0 ? ResolveInputs(i) : [];
            var temp = PdfiumService.NewWorkingPath();
            await WriteFileAsync(temp, stream => PageEditor.Rearrange(current.Path, layout, others, stream));
            var info = await Task.Run(() => pdfium.OpenWorkingCopy(temp, current.Name, savePath));
            return new { type = "pages-edited", info.Token, info.FileName, info.Size, info.PageCount };
        }
        catch (Exception ex)
        {
            return new { type = "edit-error", message = ErrorMessage(ex, "Unable to change the pages.") };
        }
    }

    /// <summary>
    /// Save: writes the document (with its page edits) to its file. Save As, or Save of a new document, asks
    /// for the file first. Returns the saved path (null when cancelled) and the reply for the UI.
    /// </summary>
    public async Task<(string? Path, object Reply)> SaveAsync(IFileDialogs dialogs, bool saveAs)
    {
        try
        {
            var current = pdfium.Current ?? throw new ToolException("Open a PDF first.");
            var target = saveAs ? null : pdfium.SavePath;
            if (target is null)
            {
                var near = pdfium.SavePath ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), current.Name);
                var chosen = dialogs.SaveFile($"Save as (e.g. {current.Name})", Path.GetDirectoryName(near), PdfFilter);
                if (string.IsNullOrWhiteSpace(chosen))
                    return (null, new { type = "save-cancelled" });
                target = chosen.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) ? chosen : chosen + ".pdf";
            }

            // Unchanged and saved to the file it came from: nothing to write.
            if (!SamePath(current.Path, target))
                await WriteFileAsync(target, stream =>
                {
                    using var source = File.OpenRead(current.Path);
                    source.CopyTo(stream);
                    return 0;
                });
            pdfium.MarkSaved(target);
            return (target, new { type = "saved", fileName = Path.GetFileName(target), message = $"Saved {Path.GetFileName(target)}." });
        }
        catch (Exception ex)
        {
            return (null, new { type = "save-error", message = ErrorMessage(ex, "Unable to save the PDF.") });
        }
    }

    private string ErrorMessage(Exception ex, string fallback)
    {
        switch (ex)
        {
            case ToolException or LocalPdfException:
                return ex.Message;
            case KeyNotFoundException or InvalidOperationException or FormatException:
                logger.LogWarning(ex, "Malformed page request");
                return "Invalid request.";
            case IOException or UnauthorizedAccessException:
                logger.LogWarning(ex, "Could not write the PDF");
                return "Could not write the file. Check that it is not open in another program, the folder permissions and free disk space.";
            default:
                logger.LogError(ex, "Page operation failed");
                return fallback;
        }
    }

    /// <summary>"flatten" and "pages" (1-based page numbers) of a save or print request.</summary>
    public static AnnotatedOptions ReadAnnotatedOptions(JsonElement options) => new(
        options.TryGetProperty("flatten", out var f) && f.ValueKind == JsonValueKind.True,
        options.TryGetProperty("pages", out var p) && p.ValueKind == JsonValueKind.Array ? p.Deserialize<List<int>>() : null);

    private static List<PageSpec> ReadLayout(JsonElement element) =>
        element.GetProperty("layout").Deserialize<List<PageSpec>>(JsonSerializerOptions.Web)
        ?? throw new ToolException("Invalid page edit.");

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b),
            OperatingSystem.IsLinux() ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase);

    private static readonly object Cancelled = new { type = "tool-cancelled" };
    private static object Done(string message) => new { type = "tool-done", message };

    private List<(string Path, string Name)> ResolveInputs(JsonElement inputs)
    {
        var resolved = new List<(string Path, string Name)>();
        foreach (var input in inputs.EnumerateArray())
        {
            var id = input.GetString();
            if (id == "current")
                resolved.Add(pdfium.Current ?? throw new ToolException("Open a PDF first."));
            else if (id is not null && _picked.TryGetValue(id, out var path))
                resolved.Add((path, Path.GetFileName(path)));
            else
                throw new ToolException("One of the selected files is no longer available. Please add it again.");
        }
        if (resolved.Count == 0)
            throw new ToolException("Open a PDF first.");
        return resolved;
    }

    private static (string Path, string Name) Single(List<(string Path, string Name)> inputs) => inputs[0];

    private static List<PageRange> SplitRanges(string path, JsonElement options)
    {
        var pageCount = PdfTools.GetPageCount(path);
        return options.GetProperty("mode").GetString() switch
        {
            "pages" => PageRanges.EveryPage(pageCount),
            "chunks" => PageRanges.Chunks(pageCount, options.GetProperty("pagesPerFile").GetInt32()),
            "ranges" => PageRanges.Parse(options.GetProperty("ranges").GetString(), pageCount),
            _ => throw new ToolException("Choose how to split the PDF.")
        };
    }

    private static async Task<string> CompressAsync(string input, string output, JsonElement options)
    {
        var quality = options.GetProperty("level").GetString() switch
        {
            "small" => CompressionQuality.Small,
            "high" => CompressionQuality.High,
            _ => CompressionQuality.Medium
        };

        var temp = TempPathNextTo(output);
        try
        {
            await Ghostscript.CompressAsync(input, temp, quality, CancellationToken.None);
            var originalSize = new FileInfo(input).Length;
            var compressedSize = new FileInfo(temp).Length;
            if (compressedSize >= originalSize)
            {
                File.Copy(input, temp, overwrite: true);
                File.Move(temp, output, overwrite: true);
                return $"This PDF is already compact; saved an unchanged copy as {Path.GetFileName(output)}.";
            }
            File.Move(temp, output, overwrite: true);
            var saved = 100.0 * (originalSize - compressedSize) / originalSize;
            return $"Saved {Path.GetFileName(output)}: {FormatSize(originalSize)} → {FormatSize(compressedSize)} ({saved:0}% smaller).";
        }
        finally
        {
            File.Delete(temp);
        }
    }

    /// <summary>Writes to a temp file next to the target, then moves it into place.</summary>
    private static async Task<T> WriteFileAsync<T>(string output, Func<Stream, T> write)
    {
        var temp = TempPathNextTo(output);
        try
        {
            T result;
            await using (var stream = File.Create(temp))
                result = await Task.Run(() => write(stream));
            File.Move(temp, output, overwrite: true);
            return result;
        }
        finally
        {
            File.Delete(temp);
        }
    }

    private static string? AskSaveFile(IFileDialogs dialogs, string title, string nearPath, string extension,
        List<(string Path, string Name)> inputs, string? suggestedName = null)
    {
        var filter = extension switch
        {
            ".docx" => ("Word documents", new[] { "*.docx" }),
            ".xlsx" => ("Excel workbooks", new[] { "*.xlsx" }),
            ".csv" => ("CSV files", new[] { "*.csv" }),
            ".html" => ("Web pages", new[] { "*.html" }),
            _ => PdfFilter[0]
        };
        var chosen = dialogs.SaveFile(suggestedName is null ? title : $"{title} (e.g. {suggestedName}{extension})",
            Path.GetDirectoryName(nearPath), [filter]);
        if (string.IsNullOrWhiteSpace(chosen))
            return null;

        if (!chosen.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
            chosen += extension;

        if (inputs.Any(i => SamePath(i.Path, chosen)))
            throw new ToolException("Choose a different file name: the output cannot replace one of the input files.");
        return chosen;
    }

    private static string? AskFolder(IFileDialogs dialogs, string title, string nearPath)
    {
        var folder = dialogs.OpenFolder(title, Path.GetDirectoryName(nearPath));
        return string.IsNullOrWhiteSpace(folder) ? null : folder;
    }

    private static string CreateUniqueFolder(string parent, string name)
    {
        var path = Path.Combine(parent, name);
        for (var n = 2; Directory.Exists(path); n++)
            path = Path.Combine(parent, $"{name} ({n})");
        Directory.CreateDirectory(path);
        return path;
    }

    private static string TempPathNextTo(string output) =>
        Path.Combine(Path.GetDirectoryName(output) ?? ".", $".{Path.GetFileName(output)}.{Guid.NewGuid():N}.tmp");

    private static string BaseName(string fileName)
    {
        var name = Path.GetFileNameWithoutExtension(fileName);
        return string.IsNullOrWhiteSpace(name) ? "document" : name;
    }

    private static string FormatSize(long bytes) => bytes switch
    {
        >= 1L << 30 => $"{bytes / (double)(1L << 30):0.0} GB",
        >= 1L << 20 => $"{bytes / (double)(1L << 20):0.0} MB",
        _ => $"{bytes / 1024.0:0} KB"
    };
}

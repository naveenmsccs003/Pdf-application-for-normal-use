using System.Diagnostics;

namespace PdfViewer.Tools;

public enum CompressionQuality
{
    /// <summary>Smallest files, images at ~72 dpi (screen viewing).</summary>
    Small,
    /// <summary>Balanced, images at ~150 dpi (ebook preset).</summary>
    Medium,
    /// <summary>Larger files, images at ~300 dpi (printing).</summary>
    High
}

/// <summary>
/// PDF compression with Ghostscript (must be installed separately; AGPL licensed).
/// Ghostscript is run as a separate process with -dSAFER and without a shell.
/// </summary>
public static class Ghostscript
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(30);

    /// <summary>Returns the Ghostscript executable, or null if it is not installed.</summary>
    public static string? FindExecutable()
    {
        var configured = Environment.GetEnvironmentVariable("PDFVIEWER_GHOSTSCRIPT");
        if (!string.IsNullOrEmpty(configured))
            return File.Exists(configured) ? configured : null;

        var names = OperatingSystem.IsWindows() ? new[] { "gswin64c.exe", "gswin32c.exe" } : ["gs"];
        var pathDirs = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        foreach (var dir in pathDirs)
            foreach (var name in names)
            {
                var candidate = Path.Combine(dir, name);
                if (File.Exists(candidate)) return candidate;
            }

        if (OperatingSystem.IsWindows())
        {
            // Default install location: C:\Program Files\gs\gs10.xx.x\bin
            var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "gs");
            if (Directory.Exists(root))
                return Directory.EnumerateDirectories(root)
                    .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase)
                    .Select(d => Path.Combine(d, "bin", "gswin64c.exe"))
                    .FirstOrDefault(File.Exists);
        }
        return null;
    }

    public static async Task CompressAsync(string inputPath, string outputPath, CompressionQuality level, CancellationToken ct)
    {
        var executable = FindExecutable() ?? throw new ToolException(
            "Compression needs Ghostscript, which is not installed. Install it from https://ghostscript.com/releases/ and try again.");

        var preset = level switch
        {
            CompressionQuality.Small => "/screen",
            CompressionQuality.High => "/printer",
            _ => "/ebook"
        };

        var start = new ProcessStartInfo(executable)
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var arg in new[]
                 {
                     "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET",
                     "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", $"-dPDFSETTINGS={preset}",
                     "-dDetectDuplicateImages=true", $"-sOutputFile={outputPath}", inputPath
                 })
            start.ArgumentList.Add(arg);

        using var process = Process.Start(start) ?? throw new ToolException("Ghostscript could not be started.");
        var stderr = process.StandardError.ReadToEndAsync(ct);
        _ = process.StandardOutput.ReadToEndAsync(ct);

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            if (ct.IsCancellationRequested) throw;
            throw new ToolException("Compression took too long and was stopped.");
        }

        if (process.ExitCode != 0 || !File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
        {
            var details = await stderr;
            throw new ToolException(details.Contains("password", StringComparison.OrdinalIgnoreCase)
                ? "This PDF is password-protected and cannot be compressed."
                : "Ghostscript could not compress this PDF.");
        }
    }
}

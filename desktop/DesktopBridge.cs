using System.Text.Json;
using Photino.NET;
using PdfViewer.Desktop.Models;
using PdfViewer.Desktop.Services;

namespace PdfViewer.Desktop;

/// <summary>
/// Messages between the web UI and the desktop host (Photino web messaging).
///   UI -> host: { type: "ready" } | { type: "open" } | { type: "close" }
///               | { type: "open-recent", path } | { type: "clear-recent" }
///               | { type: "pick-pdfs" } | { type: "run-tool", tool, inputs, options }
///               | { type: "open-compare" } | { type: "close-compare" }
///               | { type: "new-document", count, width, height } | { type: "edit-pages", layout, inputs }
///               | { type: "save", saveAs } | { type: "full-screen", on }
///   host -> UI: { type: "opening", fileName } | { type: "opened", token, fileName, size, pageCount }
///             | { type: "open-error", message } | { type: "open-cancelled" }
///             | { type: "recent-files", files: [{ path, fileName, folder, exists }] }
///             | { type: "picked-pdfs", files } | { type: "tool-done" | "tool-error", message } | { type: "tool-cancelled" }
///             | { type: "compare-opened", token, fileName, pageCount } | { type: "compare-error", message }
///             | { type: "compare-cancelled" }
///             | { type: "pages-edited", token, fileName, size, pageCount } | { type: "edit-error", message }
///             | { type: "saved", fileName, message } | { type: "save-error", message } | { type: "save-cancelled" }
/// </summary>
public class DesktopBridge(PdfiumService pdfium, DesktopTools tools, RecentFiles recent, ILogger<DesktopBridge> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly (string, string[])[] PdfFilter = [("PDF files", ["*.pdf"]), ("All files", ["*"])];

    private Action<string>? _send;
    private PhotinoWindow? _window;
    private string? _startupFile;
    private string? _passwordPath;      // a file waiting for its password (see "open-password")

    // Test mode: replies go to the collector of the request being handled. AsyncLocal keeps
    // overlapping test requests (e.g. "ready" and "open") from receiving each other's replies.
    private readonly AsyncLocal<List<JsonElement>?> _testReplies = new();

    public void Attach(PhotinoWindow window, string? startupFile)
    {
        _startupFile = startupFile;
        _window = window;
        _send = message => window.SendWebMessage(message);
        var dialogs = new PhotinoFileDialogs(window);
        // Runs on the UI thread up to the first await, so dialogs open on the right thread.
        window.RegisterWebMessageReceivedHandler((_, message) => _ = HandleAsync(dialogs, message));
    }

    /// <summary>Test mode: handles one message with preset dialog answers and returns the replies.</summary>
    public async Task<List<JsonElement>> HandleForTestAsync(string message, IFileDialogs dialogs)
    {
        var replies = new List<JsonElement>();
        _testReplies.Value = replies;
        await HandleAsync(dialogs, message);
        return replies;
    }

    private async Task HandleAsync(IFileDialogs dialogs, string message)
    {
        JsonElement root;
        string? type;
        try
        {
            root = JsonDocument.Parse(message).RootElement;
            type = root.GetProperty("type").GetString();
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            logger.LogWarning("Ignoring malformed web message");
            return;
        }

        switch (type)
        {
            case "ready":
                SendRecent();
                if (_startupFile is not null)
                {
                    var file = _startupFile;
                    _startupFile = null;
                    await OpenAsync(file);
                }
                break;

            case "open-recent":
                await OpenRecentAsync(root.TryGetProperty("path", out var p) ? p.GetString() : null);
                break;

            case "clear-recent":
                recent.Clear();
                SendRecent();
                break;

            case "open":
                var paths = dialogs.OpenFiles("Open PDF", false, PdfFilter);
                if (paths is { Length: > 0 } && !string.IsNullOrEmpty(paths[0]))
                    await OpenAsync(paths[0]);
                else
                    Send(new { type = "open-cancelled" });
                break;

            case "open-password":
                // The password for the file that needed one; the path stays here, never comes from the page.
                var pending = _passwordPath;
                var password = root.TryGetProperty("password", out var pw) ? pw.GetString() : null;
                if (pending is null || string.IsNullOrEmpty(password))
                    Send(new { type = "open-cancelled" });
                else
                    await OpenAsync(pending, password);
                break;

            case "open-password-cancelled":
                _passwordPath = null;
                Send(new { type = "open-cancelled" });
                break;

            case "close":
                pdfium.Close();
                break;

            case "open-compare":
                var revision = dialogs.OpenFiles("Open the revision to compare with", false, PdfFilter);
                if (revision is { Length: > 0 } && !string.IsNullOrEmpty(revision[0]))
                    await OpenCompareAsync(revision[0]);
                else
                    Send(new { type = "compare-cancelled" });
                break;

            case "close-compare":
                pdfium.CloseCompare();
                break;

            case "pick-pdfs":
                Send(tools.PickPdfs(dialogs));
                break;

            case "run-tool":
                Send(await tools.RunAsync(dialogs, root));
                break;

            case "full-screen":
                // Full screen cannot be combined with a maximized window.
                if (_window is not null)
                {
                    var on = root.TryGetProperty("on", out var f) && f.GetBoolean();
                    if (on && _window.Maximized) _window.Maximized = false;
                    _window.FullScreen = on;
                }
                break;

            case "new-document":
                Send(await tools.NewDocumentAsync(root));
                break;

            case "edit-pages":
                Send(await tools.EditPagesAsync(root));
                break;

            case "save":
                var (saved, reply) = await tools.SaveAsync(dialogs, root.TryGetProperty("saveAs", out var a) && a.GetBoolean());
                if (saved is not null)
                {
                    recent.Add(saved);
                    SendRecent();
                }
                Send(reply);
                break;
        }
    }

    private async Task OpenAsync(string path, string? password = null)
    {
        Send(new { type = "opening", fileName = Path.GetFileName(path) });
        _passwordPath = null;
        try
        {
            // Large files can take a moment; keep the UI thread free.
            var info = await Task.Run(() => pdfium.Open(path, password));
            Send(new { type = "opened", info.Token, info.FileName, info.Size, info.PageCount, encrypted = password is not null });
            recent.Add(path);
            SendRecent();
        }
        catch (LocalPdfException ex) when (ex.NeedsPassword)
        {
            // Ask the viewer for the password; "open-password" opens this file with it.
            _passwordPath = path;
            Send(new { type = "password-required", fileName = Path.GetFileName(path), wrong = password is not null });
        }
        catch (LocalPdfException ex)
        {
            Send(new { type = "open-error", message = ex.Message });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to open {Path}", path);
            Send(new { type = "open-error", message = "Unable to open this PDF." });
        }
    }

    private async Task OpenCompareAsync(string path)
    {
        try
        {
            var info = await Task.Run(() => pdfium.OpenCompare(path));
            Send(new { type = "compare-opened", info.Token, info.FileName, info.PageCount });
        }
        catch (LocalPdfException ex)
        {
            Send(new { type = "compare-error", message = ex.Message });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to open {Path} for comparing", path);
            Send(new { type = "compare-error", message = "Unable to open this PDF." });
        }
    }

    /// <summary>Only paths already on the recent list are opened this way, never an arbitrary path from the page.</summary>
    private async Task OpenRecentAsync(string? path)
    {
        if (string.IsNullOrEmpty(path) || !recent.Contains(path))
        {
            Send(new { type = "open-error", message = "That file is not in the recent files list." });
            return;
        }
        if (!File.Exists(path))
        {
            recent.Remove(path);
            SendRecent();
            Send(new { type = "open-error", message = $"{Path.GetFileName(path)} was moved or deleted, so it was removed from Recent Files." });
            return;
        }
        await OpenAsync(path);
    }

    private void SendRecent() => Send(new { type = "recent-files", files = recent.List() });

    private void Send(object message)
    {
        var json = JsonSerializer.Serialize(message, Json);
        if (_testReplies.Value is { } replies)
        {
            lock (replies) replies.Add(JsonSerializer.Deserialize<JsonElement>(json));
            return;
        }
        _send?.Invoke(json);
    }
}

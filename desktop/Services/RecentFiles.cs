using System.Text.Json;

namespace PdfViewer.Desktop.Services;

/// <summary>
/// The most recently opened PDFs (newest first), kept in a small JSON file in the user's
/// application data folder (Linux: ~/.config/PdfViewer, Windows: %APPDATA%\PdfViewer).
/// Set PDFVIEWER_RECENT_FILE to use another file (the tests do, so they never touch the real list).
/// A missing or damaged file just means an empty list.
/// </summary>
public class RecentFiles(ILogger<RecentFiles> logger)
{
    public const int MaxEntries = 10;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _lock = new();
    private readonly string _file = Environment.GetEnvironmentVariable("PDFVIEWER_RECENT_FILE") is { Length: > 0 } custom
        ? custom
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PdfViewer", "recent-files.json");

    public record Entry(string Path, DateTime OpenedAt);

    /// <summary>What the UI shows: name, folder and whether the file is still there.</summary>
    public record Item(string Path, string FileName, string Folder, bool Exists);

    public IReadOnlyList<Item> List()
    {
        lock (_lock)
        {
            return Load().Select(e => new Item(
                e.Path,
                System.IO.Path.GetFileName(e.Path),
                System.IO.Path.GetDirectoryName(e.Path) ?? "",
                File.Exists(e.Path))).ToList();
        }
    }

    public bool Contains(string path)
    {
        lock (_lock) return Load().Any(e => SamePath(e.Path, path));
    }

    /// <summary>Moves (or adds) the file to the top of the list.</summary>
    public void Add(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        lock (_lock)
        {
            var entries = Load().Where(e => !SamePath(e.Path, full)).ToList();
            entries.Insert(0, new Entry(full, DateTime.UtcNow));
            Save(entries.Take(MaxEntries).ToList());
        }
    }

    public void Remove(string path)
    {
        lock (_lock) Save(Load().Where(e => !SamePath(e.Path, path)).ToList());
    }

    public void Clear()
    {
        lock (_lock) Save([]);
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(a, b, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private List<Entry> Load()
    {
        try
        {
            if (!File.Exists(_file)) return [];
            var entries = JsonSerializer.Deserialize<List<Entry>>(File.ReadAllText(_file), Json) ?? [];
            return entries.Where(e => !string.IsNullOrWhiteSpace(e.Path)).Take(MaxEntries).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            logger.LogWarning("Recent files list could not be read ({Message}); starting empty", ex.Message);
            return [];
        }
    }

    private void Save(List<Entry> entries)
    {
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_file)!);
            // Write a temp file first so a crash mid-write never leaves a half-written list.
            var temp = _file + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(entries, Json));
            File.Move(temp, _file, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning("Recent files list could not be saved ({Message})", ex.Message);
        }
    }
}

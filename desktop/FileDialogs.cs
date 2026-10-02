using Photino.NET;

namespace PdfViewer.Desktop;

/// <summary>Native file dialogs (an interface so tests can answer them without a window).</summary>
public interface IFileDialogs
{
    string[] OpenFiles(string title, bool multiSelect, (string Name, string[] Extensions)[] filters);
    string? SaveFile(string title, string? folder, (string Name, string[] Extensions)[] filters);
    string? OpenFolder(string title, string? folder);
}

/// <summary>Photino's dialogs; must be called on the window's UI thread.</summary>
public class PhotinoFileDialogs(PhotinoWindow window) : IFileDialogs
{
    public string[] OpenFiles(string title, bool multiSelect, (string Name, string[] Extensions)[] filters) =>
        window.ShowOpenFile(title, null, multiSelect, filters) ?? [];

    public string? SaveFile(string title, string? folder, (string Name, string[] Extensions)[] filters) =>
        window.ShowSaveFile(title, folder, filters);

    public string? OpenFolder(string title, string? folder) =>
        window.ShowOpenFolder(title, folder, false) is { Length: > 0 } folders ? folders[0] : null;
}

/// <summary>Test mode: returns answers supplied by the test instead of showing dialogs.</summary>
public class PresetFileDialogs(string[]? files, string? save, string? folder) : IFileDialogs
{
    public string[] OpenFiles(string title, bool multiSelect, (string Name, string[] Extensions)[] filters) => files ?? [];
    public string? SaveFile(string title, string? defaultFolder, (string Name, string[] Extensions)[] filters) => save;
    public string? OpenFolder(string title, string? defaultFolder) => folder;
}

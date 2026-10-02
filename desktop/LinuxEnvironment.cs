using System.Collections;
using System.Runtime.InteropServices;

namespace PdfViewer.Desktop;

/// <summary>
/// When started from a terminal inside the VS Code snap, variables such as GTK_PATH, GIO_MODULE_DIR
/// and LOCPATH point into the snap, and WebKit's helper processes crash loading its libraries.
/// VS Code keeps the original values in X_VSCODE_SNAP_ORIG; restore them before the window starts.
/// libc's setenv/unsetenv are used because .NET's SetEnvironmentVariable does not change the native
/// environment that WebKit's child processes inherit.
/// </summary>
internal static partial class LinuxEnvironment
{
    private const string SnapOriginalSuffix = "_VSCODE_SNAP_ORIG";

    public static void RestoreSnapOverrides()
    {
        if (!OperatingSystem.IsLinux())
            return;

        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var key = (string)entry.Key;
            if (!key.EndsWith(SnapOriginalSuffix, StringComparison.Ordinal))
                continue;

            var name = key[..^SnapOriginalSuffix.Length];
            var original = (string?)entry.Value;
            if (string.IsNullOrEmpty(original))
                unsetenv(name);
            else
                setenv(name, original, 1);
        }
    }

    [LibraryImport("libc", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int setenv(string name, string value, int overwrite);

    [LibraryImport("libc", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int unsetenv(string name);
}

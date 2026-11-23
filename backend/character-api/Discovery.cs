namespace CharacterApi;

// Where the helper publishes http.json (URL + bearer). Shared by the helper and the CLI.
//   Windows: %LOCALAPPDATA%\TabletopVR\character-bridge\v2
//   macOS:   ~/Library/Application Support/TabletopVR/character-bridge/v2
//   Linux:   ${XDG_DATA_HOME:-~/.local/share}/TabletopVR/character-bridge/v2 (development and tests only)
public static class Discovery
{
    public static string DefaultDirectory => DirectoryFor(Environment.GetEnvironmentVariable);

    public static string DirectoryFor(Func<string, string?> environment)
    {
        static string? Set(string? value) => string.IsNullOrEmpty(value) ? null : value;
        string root;
        if (OperatingSystem.IsWindows()) {
            root = Set(environment("LOCALAPPDATA")) ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        } else {
            string home = Set(environment("HOME")) ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!Path.IsPathRooted(home)) throw new InvalidOperationException("home_directory");
            root = OperatingSystem.IsMacOS() ? Path.Combine(home, "Library", "Application Support")
                : Set(environment("XDG_DATA_HOME")) is { } xdg && Path.IsPathRooted(xdg) ? xdg : Path.Combine(home, ".local", "share");
        }
        return Path.Combine(root, "TabletopVR", "character-bridge", "v2");
    }

    // The bearer in http.json grants the API: owner-only on macOS/Linux (Windows profiles are per-user already).
    public static void CreatePrivateDirectory(string directory)
    {
        if (OperatingSystem.IsWindows()) { Directory.CreateDirectory(directory); return; }
        const UnixFileMode owner = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
        Directory.CreateDirectory(directory, owner);
        File.SetUnixFileMode(directory, owner);
    }

    // Atomic replace; on Unix the temporary file is created 0600 before any secret is written.
    public static async Task WritePrivateFileAsync(string file, string text, CancellationToken token)
    {
        string temporary = file + ".tmp";
        File.Delete(temporary);
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        await using (var stream = new FileStream(temporary, options)) {
            await stream.WriteAsync(new System.Text.UTF8Encoding(false).GetBytes(text), token);
            await stream.FlushAsync(token);
        }
        File.Move(temporary, file, true);
    }
}

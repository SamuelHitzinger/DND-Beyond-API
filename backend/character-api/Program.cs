using System.Globalization;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;

namespace CharacterApi;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        try {
            using var identityStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("extension-identity.json")!;
            string origin = (await JsonNode.ParseAsync(identityStream))!["origin"]!.GetValue<string>();
            if (args.Length is < 1 or > 2 || args[0] != origin || (args.Length == 2 && !ValidParentWindow(args[1]))) return 64;
            // Windows: the WinExe's inherited pipe handles. macOS/Linux: ordinary stdio.
            using Stream input = OperatingSystem.IsWindows() ? OpenStandard(-10, PipeDirection.In) : Console.OpenStandardInput();
            using Stream output = OperatingSystem.IsWindows() ? OpenStandard(-11, PipeDirection.Out) : Console.OpenStandardOutput();
            await new RelayHost(Discovery.DefaultDirectory).RunAsync(input, output, CancellationToken.None);
            return 0;
        } catch { return 1; } // Native stdout is exclusively framed JSON; never disclose exceptions or credentials.
    }
    // Chrome adds --parent-window only on Windows; macOS passes the origin alone.
    private static bool ValidParentWindow(string value) => value.StartsWith("--parent-window=", StringComparison.Ordinal) &&
        ulong.TryParse(value.AsSpan(16), NumberStyles.None, CultureInfo.InvariantCulture, out _);
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static NamedPipeClientStream OpenStandard(int id, PipeDirection direction)
    {
        var handle = new SafePipeHandle(GetStdHandle(id), ownsHandle: false);
        try { return new NamedPipeClientStream(direction, isAsync: false, isConnected: true, handle); }
        catch { handle.Dispose(); throw; }
    }
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int id);
}


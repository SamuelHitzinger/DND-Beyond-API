using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using CharacterApi;

static class Tests
{
    static void Check(bool condition, string message) { if (!condition) throw new Exception("FAIL " + message); }
    // Child processes get an isolated profile: LOCALAPPDATA on Windows, HOME (no XDG_DATA_HOME) on macOS/Linux.
    static void Isolate(ProcessStartInfo launch, string profile)
    {
        if (OperatingSystem.IsWindows()) launch.Environment["LOCALAPPDATA"] = profile;
        else { launch.Environment["HOME"] = profile; launch.Environment.Remove("XDG_DATA_HOME"); }
    }
    static string IsolatedDirectory(string profile) => Discovery.DirectoryFor(name => name is "LOCALAPPDATA" or "HOME" ? profile : null);
    static void CheckPrivate(string directory, string file)
    {
        if (OperatingSystem.IsWindows()) return;
        Check(File.GetUnixFileMode(directory) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute), "config directory is owner-only (0700)");
        Check(File.GetUnixFileMode(file) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "bearer file is owner-only (0600)");
    }
    static async Task Main(string[] args)
    {
        string root = Path.Combine(Path.GetTempPath(), "character api tests " + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            if (args is ["cli"]) { await CliResults(root); Console.WriteLine("PASS actual CLI response-state exit codes"); }
            else { await Framing(); await Relay(root); await LostHeartbeat(root); await MalformedResponse(root); await PublishedArguments(root); await CliResults(root); Console.WriteLine("PASS standalone native relay, HTTP, lifecycle, framing, GUI process and CLI response states"); }
        }
        finally { Directory.Delete(root, true); }
    }
    static async Task Framing()
    {
        using var bytes = new MemoryStream();
        await NativeFrames.WriteAsync(bytes, new JsonObject { ["type"] = "ping" }, default);
        Check(bytes.ToArray()[0] == 15, "little endian frame length");
        bytes.Position = 0;
        Check((await NativeFrames.ReadAsync(bytes, default))!["type"]!.GetValue<string>() == "ping", "frame roundtrip");
        Check(await NativeFrames.ReadAsync(bytes, default) is null, "clean EOF");
        foreach (byte[] invalid in new byte[][] { [1, 0], [0, 0, 0, 0], [1, 0, 16, 0], [4, 0, 0, 0, 123] }) {
            try { await NativeFrames.ReadAsync(new MemoryStream(invalid), default); throw new Exception("accepted bad frame"); }
            catch (InvalidDataException) { } catch (EndOfStreamException) { }
        }
    }
    static async Task Relay(string root)
    {
        string directory = Path.Combine(root, "state"); Directory.CreateDirectory(directory);
        string token = new('a', 64);
        await File.WriteAllTextAsync(Path.Combine(directory, "http.json"), new JsonObject { ["url"] = "http://127.0.0.1:1", ["token"] = token }.ToJsonString());
        foreach (string name in new[] { "root.json", "clients.json", "journal.json" }) await File.WriteAllTextAsync(Path.Combine(directory, name), "leave alone");
        string pipeName = "character-api-test-" + Guid.NewGuid().ToString("N");
        await using var hostPipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        await using var browser = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        Task connected = hostPipe.WaitForConnectionAsync(); await browser.ConnectAsync(); await connected;
        Task host = new RelayHost(directory).RunAsync(hostPipe, hostPipe, default);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        Check((await NativeFrames.ReadAsync(browser, deadline.Token))!["type"]!.GetValue<string>() == "ready", "ready after listener/config");
        var config = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "http.json")))!;
        Check(config["token"]!.GetValue<string>() == token, "preserves existing bearer");
        CheckPrivate(directory, Path.Combine(directory, "http.json"));
        try { await new RelayHost(directory).RunAsync(new MemoryStream(), new MemoryStream(), deadline.Token); throw new Exception("accepted duplicate relay"); }
        catch (IOException) { }
        using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = new Uri(config["url"]!.GetValue<string>()), Timeout = TimeSpan.FromSeconds(15) };
        Check(client.BaseAddress.Host == "127.0.0.1", "IPv4 loopback only");
        var unauthorized = await client.GetAsync("/v1/status"); Check(unauthorized.StatusCode == HttpStatusCode.Unauthorized, "bearer required");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        client.DefaultRequestHeaders.Add("Origin", "https://example.invalid");
        var schema = await client.GetAsync("/openapi.json"); Check(schema.IsSuccessStatusCode && JsonNode.Parse(await schema.Content.ReadAsStringAsync())!["openapi"] is not null, "embedded authenticated OpenAPI");
        Check(!schema.Headers.Contains("Access-Control-Allow-Origin"), "no CORS");
        var bad = await client.PostAsync("/v1/character", new StringContent("{", Encoding.UTF8, "application/json")); Check(bad.StatusCode == HttpStatusCode.BadRequest, "invalid JSON rejected before relay");
        var huge = await client.PostAsync("/v1/character", new StringContent(new string('x', 24001))); Check(huge.StatusCode == HttpStatusCode.RequestEntityTooLarge, "body byte limit");
        await NativeFrames.WriteAsync(browser, new JsonObject { ["type"] = "ping" }, deadline.Token);
        Check((await NativeFrames.ReadAsync(browser, deadline.Token))!["type"]!.GetValue<string>() == "pong", "heartbeat");
        var first = client.GetAsync("/v1/character?view=full");
        var a = (await NativeFrames.ReadAsync(browser, deadline.Token))!;
        var second = client.PostAsync("/v1/character/hp", new StringContent("{\"current\":7}", Encoding.UTF8, "application/json"));
        var b = (await NativeFrames.ReadAsync(browser, deadline.Token))!;
        Check(a["request"]!["path"]!.GetValue<string>() == "/v1/character?view=full" && a["request"]!["body"] is null, "GET path/query forwarding");
        Check(b["request"]!["method"]!.GetValue<string>() == "POST" && b["request"]!["body"]!["current"]!.GetValue<int>() == 7, "write forwarded exactly once");
        await Reply(browser, b, new JsonObject { ["result"] = "second" }, deadline.Token);
        await Reply(browser, a, new JsonObject { ["result"] = new string('z', 65000) }, deadline.Token);
        Check((await (await second).Content.ReadAsStringAsync()).Contains("second"), "concurrent id routing");
        Check((await (await first).Content.ReadAsStringAsync()).Contains(new string('z', 65000)), "ordered multi-chunk response");
        var pending = client.PostAsync("/v1/character/hp", new StringContent("{}", Encoding.UTF8, "application/json"));
        Check((await NativeFrames.ReadAsync(browser, deadline.Token))!["type"]!.GetValue<string>() == "request", "pending request sent");
        await browser.DisposeAsync();
        var lost = await pending; Check(lost.StatusCode == HttpStatusCode.ServiceUnavailable && (await lost.Content.ReadAsStringAsync()).Contains("unknown"), "EOF gives unknown write without retry");
        await host.WaitAsync(deadline.Token);
        foreach (string name in new[] { "root.json", "clients.json", "journal.json" }) Check(await File.ReadAllTextAsync(Path.Combine(directory, name)) == "leave alone", "legacy private files untouched");
        Check(Directory.GetFiles(directory).Length == 5, "only config and broker lock created");
        using var exclusive = new FileStream(Path.Combine(directory, "broker.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
    }
    static async Task Reply(Stream stream, JsonNode request, JsonObject body, CancellationToken token)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(new JsonObject { ["status"] = 200, ["body"] = body }.ToJsonString());
        for (int offset = 0, index = 0; offset < bytes.Length; offset += 24000, index++) {
            int count = Math.Min(24000, bytes.Length - offset);
            await NativeFrames.WriteAsync(stream, new JsonObject { ["type"] = "response", ["id"] = request["id"]!.GetValue<string>(), ["index"] = index, ["final"] = offset + count == bytes.Length, ["data"] = Convert.ToBase64String(bytes, offset, count) }, token);
        }
    }
    static async Task LostHeartbeat(string root)
    {
        string name = "character-api-watchdog-" + Guid.NewGuid().ToString("N");
        await using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        await using var browser = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        Task connecting = server.WaitForConnectionAsync(); await browser.ConnectAsync(); await connecting;
        string directory = Path.Combine(root, "heartbeat");
        Task host = new RelayHost(directory).RunAsync(server, server, default);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(14));
        Check((await NativeFrames.ReadAsync(browser, deadline.Token))!["type"]!.GetValue<string>() == "ready", "watchdog fixture ready");
        var config = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "http.json")))!;
        using var client = new HttpClient(); client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config["token"]!.GetValue<string>());
        var request = client.PostAsync(config["url"]!.GetValue<string>() + "/v1/character/hp", new StringContent("{}"));
        Check((await NativeFrames.ReadAsync(browser, deadline.Token))!["type"]!.GetValue<string>() == "request", "watchdog request sent once");
        var response = await request.WaitAsync(deadline.Token);
        Check(response.StatusCode == HttpStatusCode.ServiceUnavailable && (await response.Content.ReadAsStringAsync()).Contains("unknown"), "missing ping fails pending write as unknown");
        await host.WaitAsync(deadline.Token);
        try { await client.GetAsync(config["url"]!.GetValue<string>() + "/openapi.json"); throw new Exception("listener remained open"); } catch (HttpRequestException) { }
    }
    static async Task MalformedResponse(string root)
    {
        string name = "character-api-malformed-" + Guid.NewGuid().ToString("N");
        await using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        await using var browser = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        Task connecting = server.WaitForConnectionAsync(); await browser.ConnectAsync(); await connecting;
        string directory = Path.Combine(root, "malformed");
        Task host = new RelayHost(directory).RunAsync(server, server, default);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await NativeFrames.ReadAsync(browser, deadline.Token);
        var config = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "http.json")))!;
        using var client = new HttpClient(); client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config["token"]!.GetValue<string>());
        var response = client.GetAsync(config["url"]!.GetValue<string>() + "/v1/character");
        var request = (await NativeFrames.ReadAsync(browser, deadline.Token))!;
        await NativeFrames.WriteAsync(browser, new JsonObject { ["type"]="response", ["id"]=request["id"]!.GetValue<string>(), ["index"]=1, ["final"]=true, ["data"]="e30=" }, deadline.Token);
        Check((await response).StatusCode == HttpStatusCode.ServiceUnavailable, "out of order chunk rejected");
        try { await host.WaitAsync(deadline.Token); throw new Exception("accepted bad chunk ordering"); } catch (InvalidDataException) { }
    }
    static async Task PublishedArguments(string root)
    {
        string? executable = Environment.GetEnvironmentVariable("CHARACTER_API_TEST_EXECUTABLE");
        Check(executable is not null && File.Exists(executable), "actual self-contained helper supplied");
        using var process = Process.Start(new ProcessStartInfo(executable!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, Arguments = "--game" })!;
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        Check(process.ExitCode == 64 && (await process.StandardOutput.ReadToEndAsync()).Length == 0, "GUI helper rejects legacy game launch without stdout pollution");
        Check(!(await process.StandardError.ReadToEndAsync()).Contains("Exception"), "errors never expose arbitrary exceptions");
        string localAppData = Path.Combine(root, "isolated local app data"); Directory.CreateDirectory(localAppData);
        // LOCALAPPDATA is redirected only in this child process. Never access the
        // actual user profile/config or a running browser during verification.
        var launch = new ProcessStartInfo(executable!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        launch.ArgumentList.Add("chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/");
        if (OperatingSystem.IsWindows()) launch.ArgumentList.Add("--parent-window=0"); // Chrome on macOS passes the origin only
        Isolate(launch, localAppData);
        launch.Environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"] = Path.Combine(root, "runtime extraction");
        using var native = Process.Start(launch)!;
        try {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            Check((await NativeFrames.ReadAsync(native.StandardOutput.BaseStream, timeout.Token))!["type"]!.GetValue<string>() == "ready", "actual WinExe inherited stdio ready frame");
            string configPath = Path.Combine(IsolatedDirectory(localAppData), "http.json");
            Check(File.Exists(configPath), "published helper honors the isolated profile");
            CheckPrivate(Path.GetDirectoryName(configPath)!, configPath);
            var config = JsonNode.Parse(await File.ReadAllTextAsync(configPath))!;
            using var http = new HttpClient(); http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", config["token"]!.GetValue<string>());
            var openapi = await http.GetAsync(config["url"]!.GetValue<string>() + "/openapi.json");
            Check(openapi.IsSuccessStatusCode, "published self-contained Kestrel and embedded API dependencies");
            await NativeFrames.WriteAsync(native.StandardInput.BaseStream, new JsonObject { ["type"] = "ping" }, timeout.Token);
            Check((await NativeFrames.ReadAsync(native.StandardOutput.BaseStream, timeout.Token))!["type"]!.GetValue<string>() == "pong", "published native framing");
            native.StandardInput.Close(); await native.WaitForExitAsync(timeout.Token);
            Check(native.ExitCode == 0 && (await native.StandardError.ReadToEndAsync()).Length == 0, "published helper exits cleanly on native EOF");
        } finally { if (!native.HasExited) { native.Kill(); await native.WaitForExitAsync(); } }
    }
    static async Task CliResults(string root)
    {
        string? executable = Environment.GetEnvironmentVariable("CHARACTER_API_TEST_CLI");
        Check(executable is not null && File.Exists(executable), "actual self-contained CLI supplied");
        string localAppData = Path.Combine(root, "cli isolated local app data");
        string name = "character-api-cli-" + Guid.NewGuid().ToString("N");
        await using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        await using var browser = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        Task connecting = server.WaitForConnectionAsync(); await browser.ConnectAsync(); await connecting;
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        Task host = new RelayHost(IsolatedDirectory(localAppData)).RunAsync(server, server, lifetime.Token);
        string bodyFile = Path.Combine(root, "explicit change.json"); await File.WriteAllTextAsync(bodyFile, "{\"current\":7}");
        try {
            await NativeFrames.ReadAsync(browser, lifetime.Token);
            foreach (var (body, status, exit) in new (JsonObject, int, int)[] {
                (new() { ["state"]="unknown" }, 200, 4), (new() { ["state"]="rejected" }, 200, 1),
                (new() { ["state"]="conflict" }, 200, 1), (new() { ["error"]="invalid_request" }, 200, 1),
                (new() { ["state"]="verified" }, 200, 0), (new() { ["error"]="unavailable" }, 503, 1)
            }) {
                var launch = new ProcessStartInfo(executable!) { UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true };
                foreach (string argument in new[] { "POST", "/v1/character/hp", "--body-file", bodyFile }) launch.ArgumentList.Add(argument);
                Isolate(launch, localAppData);
                launch.Environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"] = Path.Combine(root, "cli runtime extraction");
                using var process = Process.Start(launch)!;
                var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                var request = (await NativeFrames.ReadAsync(browser, lifetime.Token))!;
                Check(request["request"]!["body"]!["current"]!.GetValue<int>() == 7, "CLI forwards explicit body-file once");
                byte[] bytes = Encoding.UTF8.GetBytes(new JsonObject { ["status"]=status, ["body"]=body.DeepClone() }.ToJsonString());
                await NativeFrames.WriteAsync(browser, new JsonObject { ["type"]="response", ["id"]=request["id"]!.GetValue<string>(), ["index"]=0, ["final"]=true, ["data"]=Convert.ToBase64String(bytes) }, lifetime.Token);
                await process.WaitForExitAsync(lifetime.Token);
                Check(process.ExitCode == exit, "CLI exit " + exit + " for " + body.ToJsonString());
                Check(JsonNode.DeepEquals(JsonNode.Parse(await output), body) && (await error).Length == 0, "CLI preserves JSON result without credentials/exceptions");
            }
        } finally {
            await lifetime.CancelAsync();
            try { await host; } catch (OperationCanceledException) { }
        }
    }
}

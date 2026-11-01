using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

bool possibleWrite = false;
try {
    string[] command = args.Length > 0 && args[0] == "api" ? args[1..] : args;
    if (command.Length is not (2 or 4) || (command.Length == 4 && command[2] != "--body-file") ||
        !new[] { "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS" }.Contains(command[0]) ||
        !command[1].StartsWith('/') || command[1].StartsWith("//") || command[1].Contains('#') || command[1].Contains('\\')) {
        Console.Error.WriteLine("Usage: character-api.exe METHOD /path [--body-file file]"); return 64;
    }
    string directory = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TabletopVR", "character-bridge", "v2");
    var config = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "http.json")))!;
    var url = new Uri(config["url"]!.GetValue<string>());
    string bearer = config["token"]!.GetValue<string>();
    if (url.Scheme != "http" || url.Host != "127.0.0.1" || !url.IsLoopback || url.UserInfo.Length != 0 || url.AbsolutePath != "/" || url.Query.Length != 0 || url.Fragment.Length != 0 || bearer.Length != 64 || !bearer.All(char.IsAsciiHexDigit)) throw new InvalidDataException();
    using var request = new HttpRequestMessage(new HttpMethod(command[0]), new Uri(url, command[1]));
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
    if (command.Length == 4) {
        byte[] bytes = await File.ReadAllBytesAsync(command[3]);
        if (bytes.Length > 24000) { Console.Error.WriteLine("Request body exceeds 24000 bytes."); return 64; }
        _ = JsonNode.Parse(bytes); request.Content = new ByteArrayContent(bytes); request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
    }
    using var client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false }) { Timeout = TimeSpan.FromSeconds(75) };
    possibleWrite = command[0] is not ("GET" or "HEAD" or "OPTIONS");
    using var response = await client.SendAsync(request);
    Console.OutputEncoding = new UTF8Encoding(false);
    string text = await response.Content.ReadAsStringAsync();
    Console.WriteLine(text);
    var result = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text) as JsonObject;
    string? state = result?["state"] is JsonValue value && value.TryGetValue<string>(out string? name) ? name : null;
    if (state == "unknown") return 4;
    if (state is "rejected" or "conflict" or "failed" or "error" || result?.ContainsKey("error") == true) return 1;
    return response.IsSuccessStatusCode ? 0 : 1;
} catch {
    Console.Error.WriteLine("API unavailable or configuration invalid. A write may have completed; do not retry it automatically."); return possibleWrite ? 4 : 1;
}

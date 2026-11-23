using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace CharacterApi;

internal sealed class LocalHttpApi(WebApplication application) : IAsyncDisposable
{
    internal static async Task<LocalHttpApi> StartAsync(string directory, Func<JsonObject, CancellationToken, Task<JsonObject>> dispatch, CancellationToken token)
    {
        string file = Path.Combine(directory, "http.json");
        string bearer;
        try { bearer = JsonNode.Parse(await File.ReadAllTextAsync(file, token))!["token"]!.GetValue<string>(); }
        catch (FileNotFoundException) { bearer = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)); }
        if (bearer.Length != 64 || !bearer.All(char.IsAsciiHexDigit)) throw new InvalidDataException("http_config");
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [], ContentRootPath = directory });
        builder.Configuration.Sources.Clear(); builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => { options.Listen(IPAddress.Loopback, 0); options.Limits.MaxRequestBodySize = 24000; });
        var app = builder.Build();
        app.Run(async context => {
            context.Response.ContentType = "application/json"; context.Response.Headers.CacheControl = "no-store";
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(context.Request.Headers.Authorization.ToString()), Encoding.UTF8.GetBytes("Bearer " + bearer))) {
                context.Response.StatusCode = 401; await context.Response.WriteAsync("{\"error\":\"unauthorized\"}"); return;
            }
            bool write = context.Request.Method is not ("GET" or "HEAD" or "OPTIONS");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token, context.RequestAborted);
            timeout.CancelAfter(TimeSpan.FromSeconds(70));
            try {
                if (context.Request.Method == "GET" && context.Request.Path == "/openapi.json") {
                    using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("openapi.json")!;
                    await resource.CopyToAsync(context.Response.Body, timeout.Token); return;
                }
                JsonNode? body = null;
                if (context.Request.Method is not ("GET" or "HEAD")) {
                    // Kestrel enforces the byte limit for both Content-Length and
                    // chunked bodies; no character-count approximation.
                    using var bytes = new MemoryStream(); await context.Request.Body.CopyToAsync(bytes, timeout.Token);
                    if (bytes.Length != 0) body = JsonNode.Parse(bytes.ToArray());
                }
                var result = await dispatch(new JsonObject { ["method"] = context.Request.Method, ["path"] = context.Request.Path + context.Request.QueryString, ["body"] = body }, timeout.Token);
                context.Response.StatusCode = result["status"]!.GetValue<int>();
                await context.Response.WriteAsync(result["body"]?.ToJsonString() ?? "null", timeout.Token);
            } catch (JsonException) { context.Response.StatusCode = 400; await context.Response.WriteAsync("{\"error\":\"invalid_json\"}"); }
            catch (BadHttpRequestException e) { context.Response.StatusCode = e.StatusCode; }
            catch {
                if (context.Response.HasStarted) { context.Abort(); return; }
                context.Response.StatusCode = 503;
                await context.Response.WriteAsync(write ? "{\"state\":\"unknown\",\"reason\":\"browser_unavailable\"}" : "{\"error\":\"browser_unavailable\"}");
            }
        });
        try {
            await app.StartAsync(token);
            string url = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
            await Discovery.WritePrivateFileAsync(file, new JsonObject { ["url"] = url, ["token"] = bearer }.ToJsonString(), token);
            return new(app);
        } catch { await app.DisposeAsync(); throw; }
    }
    public async ValueTask DisposeAsync() {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await application.StopAsync(deadline.Token); } finally { await application.DisposeAsync(); }
    }
}

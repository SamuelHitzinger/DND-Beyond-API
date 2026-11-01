using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace CharacterApi;

// One browser-owned relay, with no durable request state and no retries.
public sealed class RelayHost(string directory)
{
    private readonly ConcurrentDictionary<string, Pending> pending = new();
    private readonly SemaphoreSlim writes = new(1, 1);
    private long lastPing = Stopwatch.GetTimestamp();
    public async Task RunAsync(Stream input, Stream output, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory);
        using var exclusive = new FileStream(Path.Combine(directory, "broker.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        async Task Send(JsonObject message, CancellationToken token) {
            await writes.WaitAsync(token);
            try { await NativeFrames.WriteAsync(output, message, token); }
            finally { writes.Release(); }
        }
        async Task<JsonObject> Dispatch(JsonObject request, CancellationToken token) {
            if (pending.Count >= 64) throw new IOException("relay_busy");
            string id = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
            var item = new Pending();
            if (!pending.TryAdd(id, item)) throw new IOException("relay_busy");
            try {
                await Send(new JsonObject { ["type"] = "request", ["id"] = id, ["request"] = request }, token);
                return await item.Completion.Task.WaitAsync(token);
            } finally { pending.TryRemove(id, out _); item.Dispose(); }
        }
        await using var http = await LocalHttpApi.StartAsync(directory, Dispatch, lifetime.Token);
        Task? reader = null;
        try {
            Interlocked.Exchange(ref lastPing, Stopwatch.GetTimestamp());
            await Send(new JsonObject { ["type"] = "ready" }, lifetime.Token);
            reader = ReadBrowser();
            Task watchdog = Watchdog();
            await Task.WhenAny(reader, watchdog);
            if (reader.IsCompleted) await reader;
            else await watchdog;
        } finally {
            // Resolve writes before listener shutdown: callers must see unknown,
            // and the host must never replay a browser operation after disconnect.
            foreach (var item in pending.Values) item.Completion.TrySetException(new IOException("browser_unavailable"));
            await lifetime.CancelAsync();
            if (reader is not null) _ = reader.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
        }
        async Task ReadBrowser() {
            while (!lifetime.IsCancellationRequested) {
                JsonObject? message = await NativeFrames.ReadAsync(input, lifetime.Token);
                if (message is null) return;
                string type = message["type"]?.GetValue<string>() ?? "";
                if (type == "ping") {
                    Interlocked.Exchange(ref lastPing, Stopwatch.GetTimestamp());
                    await Send(new JsonObject { ["type"] = "pong" }, lifetime.Token);
                } else if (type == "response") {
                    string id = message["id"]?.GetValue<string>() ?? "";
                    if (id.Length != 32 || !id.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')) throw new InvalidDataException("response_id");
                    // Timed-out HTTP clients may leave a response in flight.
                    if (pending.TryGetValue(id, out var item)) item.Accept(message);
                } else throw new InvalidDataException("native_message");
            }
        }
        async Task Watchdog() {
            while (!lifetime.IsCancellationRequested) {
                await Task.Delay(TimeSpan.FromSeconds(1), lifetime.Token);
                if (Stopwatch.GetElapsedTime(Interlocked.Read(ref lastPing)) > TimeSpan.FromSeconds(10)) return;
            }
        }
    }
    private sealed class Pending : IDisposable
    {
        internal readonly TaskCompletionSource<JsonObject> Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly MemoryStream bytes = new();
        private int nextIndex;
        // Cancellation can dispose a request while a native response is arriving.
        private readonly object gate = new();
        private bool disposed;
        internal void Accept(JsonObject message) {
            lock (gate) {
                if (disposed || Completion.Task.IsCompleted) return;
                if (message["index"]?.GetValue<int>() != nextIndex++) throw new InvalidDataException("response_order");
                bool final = message["final"]?.GetValue<bool>() ?? throw new InvalidDataException("response_final");
                string data = message["data"]?.GetValue<string>() ?? throw new InvalidDataException("response_data");
                if (data.Length > 32000) throw new InvalidDataException("response_chunk_size");
                byte[] chunk = Convert.FromBase64String(data);
                if (chunk.Length > 24000 || (chunk.Length == 0 && !final) || bytes.Length + chunk.Length > 12 * 1024 * 1024) throw new InvalidDataException("response_size");
                bytes.Write(chunk);
                if (!final) return;
                var result = JsonNode.Parse(bytes.ToArray()) as JsonObject ?? throw new InvalidDataException("response_json");
                int status = result["status"]?.GetValue<int>() ?? 0;
                if (status is < 200 or > 599 || !result.ContainsKey("body")) throw new InvalidDataException("response_status");
                Completion.TrySetResult(result);
            }
        }
        public void Dispose() { lock (gate) { disposed = true; bytes.Dispose(); } }
    }
}

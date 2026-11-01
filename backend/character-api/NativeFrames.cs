using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CharacterApi;

public static class NativeFrames
{
    public const int MaximumBytes = 1024 * 1024;
    public static async Task<JsonObject?> ReadAsync(Stream stream, CancellationToken token)
    {
        byte[] header = new byte[4];
        int first = await stream.ReadAsync(header.AsMemory(0, 1), token);
        if (first == 0) return null;
        await stream.ReadExactlyAsync(header.AsMemory(1), token);
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length is 0 or > MaximumBytes) throw new InvalidDataException("native_frame_size");
        byte[] bytes = new byte[length];
        await stream.ReadExactlyAsync(bytes, token);
        return JsonNode.Parse(bytes, documentOptions: new JsonDocumentOptions { MaxDepth = 64 }) as JsonObject ?? throw new InvalidDataException("native_frame_json");
    }
    // The caller serializes writes across requests and heartbeat replies.
    public static async Task WriteAsync(Stream stream, JsonObject message, CancellationToken token)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        if (bytes.Length is 0 or > MaximumBytes) throw new InvalidDataException("native_frame_size");
        byte[] header = new byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)bytes.Length);
        await stream.WriteAsync(header, token); await stream.WriteAsync(bytes, token); await stream.FlushAsync(token);
    }
}

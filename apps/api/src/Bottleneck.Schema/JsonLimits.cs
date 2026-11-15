using System.Text.Json;
using System.Text.Json.Nodes;

namespace Bottleneck.Schema;

/// <summary>
/// Size limits applied before schema validation (review D5): the schema's maxItems caps each collection,
/// and these cap the document as a whole, so a valid-looking document cannot still be huge.
/// </summary>
public sealed record JsonLimitOptions(int MaxDepth, int MaxNodes);

public static class JsonLimits
{
    /// <summary>Parses UTF-8 JSON with a depth limit. Returns null and an error message if it is not a JSON object.</summary>
    public static JsonObject? ParseObject(ReadOnlySpan<byte> utf8, JsonLimitOptions limits, out string? error)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(utf8, documentOptions: new JsonDocumentOptions { MaxDepth = limits.MaxDepth, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false });
        }
        catch (JsonException ex)
        {
            error = ex.Message.Contains("depth", StringComparison.OrdinalIgnoreCase)
                ? $"The JSON is nested deeper than {limits.MaxDepth} levels."
                : "The body is not valid JSON.";
            return null;
        }
        if (node is not JsonObject obj)
        {
            error = "The body must be a JSON object.";
            return null;
        }
        var count = CountNodes(obj, limits.MaxNodes + 1);
        if (count > limits.MaxNodes)
        {
            error = $"The document has more than {limits.MaxNodes} JSON values.";
            return null;
        }
        error = null;
        return obj;
    }

    /// <summary>Counts objects, arrays and values, stopping early once <paramref name="stopAt"/> is reached.</summary>
    public static int CountNodes(JsonNode root, int stopAt)
    {
        var count = 0;
        var stack = new Stack<JsonNode?>();
        stack.Push(root);
        while (stack.Count > 0 && count < stopAt)
        {
            var node = stack.Pop();
            count++;
            switch (node)
            {
                case JsonObject o:
                    foreach (var (_, child) in o) stack.Push(child);
                    break;
                case JsonArray a:
                    foreach (var child in a) stack.Push(child);
                    break;
            }
        }
        return count;
    }
}

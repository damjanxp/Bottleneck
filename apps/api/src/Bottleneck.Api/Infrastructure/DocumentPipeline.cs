using System.Text.Json;
using System.Text.Json.Nodes;
using Bottleneck.Api.Options;
using Bottleneck.Schema;
using Microsoft.Extensions.Options;

namespace Bottleneck.Api.Infrastructure;

/// <summary>
/// Every document write goes through here (spec section 8: "the backend validates every write against the
/// same schema"): byte cap → JSON parse with a depth cap → node-count cap → schemaVersion check →
/// validate against the document's own version → migrate → validate against the current version.
/// </summary>
public sealed class DocumentPipeline(DocumentMigrator migrator, IOptions<LimitsOptions> limits)
{
    public sealed record Result(JsonObject? Document, IResult? Error);

    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    public JsonLimitOptions JsonLimits => new(limits.Value.MaxJsonDepth, limits.Value.MaxJsonNodes);

    public async Task<Result> ReadAsync(HttpRequest request, DocumentKind kind, int maxBytes, CancellationToken ct)
    {
        if (!RequestBody.IsJson(request))
            return new(null, Problems.UnsupportedMediaType("Send the document as application/json."));
        var body = await RequestBody.ReadAsync(request, maxBytes, ct);
        if (body.Error is not null) return new(null, body.Error);
        return Process(kind, body.Bytes!);
    }

    public Result Process(DocumentKind kind, ReadOnlySpan<byte> utf8)
    {
        var doc = Schema.JsonLimits.ParseObject(utf8, JsonLimits, out var parseError);
        if (doc is null)
        {
            return new(null, parseError is not null && parseError.StartsWith("The document has more", StringComparison.Ordinal)
                ? Problems.TooLarge(parseError)
                : Problems.BadJson(parseError ?? "The body is not valid JSON."));
        }
        var migrated = migrator.Process(kind, doc);
        return migrated.Status switch
        {
            MigrationStatus.Ok => new(migrated.Document, null),
            MigrationStatus.TooNew => new(null, Problems.Unprocessable("Schema version too new", migrated.Errors[0].Message, "schema-version-too-new")),
            MigrationStatus.Unknown or MigrationStatus.MissingVersion => new(null, Problems.Unprocessable("Unknown schema version", migrated.Errors[0].Message, "schema-version-unknown")),
            _ => new(null, Problems.SchemaInvalid(migrated.Errors)),
        };
    }

    /// <summary>
    /// Migrates a stored document on read (spec section 8: "migrates old documents on read").
    /// With schemaVersion 1 this is the identity; stored documents were validated on write.
    /// </summary>
    public JsonObject ReadStored(DocumentKind kind, string json, int storedVersion)
    {
        var doc = JsonNode.Parse(json)!.AsObject();
        if (storedVersion == migrator.CurrentVersion) return doc;
        var migrated = migrator.Process(kind, doc);
        return migrated.Ok
            ? migrated.Document!
            : throw new InvalidOperationException($"Stored {kind} document (v{storedVersion}) failed migration: {migrated.Status}.");
    }

    public static string Serialize(JsonObject doc) => doc.ToJsonString(Compact);
}

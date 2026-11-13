using System.Text.Json;
using System.Text.Json.Nodes;

namespace Bottleneck.Schema;

/// <summary>
/// One step in the migration chain: turns a document of <see cref="FromVersion"/> into FromVersion + 1.
/// Migrations are pure functions of the document; they must not read the clock or the database.
/// </summary>
public interface IDocumentMigration
{
    DocumentKind Kind { get; }
    int FromVersion { get; }
    JsonObject Migrate(JsonObject document);
}

public enum MigrationStatus
{
    /// <summary>The document is valid and at the current schemaVersion.</summary>
    Ok,
    /// <summary>schemaVersion is missing or not an integer.</summary>
    MissingVersion,
    /// <summary>schemaVersion is newer than this build knows: rejected, never guessed.</summary>
    TooNew,
    /// <summary>schemaVersion is older than any version this build has a schema for.</summary>
    Unknown,
    /// <summary>The document failed validation before (against its own version) or after migration.</summary>
    Invalid,
}

public sealed record MigrationResult(MigrationStatus Status, JsonObject? Document, int FromVersion, IReadOnlyList<SchemaError> Errors)
{
    public bool Ok => Status == MigrationStatus.Ok;
}

/// <summary>
/// Brings any stored or submitted document to the current schemaVersion (spec section 8, review D5):
/// validate against the document's own version, apply the ordered chain v → v+1 → … → current,
/// then validate again against the current schema. With schemaVersion 1 the chain is empty (identity).
/// </summary>
public sealed class DocumentMigrator
{
    private readonly IDocumentSchemaValidator _validator;
    private readonly Dictionary<(DocumentKind, int), IDocumentMigration> _steps = [];

    public DocumentMigrator(IDocumentSchemaValidator validator, IEnumerable<IDocumentMigration> migrations)
    {
        _validator = validator;
        foreach (var m in migrations.OrderBy(m => m.Kind).ThenBy(m => m.FromVersion))
        {
            if (m.FromVersion < 1 || m.FromVersion >= validator.CurrentVersion)
                throw new InvalidOperationException($"Migration {m.Kind} v{m.FromVersion} is outside 1..{validator.CurrentVersion - 1}.");
            if (!_steps.TryAdd((m.Kind, m.FromVersion), m))
                throw new InvalidOperationException($"Two migrations for {m.Kind} v{m.FromVersion}.");
        }
        // The chain must be complete from the oldest known version up to the current one.
        foreach (var kind in Enum.GetValues<DocumentKind>())
        {
            for (var v = 1; v < validator.CurrentVersion; v++)
            {
                if (validator.KnowsVersion(kind, v) && !_steps.ContainsKey((kind, v)))
                    throw new InvalidOperationException($"Missing migration for {kind} v{v} → v{v + 1}.");
            }
        }
    }

    public int CurrentVersion => _validator.CurrentVersion;

    /// <summary>Reads schemaVersion without validating anything else.</summary>
    public static int? ReadVersion(JsonObject document) =>
        document["schemaVersion"] is JsonValue v && v.GetValueKind() == JsonValueKind.Number && v.TryGetValue<int>(out var n) ? n : null;

    public MigrationResult Process(DocumentKind kind, JsonObject document)
    {
        var version = ReadVersion(document);
        if (version is null)
            return new(MigrationStatus.MissingVersion, null, 0, [new SchemaError("/schemaVersion", "schemaVersion must be an integer.")]);
        var from = version.Value;
        if (from > CurrentVersion)
            return new(MigrationStatus.TooNew, null, from, [new SchemaError("/schemaVersion", $"schemaVersion {from} is newer than this server knows ({CurrentVersion}).")]);
        if (!_validator.KnowsVersion(kind, from))
            return new(MigrationStatus.Unknown, null, from, [new SchemaError("/schemaVersion", $"schemaVersion {from} is not a known {kind} version.")]);

        var before = _validator.Validate(kind, from, document);
        if (!before.IsValid) return new(MigrationStatus.Invalid, null, from, before.Errors);

        var current = document;
        for (var v = from; v < CurrentVersion; v++)
        {
            current = _steps[(kind, v)].Migrate((JsonObject)current.DeepClone());
            current["schemaVersion"] = v + 1;
        }
        if (from != CurrentVersion)
        {
            var after = _validator.Validate(kind, CurrentVersion, current);
            if (!after.IsValid) return new(MigrationStatus.Invalid, null, from, after.Errors);
        }
        return new(MigrationStatus.Ok, current, from, []);
    }
}

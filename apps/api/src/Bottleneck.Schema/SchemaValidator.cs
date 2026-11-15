using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;

namespace Bottleneck.Schema;

/// <summary>The three stored document types, one JSON Schema each.</summary>
public enum DocumentKind
{
    Venue,
    Scenario,
    Run,
}

/// <summary>One schema error: where in the document (JSON Pointer) and what is wrong.</summary>
public sealed record SchemaError(string Path, string Message);

/// <summary>The result of validating one document.</summary>
public sealed record ValidationOutcome(bool IsValid, IReadOnlyList<SchemaError> Errors)
{
    public static readonly ValidationOutcome Valid = new(true, []);
}

/// <summary>Validates documents against the schema of a given schemaVersion.</summary>
public interface IDocumentSchemaValidator
{
    /// <summary>The newest schemaVersion this build knows.</summary>
    int CurrentVersion { get; }

    /// <summary>True if a schema for this version is available (old versions are kept for validate-before-migrate).</summary>
    bool KnowsVersion(DocumentKind kind, int version);

    ValidationOutcome Validate(DocumentKind kind, int version, JsonNode document);
}

/// <summary>
/// Validates against the very files in /schema (embedded at build time, not copied), with JsonSchema.Net.
/// Format keywords (date-time) are asserted, like ajv-formats on the TypeScript side.
/// </summary>
public sealed class JsonSchemaValidator : IDocumentSchemaValidator
{
    /// <summary>The schemaVersion of the files in /schema. Must match their "schemaVersion": {"const": N}.</summary>
    public const int SchemaVersion = 1;

    /// <summary>The schema files in /schema, in dependency order.</summary>
    public static readonly IReadOnlyList<string> SchemaFiles = ["common.schema.json", "scenario.schema.json", "venue.schema.json", "run.schema.json"];

    private const int MaxErrors = 50;
    private static readonly Uri BaseUri = new("https://bottleneck.invalid/schema/");

    private readonly Dictionary<(DocumentKind, int), JsonSchema> _schemas = [];
    private readonly EvaluationOptions _evaluation = new()
    {
        OutputFormat = OutputFormat.List,
        RequireFormatValidation = true,
    };

    public JsonSchemaValidator()
    {
        // A private registry, so nothing is fetched from the network and nothing leaks into the global one.
        var registry = new SchemaRegistry();
        var build = new BuildOptions { SchemaRegistry = registry };
        var byFile = new Dictionary<string, JsonSchema>(StringComparer.Ordinal);
        foreach (var file in SchemaFiles)
        {
            var schema = JsonSchema.FromText(ReadEmbedded(file), build, new Uri(BaseUri, file));
            byFile[file] = schema;
        }
        _schemas[(DocumentKind.Venue, SchemaVersion)] = byFile["venue.schema.json"];
        _schemas[(DocumentKind.Scenario, SchemaVersion)] = byFile["scenario.schema.json"];
        _schemas[(DocumentKind.Run, SchemaVersion)] = byFile["run.schema.json"];
        // When schemaVersion 2 arrives, the v1 files are kept under schema/v1/ and registered here
        // with their own base URI, so old documents can still be validated before they are migrated.
    }

    public int CurrentVersion => SchemaVersion;

    public bool KnowsVersion(DocumentKind kind, int version) => _schemas.ContainsKey((kind, version));

    public ValidationOutcome Validate(DocumentKind kind, int version, JsonNode document)
    {
        if (!_schemas.TryGetValue((kind, version), out var schema))
        {
            return new ValidationOutcome(false, [new SchemaError("/schemaVersion", $"No {kind} schema for schemaVersion {version}.")]);
        }
        var element = JsonSerializer.SerializeToElement(document);
        var results = schema.Evaluate(element, _evaluation);
        if (results.IsValid) return ValidationOutcome.Valid;

        var errors = new List<SchemaError>();
        foreach (var detail in results.Details ?? [])
        {
            if (detail.IsValid || detail.Errors is null) continue;
            foreach (var (keyword, message) in detail.Errors.OrderBy(e => e.Key, StringComparer.Ordinal))
            {
                errors.Add(new SchemaError(detail.InstanceLocation.ToString(), $"{message} ({keyword})"));
                if (errors.Count >= MaxErrors) break;
            }
            if (errors.Count >= MaxErrors) break;
        }
        if (errors.Count == 0) errors.Add(new SchemaError("", "The document does not match the schema."));
        return new ValidationOutcome(false, errors);
    }

    /// <summary>Reads one of the embedded /schema files (also used by tests to compare with the repository copy).</summary>
    public static string ReadEmbedded(string file)
    {
        var assembly = typeof(JsonSchemaValidator).GetTypeInfo().Assembly;
        using var stream = assembly.GetManifestResourceStream("schema/" + file)
            ?? throw new InvalidOperationException($"Embedded schema {file} is missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}

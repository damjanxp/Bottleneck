// Generates C# classes from the JSON Schemas in /schema (spec section 8, "Shared schema").
//
//   dotnet run --project apps/api/tools/Bottleneck.SchemaGen            write the generated file
//   dotnet run --project apps/api/tools/Bottleneck.SchemaGen -- --check fail if it is out of date (CI)
//
// npm wrappers: `npm run api:schema:gen` and `npm run api:schema:check`.
// The output is deterministic: same schema + same NJsonSchema version = same bytes (LF line endings).

using NJsonSchema;
using NJsonSchema.CodeGeneration.CSharp;

var check = args.Contains("--check");
var root = FindRepoRoot(AppContext.BaseDirectory) ?? FindRepoRoot(Directory.GetCurrentDirectory())
    ?? throw new InvalidOperationException("Could not find the repository root (a folder with schema/common.schema.json).");
var schemaDir = Path.Combine(root, "schema");
var outFile = Path.Combine(root, "apps", "api", "src", "Bottleneck.Schema", "Generated", "SchemaTypes.g.cs");

// One synthetic root that references every document type, so shared definitions are emitted once
// (the same trick as tools/generate-schema-types.mjs). It is never written to disk: documentPath only
// gives NJsonSchema a base for resolving the relative $refs.
const string bundle = """
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "SchemaBundle",
  "description": "Every document type in /schema. Generated only to emit all types into one file.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "venue": { "$ref": "venue.schema.json" },
    "scenario": { "$ref": "scenario.schema.json" },
    "run": { "$ref": "run.schema.json" }
  }
}
""";

var schema = await JsonSchema.FromJsonAsync(bundle, Path.Combine(schemaDir, "bundle.schema.json"));

// NJsonSchema cannot express the schema's tagged unions (pure "oneOf" definitions such as Distribution
// and TimedEvent): it references classes it never emits. Those definitions are turned into "any" here,
// so they become `object` (a JsonElement when read with System.Text.Json). The API stores and validates
// documents as JSON anyway; the generated classes are only for typed reading of the plain parts.
var unions = new List<string>();
WidenUnions(schema, new HashSet<JsonSchema>(ReferenceEqualityComparer.Instance), unions);
var settings = new CSharpGeneratorSettings
{
    Namespace = "Bottleneck.Schema.Generated",
    JsonLibrary = CSharpJsonLibrary.SystemTextJson,
    ClassStyle = CSharpClassStyle.Poco,
    GenerateDataAnnotations = false,
    GenerateNullableReferenceTypes = true,
    GenerateOptionalPropertiesAsNullable = true,
    ArrayType = "System.Collections.Generic.List",
    ArrayInstanceType = "System.Collections.Generic.List",
    DictionaryType = "System.Collections.Generic.Dictionary",
    DictionaryInstanceType = "System.Collections.Generic.Dictionary",
    TypeAccessModifier = "public",
};

var code = new CSharpGenerator(schema, settings).GenerateFile();
var output = "// GENERATED FILE - do not edit by hand.\n"
    + "// Source: /schema/*.schema.json. Regenerate with: npm run api:schema:gen\n"
    + "#pragma warning disable\n"
    + "#nullable enable\n"
    + code.Replace("\r\n", "\n", StringComparison.Ordinal).TrimEnd() + "\n";

var relative = Path.GetRelativePath(root, outFile).Replace('\\', '/');
if (check)
{
    var current = File.Exists(outFile) ? File.ReadAllText(outFile).Replace("\r\n", "\n", StringComparison.Ordinal) : "";
    if (current != output)
    {
        Console.Error.WriteLine($"{relative} is out of date. Run: npm run api:schema:gen");
        return 1;
    }
    Console.WriteLine("C# schema classes are up to date.");
    return 0;
}

Directory.CreateDirectory(Path.GetDirectoryName(outFile)!);
File.WriteAllText(outFile, output, new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
Console.WriteLine($"Wrote {relative}");
return 0;

static void WidenUnions(JsonSchema s, HashSet<JsonSchema> seen, List<string> unions)
{
    if (!seen.Add(s)) return;
    var children = new List<JsonSchema>();
    if (s.Reference is not null) children.Add(s.Reference);
    children.AddRange(s.Definitions.Values);
    children.AddRange(s.Properties.Values);
    children.AddRange(s.OneOf);
    children.AddRange(s.AnyOf);
    children.AddRange(s.AllOf);
    if (s.Item is not null) children.Add(s.Item);
    children.AddRange(s.Items);
    if (s.AdditionalPropertiesSchema is not null) children.Add(s.AdditionalPropertiesSchema);
    foreach (var c in children) WidenUnions(c, seen, unions);

    if (s.OneOf.Count > 0 && s.Properties.Count == 0 && s.Type == JsonObjectType.None)
    {
        unions.Add(s.Title ?? "(untitled)");
        s.OneOf.Clear();
    }
}

static string? FindRepoRoot(string start)
{
    for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
    {
        if (File.Exists(Path.Combine(dir.FullName, "schema", "common.schema.json"))) return dir.FullName;
    }
    return null;
}

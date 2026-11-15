using System.Text.Json;
using System.Text.Json.Nodes;
using Bottleneck.Api.Tests.Infrastructure;
using Bottleneck.Schema;
using Generated = Bottleneck.Schema.Generated;

namespace Bottleneck.Api.Tests;

/// <summary>
/// The .NET side of the shared fixtures (spec section 8: "Shared fixture files are loaded by both test suites").
/// The TypeScript twin is packages/schema/test/schema.test.ts. No database needed.
/// </summary>
public sealed class SchemaTests
{
    private static readonly JsonSchemaValidator Validator = new();

    private static DocumentKind KindFor(string schemaFile) => schemaFile switch
    {
        "venue.schema.json" => DocumentKind.Venue,
        "scenario.schema.json" => DocumentKind.Scenario,
        _ => DocumentKind.Run,
    };

    public static TheoryData<string> ValidFiles() => [.. Fixtures.ValidFiles()];

    public static TheoryData<string> InvalidCases() => [.. Fixtures.InvalidCases().Select(c => c.Why)];

    [Theory]
    [MemberData(nameof(ValidFiles))]
    public void Valid_fixture_passes(string file)
    {
        var outcome = Validator.Validate(KindFor(Fixtures.SchemaFor(file)), JsonSchemaValidator.SchemaVersion, Fixtures.Load("valid/" + file));
        Assert.True(outcome.IsValid, string.Join("\n", outcome.Errors.Select(e => $"{e.Path}: {e.Message}")));
    }

    [Theory]
    [MemberData(nameof(InvalidCases))]
    public void Invalid_fixture_fails(string why)
    {
        var c = Fixtures.InvalidCases().Single(x => x.Why == why);
        var outcome = Validator.Validate(KindFor(c.Schema), JsonSchemaValidator.SchemaVersion, Fixtures.Apply(c));
        Assert.False(outcome.IsValid);
        Assert.NotEmpty(outcome.Errors);
    }

    [Fact]
    public void Every_schema_declares_the_version_the_validator_knows()
    {
        foreach (var file in new[] { "venue.schema.json", "scenario.schema.json", "run.schema.json" })
        {
            var schema = JsonNode.Parse(JsonSchemaValidator.ReadEmbedded(file))!;
            Assert.Equal(JsonSchemaValidator.SchemaVersion, (int)schema["properties"]!["schemaVersion"]!["const"]!);
        }
    }

    [Fact]
    public void Format_keywords_are_asserted_like_ajv_formats()
    {
        var run = Fixtures.Run();
        run["createdAt"] = "yesterday";
        Assert.False(Validator.Validate(DocumentKind.Run, 1, run).IsValid);
    }

    [Fact]
    public void Errors_point_at_the_offending_value()
    {
        var c = Fixtures.InvalidCases().First(x => x.Patch.ContainsKey("carShare"));
        var outcome = Validator.Validate(DocumentKind.Scenario, 1, Fixtures.Apply(c));
        Assert.Contains(outcome.Errors, e => e.Path == "/carShare");
    }

    /// <summary>The generated C# classes read the fixtures (the C# counterpart of the TS "type-check against the generated types").</summary>
    [Fact]
    public void Generated_classes_read_the_fixtures()
    {
        var venue = Fixtures.Venue().Deserialize<Generated.Venue>()!;
        Assert.Equal(4, venue.GateGroups[0].LaneCount);
        var scenario = Fixtures.Scenario().Deserialize<Generated.Scenario>()!;
        Assert.Equal(venue.Id, scenario.VenueId);
        var run = Fixtures.Run().Deserialize<Generated.Run>()!;
        Assert.Equal(Generated.RunOrigin.ClientReported, run.Origin);
        Assert.Equal(run.Scenario.VenueId, venue.Id);
    }
}

public sealed class MigratorTests
{
    [Fact]
    public void Version_1_is_the_identity()
    {
        var migrator = new DocumentMigrator(new JsonSchemaValidator(), []);
        var doc = Fixtures.Venue();
        var result = migrator.Process(DocumentKind.Venue, doc);
        Assert.True(result.Ok);
        Assert.True(JsonNode.DeepEquals(Fixtures.Venue(), result.Document));
    }

    [Fact]
    public void Newer_version_is_rejected_before_validation()
    {
        var migrator = new DocumentMigrator(new JsonSchemaValidator(), []);
        var doc = Fixtures.Venue();
        doc["schemaVersion"] = 2;
        Assert.Equal(MigrationStatus.TooNew, migrator.Process(DocumentKind.Venue, doc).Status);
    }

    [Theory]
    [InlineData("\"1\"")]
    [InlineData("1.5")]
    [InlineData("null")]
    public void Version_must_be_an_integer(string json)
    {
        var migrator = new DocumentMigrator(new JsonSchemaValidator(), []);
        var doc = Fixtures.Venue();
        doc["schemaVersion"] = JsonNode.Parse(json);
        Assert.Equal(MigrationStatus.MissingVersion, migrator.Process(DocumentKind.Venue, doc).Status);
    }

    [Fact]
    public void Version_0_is_unknown()
    {
        var migrator = new DocumentMigrator(new JsonSchemaValidator(), []);
        var doc = Fixtures.Venue();
        doc["schemaVersion"] = 0;
        Assert.Equal(MigrationStatus.Unknown, migrator.Process(DocumentKind.Venue, doc).Status);
    }

    // A pretend world with schema versions 1..3, to test the chain machinery before a real v2 exists.
    private sealed class FakeValidator(int current, Func<int, JsonNode, bool> isValid) : IDocumentSchemaValidator
    {
        public int CurrentVersion => current;
        public bool KnowsVersion(DocumentKind kind, int version) => version >= 1 && version <= current;
        public ValidationOutcome Validate(DocumentKind kind, int version, JsonNode document) =>
            isValid(version, document) ? ValidationOutcome.Valid : new ValidationOutcome(false, [new SchemaError("", $"invalid for v{version}")]);
    }

    private sealed class Step(int from, Action<JsonObject> apply) : IDocumentMigration
    {
        public DocumentKind Kind => DocumentKind.Venue;
        public int FromVersion => from;
        public JsonObject Migrate(JsonObject document)
        {
            apply(document);
            return document;
        }
    }

    private static readonly IDocumentMigration[] Chain =
    [
        new Step(2, d => d["trail"] = (string)d["trail"]! + ">3"),
        new Step(1, d => d["trail"] = (string)d["trail"]! + ">2"),
    ];

    private static IDocumentMigration[] OtherKinds() => [.. new[] { DocumentKind.Scenario, DocumentKind.Run }
        .SelectMany(k => new[] { 1, 2 }.Select(v => (IDocumentMigration)new KindStep(k, v)))];

    private sealed class KindStep(DocumentKind kind, int from) : IDocumentMigration
    {
        public DocumentKind Kind => kind;
        public int FromVersion => from;
        public JsonObject Migrate(JsonObject document) => document;
    }

    [Fact]
    public void Chain_runs_in_order_and_sets_the_version()
    {
        var migrator = new DocumentMigrator(new FakeValidator(3, (_, _) => true), [.. Chain, .. OtherKinds()]);
        var result = migrator.Process(DocumentKind.Venue, new JsonObject { ["schemaVersion"] = 1, ["trail"] = "1" });
        Assert.True(result.Ok);
        Assert.Equal("1>2>3", (string)result.Document!["trail"]!);
        Assert.Equal(3, (int)result.Document["schemaVersion"]!);
        Assert.Equal(1, result.FromVersion);
    }

    [Fact]
    public void Validates_before_migrating()
    {
        var migrator = new DocumentMigrator(new FakeValidator(3, (v, _) => v != 1), [.. Chain, .. OtherKinds()]);
        var result = migrator.Process(DocumentKind.Venue, new JsonObject { ["schemaVersion"] = 1, ["trail"] = "1" });
        Assert.Equal(MigrationStatus.Invalid, result.Status);
        Assert.Contains("v1", result.Errors[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Validates_again_after_migrating()
    {
        var migrator = new DocumentMigrator(new FakeValidator(3, (v, _) => v != 3), [.. Chain, .. OtherKinds()]);
        var result = migrator.Process(DocumentKind.Venue, new JsonObject { ["schemaVersion"] = 1, ["trail"] = "1" });
        Assert.Equal(MigrationStatus.Invalid, result.Status);
        Assert.Contains("v3", result.Errors[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Missing_link_in_the_chain_fails_at_startup()
    {
        var ex = Assert.Throws<InvalidOperationException>(() =>
            new DocumentMigrator(new FakeValidator(3, (_, _) => true), [Chain[1], .. OtherKinds()]));
        Assert.Contains("v2", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Duplicate_step_fails_at_startup() =>
        Assert.Throws<InvalidOperationException>(() =>
            new DocumentMigrator(new FakeValidator(3, (_, _) => true), [.. Chain, Chain[0], .. OtherKinds()]));
}

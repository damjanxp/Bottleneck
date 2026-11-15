using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Bottleneck.Api.Tests.Infrastructure;

/// <summary>The shared fixtures in /schema/fixtures, copied next to the test assembly by the project file.</summary>
public static class Fixtures
{
    public static string Dir { get; } = Path.Combine(AppContext.BaseDirectory, "fixtures");

    public static JsonObject Load(string relative) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, relative)))!.AsObject();

    public static JsonObject Venue() => Load("valid/venue-minimal.json");

    public static JsonObject Scenario() => Load("valid/scenario-minimal.json");

    public static JsonObject Run() => Load("valid/run-minimal.json");

    public static IEnumerable<string> ValidFiles() =>
        Directory.GetFiles(Path.Combine(Dir, "valid"), "*.json").Select(Path.GetFileName).Order(StringComparer.Ordinal)!;

    /// <summary>The schema a valid fixture belongs to, by file name (the same rule as packages/schema/test/schema.test.ts).</summary>
    public static string SchemaFor(string file) =>
        file.StartsWith("venue", StringComparison.Ordinal) ? "venue.schema.json"
        : file.StartsWith("scenario", StringComparison.Ordinal) ? "scenario.schema.json"
        : "run.schema.json";

    public sealed record InvalidCase(string Why, string Schema, JsonObject Patch);

    public static IReadOnlyList<InvalidCase> InvalidCases() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(Dir, "invalid", "cases.json")))!.AsArray()
            .Select(n => new InvalidCase((string)n!["why"]!, (string)n["schema"]!, n["patch"]!.AsObject()))
            .ToList();

    /// <summary>{ ...base, ...patch }: a shallow merge, exactly like the TypeScript test.</summary>
    public static JsonObject Apply(InvalidCase c)
    {
        var doc = c.Schema == "venue.schema.json" ? Venue() : Scenario();
        foreach (var (k, v) in c.Patch) doc[k] = v?.DeepClone();
        return doc;
    }
}

public sealed record CreatedVenue(string Id, string ReadToken, string EditKey, string ETag, JsonObject Body);

/// <summary>Small helpers over HttpClient for the API's routes.</summary>
public static class Http
{
    public static StringContent Json(JsonNode node) => new(node.ToJsonString(), Encoding.UTF8, "application/json");

    public static async Task<CreatedVenue> CreateVenueAsync(this HttpClient client, JsonObject? doc = null)
    {
        var response = await client.PostAsync("/api/venues", Json(doc ?? Fixtures.Venue()));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        return new CreatedVenue((string)body["id"]!, (string)body["readToken"]!, (string)body["editKey"]!, response.Headers.ETag!.Tag, body);
    }

    public static HttpRequestMessage Request(HttpMethod method, string url, string? editKey = null, string? readToken = null, HttpContent? content = null, string? ifMatch = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = content };
        if (editKey is not null) request.Headers.Add("X-Edit-Key", editKey);
        if (readToken is not null) request.Headers.Add("X-Read-Token", readToken);
        if (ifMatch is not null) request.Headers.IfMatch.Add(EntityTagHeaderValue.Parse(ifMatch));
        return request;
    }

    public static async Task<JsonObject> ProblemAsync(HttpResponseMessage response, HttpStatusCode expected)
    {
        Assert.Equal(expected, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var problem = JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsObject();
        Assert.Equal((int)expected, (int)problem["status"]!);
        Assert.False(string.IsNullOrEmpty((string?)problem["title"]));
        return problem;
    }

    public static string? Type(this JsonObject problem) => (string?)problem["type"];

    public static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
}

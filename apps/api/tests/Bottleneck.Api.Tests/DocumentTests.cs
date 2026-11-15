using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Bottleneck.Api.Tests.Infrastructure;

namespace Bottleneck.Api.Tests;

/// <summary>Writes are validated against /schema with the shared fixtures; size caps; optimistic concurrency.</summary>
public sealed class DocumentTests(DefaultApi api) : IClassFixture<DefaultApi>
{
    private readonly HttpClient _client = api.Factory.CreateClient();

    public static TheoryData<string> InvalidCases() => [.. Fixtures.InvalidCases().Select(c => c.Why)];

    [Fact]
    public async Task Every_valid_fixture_is_accepted_through_the_api()
    {
        foreach (var file in Fixtures.ValidFiles())
        {
            var doc = Fixtures.Load("valid/" + file);
            switch (Fixtures.SchemaFor(file))
            {
                case "venue.schema.json":
                    await _client.CreateVenueAsync(doc);
                    break;
                case "scenario.schema.json":
                {
                    var v = await _client.CreateVenueAsync();
                    var r = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(doc)));
                    Assert.Equal(HttpStatusCode.Created, r.StatusCode);
                    break;
                }
                default:
                {
                    var v = await _client.CreateVenueAsync();
                    var r = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/runs", editKey: v.EditKey, content: Http.Json(doc)));
                    Assert.Equal(HttpStatusCode.Created, r.StatusCode);
                    break;
                }
            }
        }
    }

    [Theory]
    [MemberData(nameof(InvalidCases))]
    public async Task Every_invalid_fixture_is_rejected_through_the_api(string why)
    {
        var c = Fixtures.InvalidCases().Single(x => x.Why == why);
        var doc = Fixtures.Apply(c);
        HttpResponseMessage response;
        if (c.Schema == "venue.schema.json")
        {
            response = await _client.PostAsync("/api/venues", Http.Json(doc));
        }
        else
        {
            var v = await _client.CreateVenueAsync();
            response = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(doc)));
        }
        var problem = await Http.ProblemAsync(response, HttpStatusCode.UnprocessableEntity);
        Assert.True(problem.Type()!.EndsWith("schema-invalid", StringComparison.Ordinal) || problem.Type()!.EndsWith("schema-version-too-new", StringComparison.Ordinal), problem.Type());
    }

    [Fact]
    public async Task Schema_errors_are_listed_by_json_pointer()
    {
        var doc = Fixtures.Venue();
        doc["colour"] = "red";
        var problem = await Http.ProblemAsync(await _client.PostAsync("/api/venues", Http.Json(doc)), HttpStatusCode.UnprocessableEntity);
        Assert.IsType<JsonObject>(problem["errors"]);
        Assert.NotEmpty(problem["errors"]!.AsObject());
        Assert.NotNull(problem["traceId"]);
    }

    [Fact]
    public async Task A_newer_schema_version_is_rejected_with_a_clear_message()
    {
        var doc = Fixtures.Venue();
        doc["schemaVersion"] = 7;
        var problem = await Http.ProblemAsync(await _client.PostAsync("/api/venues", Http.Json(doc)), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("schema-version-too-new", problem.Type(), StringComparison.Ordinal);
        Assert.Contains("newer", (string)problem["detail"]!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Malformed_and_mistyped_bodies_are_rejected()
    {
        await Http.ProblemAsync(await _client.PostAsync("/api/venues", new StringContent("{\"schemaVersion\": 1,", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);
        await Http.ProblemAsync(await _client.PostAsync("/api/venues", new StringContent("[1,2,3]", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);
        await Http.ProblemAsync(await _client.PostAsync("/api/venues", new StringContent(Fixtures.Venue().ToJsonString(), Encoding.UTF8, "text/plain")), HttpStatusCode.UnsupportedMediaType);
    }

    [Fact]
    public async Task Size_depth_and_node_caps_apply_before_validation()
    {
        // Over 1 MB.
        var big = Fixtures.Venue();
        big["description"] = new string('x', 1024 * 1024 + 10);
        await Http.ProblemAsync(await _client.PostAsync("/api/venues", Http.Json(big)), HttpStatusCode.RequestEntityTooLarge);

        // Nested deeper than 32.
        var deep = new StringBuilder("{\"schemaVersion\":1,\"x\":");
        for (var i = 0; i < 40; i++) deep.Append('[');
        for (var i = 0; i < 40; i++) deep.Append(']');
        deep.Append('}');
        await Http.ProblemAsync(await _client.PostAsync("/api/venues", new StringContent(deep.ToString(), Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest);

        // More than 200,000 JSON values in under 1 MB.
        var many = "{\"schemaVersion\":1,\"x\":[" + string.Join(",", Enumerable.Repeat("0", 200_001)) + "]}";
        var problem = await Http.ProblemAsync(await _client.PostAsync("/api/venues", new StringContent(many, Encoding.UTF8, "application/json")), HttpStatusCode.RequestEntityTooLarge);
        Assert.Contains("200000", (string)problem["detail"]!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Concurrent_venue_updates_are_detected()
    {
        var v = await _client.CreateVenueAsync();
        var url = $"/api/venues/{v.Id}";
        Assert.Equal("\"1\"", v.ETag);

        // Without If-Match: refused, nothing is silently overwritten.
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Put, url, editKey: v.EditKey, content: Http.Json(Fixtures.Venue()))), (HttpStatusCode)428);

        // Two tabs read revision 1; the first save wins, the second gets 412.
        var tab1 = Fixtures.Venue();
        tab1["name"] = "Tab one";
        var first = await _client.SendAsync(Http.Request(HttpMethod.Put, url, editKey: v.EditKey, content: Http.Json(tab1), ifMatch: v.ETag));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal("\"2\"", first.Headers.ETag!.Tag);

        var tab2 = Fixtures.Venue();
        tab2["name"] = "Tab two";
        var second = await _client.SendAsync(Http.Request(HttpMethod.Put, url, editKey: v.EditKey, content: Http.Json(tab2), ifMatch: v.ETag));
        var problem = await Http.ProblemAsync(second, HttpStatusCode.PreconditionFailed);
        Assert.EndsWith("concurrent-update", problem.Type(), StringComparison.Ordinal);

        var now = (await (await _client.SendAsync(Http.Request(HttpMethod.Get, url, editKey: v.EditKey))).Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("Tab one", (string)now["name"]!);
        Assert.Equal(2, (long)now["revision"]!);
    }

    [Fact]
    public async Task Simultaneous_updates_with_the_same_etag_let_exactly_one_through()
    {
        var v = await _client.CreateVenueAsync();
        var results = await Task.WhenAll(Enumerable.Range(0, 6).Select(i =>
        {
            var doc = Fixtures.Venue();
            doc["name"] = $"Writer {i}";
            return _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: v.EditKey, content: Http.Json(doc), ifMatch: v.ETag));
        }));
        Assert.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.OK));
        Assert.Equal(5, results.Count(r => r.StatusCode == HttpStatusCode.PreconditionFailed));
    }

    [Fact]
    public async Task Scenarios_crud_with_server_ids_and_concurrency()
    {
        var v = await _client.CreateVenueAsync();
        var create = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(Fixtures.Scenario())));
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var s = (await create.Content.ReadFromJsonAsync<JsonObject>())!;
        var sid = (string)s["id"]!;
        Assert.Equal(v.Id, (string)s["document"]!["venueId"]!); // the fixture's venueId is replaced by the real one
        Assert.Equal(sid, (string)s["document"]!["id"]!);

        var list = (await (await _client.GetAsync($"/api/venues/{v.Id}/scenarios?t={v.ReadToken}")).Content.ReadFromJsonAsync<JsonArray>())!;
        Assert.Single(list);
        Assert.Null(list[0]!["document"]);

        var url = $"/api/venues/{v.Id}/scenarios/{sid}";
        var etag = create.Headers.ETag!.Tag;
        var edited = Fixtures.Scenario();
        edited["attendance"] = 5000;
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(Http.Request(HttpMethod.Put, url, editKey: v.EditKey, content: Http.Json(edited), ifMatch: etag))).StatusCode);
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Put, url, editKey: v.EditKey, content: Http.Json(edited), ifMatch: etag)), HttpStatusCode.PreconditionFailed);
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Put, url, editKey: v.EditKey, content: Http.Json(edited))), (HttpStatusCode)428);

        var read = (await (await _client.GetAsync($"{url}?t={v.ReadToken}")).Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal(5000, (int)read["document"]!["attendance"]!);

        // Another venue's key cannot touch it, nor can its id be reached through another venue.
        var other = await _client.CreateVenueAsync();
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{other.Id}/scenarios/{sid}", editKey: other.EditKey)), HttpStatusCode.NotFound);

        Assert.Equal(HttpStatusCode.NoContent, (await _client.SendAsync(Http.Request(HttpMethod.Delete, url, editKey: v.EditKey))).StatusCode);
        await Http.ProblemAsync(await _client.GetAsync($"{url}?t={v.ReadToken}"), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Client_reported_runs_are_validated_and_capped()
    {
        var v = await _client.CreateVenueAsync();
        var url = $"/api/venues/{v.Id}/runs";

        var create = await _client.SendAsync(Http.Request(HttpMethod.Post, url, editKey: v.EditKey, content: Http.Json(Fixtures.Run())));
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var run = (await create.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal("clientReported", (string)run["origin"]!);
        Assert.Equal((string)Fixtures.Run()["metricsHash"]!, (string)run["metricsHash"]!);
        Assert.Equal(42, (long)run["seed"]!);

        var detail = (await (await _client.GetAsync($"{url}/{run["id"]}?t={v.ReadToken}")).Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Equal((string)run["id"]!, (string)detail["record"]!["id"]!);

        // Only the job runner writes trusted runs.
        var job = Fixtures.Run();
        job["origin"] = "job";
        var problem = await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Post, url, editKey: v.EditKey, content: Http.Json(job))), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("origin-not-allowed", problem.Type(), StringComparison.Ordinal);

        // At most 256 KB.
        var big = Fixtures.Run();
        big["scenario"]!["name"] = "x";
        var padded = big.ToJsonString().Insert(1, $"\"pad\":\"{new string(' ', 256 * 1024)}\",");
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Post, url, editKey: v.EditKey,
            content: new StringContent(padded, Encoding.UTF8, "application/json"))), HttpStatusCode.RequestEntityTooLarge);

        // At most 50 per venue: 49 more fit, the 51st is refused.
        for (var i = 0; i < 49; i++)
            Assert.Equal(HttpStatusCode.Created, (await _client.SendAsync(Http.Request(HttpMethod.Post, url, editKey: v.EditKey, content: Http.Json(Fixtures.Run())))).StatusCode);
        var over = await _client.SendAsync(Http.Request(HttpMethod.Post, url, editKey: v.EditKey, content: Http.Json(Fixtures.Run())));
        Assert.EndsWith("limit-reached", (await Http.ProblemAsync(over, HttpStatusCode.Conflict)).Type(), StringComparison.Ordinal);

        var list = (await (await _client.GetAsync($"{url}?t={v.ReadToken}")).Content.ReadFromJsonAsync<JsonArray>())!;
        Assert.Equal(50, list.Count);

        // Deleting one frees a slot.
        Assert.Equal(HttpStatusCode.NoContent, (await _client.SendAsync(Http.Request(HttpMethod.Delete, $"{url}/{run["id"]}", editKey: v.EditKey))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _client.SendAsync(Http.Request(HttpMethod.Post, url, editKey: v.EditKey, content: Http.Json(Fixtures.Run())))).StatusCode);
    }

    [Fact]
    public async Task Runs_can_point_at_a_stored_scenario_only_of_the_same_venue()
    {
        var v = await _client.CreateVenueAsync();
        var s = (await (await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(Fixtures.Scenario())))).Content.ReadFromJsonAsync<JsonObject>())!;
        var ok = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/runs?scenarioId={s["id"]}", editKey: v.EditKey, content: Http.Json(Fixtures.Run())));
        Assert.Equal(HttpStatusCode.Created, ok.StatusCode);
        Assert.Equal((string)s["id"]!, (string)(await ok.Content.ReadFromJsonAsync<JsonObject>())!["scenarioId"]!);

        var other = await _client.CreateVenueAsync();
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{other.Id}/runs?scenarioId={s["id"]}", editKey: other.EditKey, content: Http.Json(Fixtures.Run()))), HttpStatusCode.NotFound);
    }
}

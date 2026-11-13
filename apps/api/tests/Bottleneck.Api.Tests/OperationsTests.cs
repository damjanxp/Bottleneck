using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Bottleneck.Api.Data;
using Bottleneck.Api.Infrastructure;
using Bottleneck.Api.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Bottleneck.Api.Tests;

/// <summary>Rate limits, global caps, retention, health, OpenAPI, CORS and ProblemDetails.</summary>
public sealed class OperationsTests(PostgresFixture postgres, DefaultApi api) : IClassFixture<DefaultApi>
{
    private readonly HttpClient _client = api.Factory.CreateClient();

    [Fact]
    public async Task Exceeding_a_rate_limit_returns_429()
    {
        await using var factory = new ApiFactory(postgres, new Dictionary<string, string?>
        {
            ["RateLimits:Writes:PermitLimit"] = "3",
            ["RateLimits:Writes:WindowSeconds"] = "60",
        });
        var client = factory.CreateClient();
        var v = await client.CreateVenueAsync();
        var statuses = new List<HttpStatusCode>();
        HttpResponseMessage? last = null;
        for (var i = 0; i < 4; i++)
        {
            last = await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/read-token", editKey: v.EditKey));
            statuses.Add(last.StatusCode);
        }
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], statuses);
        var problem = await Http.ProblemAsync(last!, HttpStatusCode.TooManyRequests);
        Assert.EndsWith("rate-limited", problem.Type(), StringComparison.Ordinal);
        Assert.True(last!.Headers.RetryAfter?.Delta > TimeSpan.Zero);

        // Reads are not counted against the write limit.
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", editKey: v.EditKey))).StatusCode);
    }

    [Fact]
    public async Task Creating_venues_has_its_own_stricter_limit()
    {
        await using var factory = new ApiFactory(postgres, new Dictionary<string, string?> { ["RateLimits:CreateVenue:PermitLimit"] = "2" });
        var client = factory.CreateClient();
        await client.CreateVenueAsync();
        await client.CreateVenueAsync();
        await Http.ProblemAsync(await client.PostAsync("/api/venues", Http.Json(Fixtures.Venue())), HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task The_global_venue_cap_applies()
    {
        await using var factory = new ApiFactory(postgres, new Dictionary<string, string?> { ["Limits:MaxVenues"] = "1" });
        var client = factory.CreateClient();
        await client.CreateVenueAsync();
        var problem = await Http.ProblemAsync(await client.PostAsync("/api/venues", Http.Json(Fixtures.Venue())), HttpStatusCode.InsufficientStorage);
        Assert.EndsWith("quota-exceeded", problem.Type(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Retention_deletes_only_abandoned_unpinned_venues()
    {
        var stale = await _client.CreateVenueAsync();
        var pinned = await _client.CreateVenueAsync();
        var fresh = await _client.CreateVenueAsync();
        Assert.Equal(HttpStatusCode.Created, (await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{stale.Id}/uploads", editKey: stale.EditKey, content: new ByteArrayContent(Images.Png())))).StatusCode);

        await using var scope = api.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var old = DateTimeOffset.UtcNow.AddDays(-200);
        await db.Venues.Where(v => v.Id == stale.Id || v.Id == pinned.Id).ExecuteUpdateAsync(s => s.SetProperty(v => v.LastActivityAt, old));
        await db.Venues.Where(v => v.Id == pinned.Id).ExecuteUpdateAsync(s => s.SetProperty(v => v.Pinned, true));

        var cleaner = scope.ServiceProvider.GetRequiredService<RetentionCleaner>();
        var deleted = await cleaner.RunOnceAsync(DateTimeOffset.UtcNow, CancellationToken.None);
        Assert.True(deleted >= 1);

        Assert.False(await db.Venues.AnyAsync(v => v.Id == stale.Id));
        Assert.False(await db.Uploads.AnyAsync(u => u.VenueId == stale.Id));
        Assert.False(Directory.Exists(Path.Combine(api.Factory.UploadPath, stale.Id)));
        Assert.True(await db.Venues.AnyAsync(v => v.Id == pinned.Id));
        Assert.True(await db.Venues.AnyAsync(v => v.Id == fresh.Id));
    }

    [Fact]
    public async Task Activity_in_a_venue_keeps_it_alive_without_changing_its_etag()
    {
        var v = await _client.CreateVenueAsync();
        await using var scope = api.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var old = DateTimeOffset.UtcNow.AddDays(-200);
        await db.Venues.Where(x => x.Id == v.Id).ExecuteUpdateAsync(s => s.SetProperty(x => x.LastActivityAt, old));

        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync($"/api/venues/{v.Id}?t={v.ReadToken}")).StatusCode);
        var venue = await db.Venues.AsNoTracking().SingleAsync(x => x.Id == v.Id);
        Assert.True(venue.LastActivityAt > DateTimeOffset.UtcNow.AddMinutes(-5));
        Assert.Equal(1, venue.Revision);

        Assert.Equal(HttpStatusCode.Created, (await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(Fixtures.Scenario())))).StatusCode);
        var put = await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: v.EditKey, content: Http.Json(Fixtures.Venue()), ifMatch: v.ETag));
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
    }

    [Fact]
    public async Task Health_endpoints_report_live_and_ready()
    {
        var live = await _client.GetAsync("/health");
        Assert.Equal(HttpStatusCode.OK, live.StatusCode);
        Assert.Equal("Healthy", await live.Content.ReadAsStringAsync());
        var ready = await _client.GetAsync("/health/ready");
        Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
        Assert.Equal("Healthy", await ready.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Readiness_fails_when_the_database_is_unreachable()
    {
        await using var factory = new ApiFactory(postgres, new Dictionary<string, string?>
        {
            ["ConnectionStrings:Bottleneck"] = "Host=127.0.0.1;Port=1;Database=none;Username=x;Password=x;Timeout=2",
            ["Database:MigrateOnStartup"] = "false",
        });
        var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.GetAsync("/health/ready")).StatusCode);
    }

    [Fact]
    public async Task OpenApi_document_and_interactive_reference_are_served()
    {
        var doc = await _client.GetAsync("/openapi/v1.json");
        Assert.Equal(HttpStatusCode.OK, doc.StatusCode);
        var json = (await doc.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.NotNull(json["paths"]!["/api/venues"]);
        Assert.NotNull(json["paths"]!["/api/venues/{venueId}/uploads"]);
        Assert.Equal("X-Edit-Key", (string)json["components"]!["securitySchemes"]!["editKey"]!["name"]!);

        var ui = await _client.GetAsync("/scalar");
        Assert.True(ui.StatusCode is HttpStatusCode.OK or HttpStatusCode.Redirect or HttpStatusCode.MovedPermanently, ui.StatusCode.ToString());
    }

    [Fact]
    public async Task Unknown_routes_and_bad_ids_are_problem_details()
    {
        var problem = await Http.ProblemAsync(await _client.GetAsync("/api/nothing-here"), HttpStatusCode.NotFound);
        Assert.NotNull(problem["traceId"]);
        await Http.ProblemAsync(await _client.GetAsync("/api/venues/../../etc/passwd"), HttpStatusCode.NotFound);
        await Http.ProblemAsync(await _client.GetAsync("/api/venues/" + new string('a', 26) + "?t=x"), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Cors_allows_only_the_configured_frontend()
    {
        HttpRequestMessage Preflight(string origin)
        {
            var r = new HttpRequestMessage(HttpMethod.Options, "/api/venues");
            r.Headers.Add("Origin", origin);
            r.Headers.Add("Access-Control-Request-Method", "PUT");
            r.Headers.Add("Access-Control-Request-Headers", "x-edit-key,if-match,content-type");
            return r;
        }
        var allowed = await _client.SendAsync(Preflight("https://frontend.test"));
        Assert.Equal("https://frontend.test", string.Join(",", allowed.Headers.GetValues("Access-Control-Allow-Origin")));
        Assert.False(allowed.Headers.Contains("Access-Control-Allow-Credentials"));
        var denied = await _client.SendAsync(Preflight("https://evil.test"));
        Assert.False(denied.Headers.Contains("Access-Control-Allow-Origin"));
    }
}

using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Bottleneck.Api.Tests.Infrastructure;

namespace Bottleneck.Api.Tests;

/// <summary>Sharing without logins (spec section 8, F19) and the Phase 4 checks on edit keys.</summary>
public sealed class SharingTests(DefaultApi api) : IClassFixture<DefaultApi>
{
    private readonly HttpClient _client = api.Factory.CreateClient();

    private static StringContent Doc() => Http.Json(Fixtures.Venue());

    [Fact]
    public async Task Create_returns_id_read_token_and_edit_key_once()
    {
        var response = await _client.PostAsync("/api/venues", Doc());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        var id = (string)body["id"]!;
        Assert.Matches("^[a-z2-7]{26}$", id);
        Assert.Equal(43, ((string)body["editKey"]!).Length);
        Assert.Equal(43, ((string)body["readToken"]!).Length);
        Assert.Equal(id, (string)body["document"]!["id"]!);
        Assert.Equal($"/api/venues/{id}", response.Headers.Location?.OriginalString);
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString(), StringComparison.Ordinal);

        // Reading it back never shows the edit key again.
        var read = await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{id}", editKey: (string)body["editKey"]!));
        var text = await read.Content.ReadAsStringAsync();
        Assert.DoesNotContain((string)body["editKey"]!, text, StringComparison.Ordinal);
        Assert.DoesNotContain("editKey", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Missing_edit_key_is_rejected()
    {
        var v = await _client.CreateVenueAsync();
        var response = await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", content: Doc(), ifMatch: v.ETag));
        var problem = await Http.ProblemAsync(response, HttpStatusCode.Unauthorized);
        Assert.EndsWith("credential-required", problem.Type(), StringComparison.Ordinal);
        Assert.Equal("X-Edit-Key", response.Headers.WwwAuthenticate.ToString());
    }

    [Fact]
    public async Task Wrong_edit_key_is_rejected()
    {
        var v = await _client.CreateVenueAsync();
        var other = await _client.CreateVenueAsync();
        foreach (var key in new[] { other.EditKey, v.EditKey[..^1] + (v.EditKey[^1] == 'A' ? 'B' : 'A'), "not-a-key", v.ReadToken })
        {
            var response = await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: key, content: Doc(), ifMatch: v.ETag));
            var problem = await Http.ProblemAsync(response, HttpStatusCode.Forbidden);
            Assert.EndsWith("credential-invalid", problem.Type(), StringComparison.Ordinal);
        }
        // The read token is not an edit key, whichever header it is sent in.
        var withToken = await _client.SendAsync(Http.Request(HttpMethod.Delete, $"/api/venues/{v.Id}", readToken: v.ReadToken));
        await Http.ProblemAsync(withToken, HttpStatusCode.Unauthorized);
        // The edit key is accepted only in X-Edit-Key, not in the query string.
        var inQuery = await _client.DeleteAsync($"/api/venues/{v.Id}?k={v.EditKey}");
        await Http.ProblemAsync(inQuery, HttpStatusCode.Unauthorized);
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", editKey: v.EditKey))).StatusCode);
    }

    [Fact]
    public async Task Rotating_the_key_invalidates_the_old_one()
    {
        var v = await _client.CreateVenueAsync();
        var rotate = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/edit-key", editKey: v.EditKey));
        Assert.Equal(HttpStatusCode.OK, rotate.StatusCode);
        var newKey = (string)(await rotate.Content.ReadFromJsonAsync<JsonObject>())!["editKey"]!;
        Assert.NotEqual(v.EditKey, newKey);

        var old = await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: v.EditKey, content: Doc(), ifMatch: v.ETag));
        await Http.ProblemAsync(old, HttpStatusCode.Forbidden);
        var again = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/edit-key", editKey: v.EditKey));
        await Http.ProblemAsync(again, HttpStatusCode.Forbidden);

        var ok = await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: newKey, content: Doc(), ifMatch: v.ETag));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    }

    [Fact]
    public async Task Concurrent_rotations_cannot_both_win()
    {
        var v = await _client.CreateVenueAsync();
        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ =>
            _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/edit-key", editKey: v.EditKey))));
        var winners = results.Where(r => r.StatusCode == HttpStatusCode.OK).ToList();
        Assert.Single(winners);
        Assert.All(results.Except(winners), r => Assert.True(r.StatusCode is HttpStatusCode.Conflict or HttpStatusCode.Forbidden, r.StatusCode.ToString()));
        var key = (string)(await winners[0].Content.ReadFromJsonAsync<JsonObject>())!["editKey"]!;
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", editKey: key))).StatusCode);
    }

    [Fact]
    public async Task Reads_need_the_read_token_or_the_edit_key()
    {
        var v = await _client.CreateVenueAsync();
        var url = $"/api/venues/{v.Id}";

        await Http.ProblemAsync(await _client.GetAsync(url), HttpStatusCode.Unauthorized);
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Get, url, readToken: "wrong")), HttpStatusCode.Forbidden);
        await Http.ProblemAsync(await _client.GetAsync($"{url}?t={v.ReadToken}x"), HttpStatusCode.Forbidden);

        var byHeader = await _client.SendAsync(Http.Request(HttpMethod.Get, url, readToken: v.ReadToken));
        Assert.Equal(HttpStatusCode.OK, byHeader.StatusCode);
        var body = (await byHeader.Content.ReadFromJsonAsync<JsonObject>())!;
        Assert.Null(body["readToken"]); // a reader does not learn anything new
        Assert.IsType<JsonObject>(body["document"]);
        Assert.Equal(v.ETag, byHeader.Headers.ETag!.Tag);

        Assert.Equal(HttpStatusCode.OK, (await _client.GetAsync($"{url}?t={v.ReadToken}")).StatusCode);

        var byKey = await _client.SendAsync(Http.Request(HttpMethod.Get, url, editKey: v.EditKey));
        Assert.Equal(v.ReadToken, (string)(await byKey.Content.ReadFromJsonAsync<JsonObject>())!["readToken"]!);

        // Scenarios and runs of the venue are protected the same way.
        await Http.ProblemAsync(await _client.GetAsync(url + "/scenarios"), HttpStatusCode.Unauthorized);
        await Http.ProblemAsync(await _client.GetAsync(url + "/runs"), HttpStatusCode.Unauthorized);
        await Http.ProblemAsync(await _client.GetAsync(url + "/uploads"), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_token_of_one_venue_does_not_open_another()
    {
        var a = await _client.CreateVenueAsync();
        var b = await _client.CreateVenueAsync();
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{b.Id}", readToken: a.ReadToken)), HttpStatusCode.Forbidden);
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{b.Id}", editKey: a.EditKey)), HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Regenerating_the_read_token_breaks_old_share_links()
    {
        var v = await _client.CreateVenueAsync();
        var response = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/read-token", editKey: v.EditKey));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var token = (string)(await response.Content.ReadFromJsonAsync<JsonObject>())!["readToken"]!;
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", readToken: v.ReadToken)), HttpStatusCode.Forbidden);
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", readToken: token))).StatusCode);
        // Regenerating needs the edit key, not the read token.
        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/read-token", readToken: token)), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Delete_removes_the_venue_and_everything_in_it()
    {
        var v = await _client.CreateVenueAsync();
        var scenario = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(Fixtures.Scenario())));
        Assert.Equal(HttpStatusCode.Created, scenario.StatusCode);
        var upload = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/uploads", editKey: v.EditKey, content: new ByteArrayContent(Images.Png())));
        Assert.Equal(HttpStatusCode.Created, upload.StatusCode);
        Assert.True(Directory.Exists(Path.Combine(api.Factory.UploadPath, v.Id)));

        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Delete, $"/api/venues/{v.Id}", readToken: v.ReadToken)), HttpStatusCode.Unauthorized);
        var delete = await _client.SendAsync(Http.Request(HttpMethod.Delete, $"/api/venues/{v.Id}", editKey: v.EditKey));
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        await Http.ProblemAsync(await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", editKey: v.EditKey)), HttpStatusCode.NotFound);
        Assert.False(Directory.Exists(Path.Combine(api.Factory.UploadPath, v.Id)));
    }

    [Fact]
    public async Task Responses_carry_the_security_headers_and_no_cookies()
    {
        var create = await _client.PostAsync("/api/venues", Doc());
        var v = (await create.Content.ReadFromJsonAsync<JsonObject>())!;
        var read = await _client.GetAsync($"/api/venues/{v["id"]}?t={v["readToken"]}");
        var denied = await _client.GetAsync($"/api/venues/{v["id"]}");
        foreach (var r in new[] { create, read, denied })
        {
            Assert.Equal("no-referrer", string.Join(",", r.Headers.GetValues("Referrer-Policy")));
            Assert.Equal("nosniff", string.Join(",", r.Headers.GetValues("X-Content-Type-Options")));
            Assert.Contains("default-src 'none'", string.Join(",", r.Headers.GetValues("Content-Security-Policy")), StringComparison.Ordinal);
            Assert.False(r.Headers.Contains("Set-Cookie"));
            Assert.False(r.Headers.Contains("Server"));
        }
    }

    [Fact]
    public async Task Secrets_never_reach_the_logs()
    {
        var v = await _client.CreateVenueAsync();
        await _client.GetAsync($"/api/venues/{v.Id}?t={v.ReadToken}");
        await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}", editKey: v.EditKey));
        await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: v.EditKey, content: Doc(), ifMatch: v.ETag));
        await _client.SendAsync(Http.Request(HttpMethod.Put, $"/api/venues/{v.Id}", editKey: "wrong-key", content: Doc(), ifMatch: v.ETag));
        var rotate = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/edit-key", editKey: v.EditKey));
        var newKey = (string)(await rotate.Content.ReadFromJsonAsync<JsonObject>())!["editKey"]!;

        var logs = api.Factory.Logs.AllText();
        Assert.Contains($"/api/venues/{v.Id}", logs, StringComparison.Ordinal); // request logging is on
        Assert.DoesNotContain(v.EditKey, logs, StringComparison.Ordinal);
        Assert.DoesNotContain(newKey, logs, StringComparison.Ordinal);
        Assert.DoesNotContain(v.ReadToken, logs, StringComparison.Ordinal);
        Assert.DoesNotContain("gate-a", logs, StringComparison.Ordinal); // no request bodies
    }
}

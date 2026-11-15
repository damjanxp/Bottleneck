using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Bottleneck.Api.Tests.Infrastructure;

namespace Bottleneck.Api.Tests.Jobs;

/// <summary>The built-in examples (packages/examples), copied next to the test assembly.</summary>
public static class Examples
{
    public static JsonObject Venue(string id) => Load(Path.Combine("venues", id + ".json"));

    public static JsonObject Scenario(string id) => Load(Path.Combine("scenarios", id + ".json"));

    private static JsonObject Load(string relative) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "examples", relative)))!.AsObject();
}

/// <summary>apps/api/tests/Bottleneck.Api.Tests/Jobs/expected-hashes.json: hashes computed by the engine in Node (= the browser).</summary>
public static class ExpectedHashes
{
    public static JsonObject Load() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Jobs", "expected-hashes.json")))!.AsObject();

    public static string For(string scenario, long seed, string? overridesJson = null) =>
        Load()["runs"]!.AsArray()
            .Single(r => (string)r!["scenario"]! == scenario && (long)r["seed"]! == seed
                && (overridesJson is null ? r["overrides"] is null : r["overrides"]?.ToJsonString() == overridesJson))!["metricsHash"]!.GetValue<string>();
}

/// <summary>Job tests share the one sidecar, so they run one class at a time.</summary>
[CollectionDefinition("jobs", DisableParallelization = true)]
public sealed class JobTestGroup;

public static class JobHttp
{
    /// <summary>Settings for an API whose runner talks to the test sidecar.</summary>
    public static async Task<Dictionary<string, string?>> SettingsAsync(SidecarFixture sidecar, Dictionary<string, string?>? extra = null)
    {
        var settings = new Dictionary<string, string?>
        {
            ["Sidecar:BaseUrl"] = await sidecar.UrlAsync(),
            ["Sidecar:RetryDelayMs"] = "100",
            ["Sidecar:MaxRetryDelayMs"] = "1000",
            ["Sidecar:MaxRetries"] = "60",
            ["Jobs:MaxParallelRuns"] = SidecarFixture.Concurrency.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["Jobs:HeartbeatSeconds"] = "1",
            ["Jobs:PollSeconds"] = "1",
        };
        foreach (var (k, v) in extra ?? []) settings[k] = v;
        return settings;
    }

    public static async Task<HttpResponseMessage> SubmitAsync(this HttpClient client, CreatedVenue v, JsonObject body, string? editKey = null) =>
        await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs", editKey: editKey ?? v.EditKey, content: Http.Json(body)));

    public static async Task<JsonObject> SubmitOkAsync(this HttpClient client, CreatedVenue v, JsonObject body)
    {
        var response = await client.SubmitAsync(v, body);
        Assert.True(response.StatusCode == HttpStatusCode.Created, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
        return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
    }

    public static async Task<JsonObject> GetJobAsync(this HttpClient client, CreatedVenue v, string jobId)
    {
        var response = await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/jobs/{jobId}", readToken: v.ReadToken));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
    }

    /// <summary>Polls the job until the condition holds; fails with the last state after the timeout.</summary>
    public static async Task<JsonObject> WaitForAsync(this HttpClient client, CreatedVenue v, string jobId, Func<JsonObject, bool> until, TimeSpan timeout)
    {
        var sw = Stopwatch.StartNew();
        while (true)
        {
            var job = await client.GetJobAsync(v, jobId);
            if (until(job)) return job;
            if ((string?)job["status"] is "failed") Assert.Fail("Job failed: " + (string?)job["error"]);
            if (sw.Elapsed > timeout) Assert.Fail($"Timed out after {timeout.TotalSeconds} s; job: status {(string?)job["status"]}, progress {job["progress"]?.ToJsonString()}");
            await Task.Delay(100);
        }
    }

    public static Task<JsonObject> WaitForStatusAsync(this HttpClient client, CreatedVenue v, string jobId, string status, TimeSpan timeout) =>
        client.WaitForAsync(v, jobId, j => (string?)j["status"] == status, timeout);

    public static async Task<JsonArray> JobRunsAsync(this HttpClient client, CreatedVenue v, string jobId)
    {
        var response = await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/runs?jobId={jobId}&limit=500", readToken: v.ReadToken));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonArray>())!;
    }

    public static JsonObject Batch(string requestId, JsonObject scenario, int seeds) => new()
    {
        ["requestId"] = requestId,
        ["kind"] = "batch",
        ["scenario"] = scenario.DeepClone(),
        ["seeds"] = seeds,
    };
}

using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Bottleneck.Api.Features.Jobs;
using Bottleneck.Api.Tests.Infrastructure;
using Npgsql;

namespace Bottleneck.Api.Tests.Jobs;

/// <summary>The API with its job runner talking to the real sidecar, shared by the tests of <see cref="JobRunTests"/>.</summary>
public sealed class JobApi(PostgresFixture postgres, SidecarFixture sidecar) : IAsyncLifetime
{
    public ApiFactory Factory { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        Factory = new ApiFactory(postgres, await JobHttp.SettingsAsync(sidecar));
        _ = Factory.Server;
    }

    public ValueTask DisposeAsync() => Factory.DisposeAsync();
}

/// <summary>Phase 4 checks: batches, sweeps, cancel and determinism, through the real engine sidecar.</summary>
[Collection("jobs")]
public sealed class JobRunTests(JobApi api) : IClassFixture<JobApi>
{
    private static readonly TimeSpan Long = TimeSpan.FromSeconds(120);
    private readonly HttpClient _client = api.Factory.CreateClient();

    [Fact]
    public async Task A_20_seed_batch_returns_mean_and_95_percent_CI_for_each_headline_metric()
    {
        var v = await _client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var created = await _client.SubmitOkAsync(v, new JsonObject
        {
            ["requestId"] = "batch-20",
            ["kind"] = "batch",
            ["scenario"] = Examples.Scenario("car-park-pay-station"),
        });
        Assert.Equal("queued", (string?)created["status"]);
        Assert.Equal(20, (int)created["progress"]!["totalRuns"]!);

        var job = await _client.WaitForStatusAsync(v, (string)created["id"]!, "succeeded", Long);
        Assert.Equal(20, (int)job["progress"]!["completedRuns"]!);
        Assert.Equal("0.0.1", (string?)job["engineVersion"]);
        var result = job["result"]!.AsObject();
        Assert.Equal(20, (int)result["runs"]!);
        // Seeds as the browser derives them (D-034): base seed, then hash4(base, 0x5eed, k, 0).
        var expectedSeeds = ExpectedHashes.Load()["derivedSeeds"]!["seeds"]!.AsArray().Select(s => (long)s!).ToList();
        Assert.Equal(expectedSeeds, result["seeds"]!.AsArray().Select(s => (long)s!).ToList());

        var metrics = result["metrics"]!.AsObject();
        foreach (var key in new[] { "parking/timeToEmpty", "parking/maxEntryQueueMetres", "parking/maxExitQueueMetres", "parking/turnedAwayCars", "shareInside", "meanWait", "peakHourP95Wait" })
        {
            var s = metrics[key]!.AsObject();
            Assert.Equal(20, (int)s["n"]!);
            var mean = (double)s["mean"]!;
            var sd = (double)s["sd"]!;
            var half = (double)s["ci95HalfWidth"]!;
            // Student t with 19 degrees of freedom, as packages/analysis summarise.
            Assert.Equal(2.093 * sd / Math.Sqrt(20), half, 9);
            Assert.Equal(mean - half, (double)s["low"]!, 9);
            Assert.Equal(mean + half, (double)s["high"]!, 9);
        }
        var timeToEmpty = metrics["parking/timeToEmpty"]!;
        Assert.True((double)timeToEmpty["sd"]! > 0, "Different seeds should give different times until the car park is empty.");

        // Every underlying run is stored as a trusted run of the job.
        var runs = await _client.JobRunsAsync(v, (string)job["id"]!);
        Assert.Equal(20, runs.Count);
        Assert.All(runs, r =>
        {
            Assert.Equal("job", (string?)r!["origin"]);
            Assert.Equal((string)job["id"]!, (string?)r["jobId"]);
            Assert.Equal("0.0.1", (string?)r["engineVersion"]);
            Assert.Matches("^[0-9a-f]{16}$", (string)r["metricsHash"]!);
        });
        Assert.Equal(expectedSeeds.Order(), runs.Select(r => (long)r!["seed"]!).Order());

        // A stored record is a valid run document (/schema/run.schema.json).
        var one = await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/runs/{(string)runs[0]!["id"]!}", readToken: v.ReadToken));
        var record = (await one.Content.ReadFromJsonAsync<JsonObject>())!["record"]!;
        var outcome = new Bottleneck.Schema.JsonSchemaValidator().Validate(Bottleneck.Schema.DocumentKind.Run, 1, record);
        Assert.True(outcome.IsValid, string.Join("; ", outcome.Errors.Select(e => e.Path + " " + e.Message)));
    }

    [Fact]
    public async Task A_job_run_and_a_browser_run_with_the_same_seed_produce_the_same_metrics_hash()
    {
        // expected-hashes.json is the engine run in Node (createRun + metricsHash), which equals Chrome's Web Worker
        // (Playwright determinism test); apps/api/test/expected-hashes.test.ts keeps it current.
        var v = await _client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var created = await _client.SubmitOkAsync(v, JobHttp.Batch("hash-check", Examples.Scenario("car-park-pay-station"), 3));
        var job = await _client.WaitForStatusAsync(v, (string)created["id"]!, "succeeded", Long);
        var runs = await _client.JobRunsAsync(v, (string)job["id"]!);
        Assert.Equal(3, runs.Count);
        foreach (var run in runs)
        {
            var seed = (long)run!["seed"]!;
            Assert.Equal(ExpectedHashes.For("car-park-pay-station", seed), (string?)run["metricsHash"]);
        }
    }

    [Fact]
    public async Task A_lane_sweep_on_the_concert_example_returns_the_smallest_lane_count_that_meets_the_target_wait()
    {
        var v = await _client.CreateVenueAsync(Examples.Venue("belgrade-fair-concert"));
        var created = await _client.SubmitOkAsync(v, new JsonObject
        {
            ["requestId"] = "lanes",
            ["kind"] = "laneSweep",
            ["scenario"] = Examples.Scenario("concert-3-lanes"),
            ["elementId"] = "gate-main",
            ["minLanes"] = 2,
            ["maxLanes"] = 5,
            ["seedsPerPoint"] = 2,
            ["targetWait"] = 600, // peak-hour p95 wait of at most 10 minutes
        });
        Assert.Equal(8, (int)created["progress"]!["totalRuns"]!);
        var job = await _client.WaitForStatusAsync(v, (string)created["id"]!, "succeeded", Long);
        var result = job["result"]!.AsObject();
        var points = result["points"]!.AsArray();
        Assert.Equal([2, 3, 4, 5], points.Select(p => (int)p!["laneCount"]!).ToArray());
        var means = points.Select(p => (double)p!["target"]!["mean"]!).ToArray();
        for (var i = 1; i < means.Length; i++) Assert.True(means[i] < means[i - 1], $"p95 wait should fall as lanes are added: {string.Join(", ", means)}");

        // 2 and 3 lanes leave a long jam at the gates; 4 lanes bring the peak-hour p95 under 10 minutes.
        Assert.Equal(4, (int?)result["smallestLaneCountByMean"]);
        Assert.Equal(4, (int?)result["answer"]);
        Assert.True((bool)points[2]!["meetsByMean"]! && !(bool)points[1]!["meetsByMean"]!);
        var ci = (int?)result["smallestLaneCountByCi"];
        Assert.True(ci is null || ci >= 4, "The interval rule is never less cautious than the mean rule.");

        // The 4-lane run with the scenario's seed equals the browser's hash for the same overrides.
        var runs = await _client.JobRunsAsync(v, (string)job["id"]!);
        Assert.Equal(8, runs.Count);
        var expected = ExpectedHashes.For("concert-3-lanes", 1, """{"gate-main":{"laneCount":4}}""");
        Assert.Contains(runs, r => (string?)r!["metricsHash"] == expected);
    }

    [Fact]
    public async Task A_gate_opening_sweep_returns_the_latest_opening_that_still_gets_the_target_share_inside_by_the_start()
    {
        var v = await _client.CreateVenueAsync(Examples.Venue("belgrade-fair-concert"));
        var created = await _client.SubmitOkAsync(v, new JsonObject
        {
            ["requestId"] = "gates",
            ["kind"] = "gateOpeningSweep",
            ["scenario"] = Examples.Scenario("concert-5-lanes"),
            ["gatesOpen"] = new JsonArray(-2700, -5400, -3600, -4500), // sorted by the server
            ["seedsPerPoint"] = 2,
            ["targetShareInside"] = 0.9,
        });
        var job = await _client.WaitForStatusAsync(v, (string)created["id"]!, "succeeded", Long);
        var result = job["result"]!.AsObject();
        var points = result["points"]!.AsArray();
        Assert.Equal([-5400.0, -4500.0, -3600.0, -2700.0], points.Select(p => (double)p!["gatesOpen"]!).ToArray());
        var shares = points.Select(p => (double)p!["shareInsideAtStart"]!["mean"]!).ToArray();
        // Opening later never gets more people in by the start; 45 minutes before the start is too late for 90%.
        for (var i = 1; i < shares.Length; i++) Assert.True(shares[i] <= shares[i - 1] + 1e-9, string.Join(", ", shares));
        Assert.True(shares[3] < 0.9);
        Assert.Equal(-3600.0, (double?)result["latestGatesOpenByMean"]);
        Assert.Equal(-3600.0, (double?)result["answer"]);
    }

    [Fact]
    public async Task A_running_job_can_be_cancelled_its_in_flight_run_is_aborted_and_no_further_runs_start()
    {
        var v = await _client.CreateVenueAsync(Examples.Venue("belgrade-fair-concert"));
        var created = await _client.SubmitOkAsync(v, JobHttp.Batch("cancel-me", Examples.Scenario("concert-3-lanes"), 12));
        var id = (string)created["id"]!;
        await _client.WaitForStatusAsync(v, id, "running", Long);
        await Task.Delay(300); // a concert run takes seconds: some are in flight now

        var cancel = await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs/{id}/cancel", editKey: v.EditKey));
        Assert.True(cancel.StatusCode is HttpStatusCode.Accepted or HttpStatusCode.OK, cancel.StatusCode.ToString());
        var job = await _client.WaitForStatusAsync(v, id, "cancelled", TimeSpan.FromSeconds(30));
        var completed = (int)job["progress"]!["completedRuns"]!;
        Assert.True(completed < 12, $"completed {completed}");
        Assert.Null(job["result"]);
        Assert.Contains(api.Factory.Logs.Events, e => e.MessageTemplate.Text.Contains("aborted by cancel", StringComparison.Ordinal));

        await Task.Delay(1500);
        var runs = await _client.JobRunsAsync(v, id);
        Assert.Equal(completed, runs.Count);
        Assert.Equal(completed, (int)(await _client.GetJobAsync(v, id))["progress"]!["completedRuns"]!);

        // A cancelled job can be cancelled again (200) and deleted with its runs.
        Assert.Equal(HttpStatusCode.OK, (await _client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs/{id}/cancel", editKey: v.EditKey))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _client.SendAsync(Http.Request(HttpMethod.Delete, $"/api/venues/{v.Id}/jobs/{id}", editKey: v.EditKey))).StatusCode);
        Assert.Empty(await _client.JobRunsAsync(v, id));
        Assert.Equal(HttpStatusCode.NotFound, (await _client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/jobs/{id}", readToken: v.ReadToken))).StatusCode);
    }
}

/// <summary>Restart recovery (D2): the queue lives in the database.</summary>
[Collection("jobs")]
public sealed class JobRestartTests(PostgresFixture postgres, SidecarFixture sidecar)
{
    private static readonly TimeSpan Long = TimeSpan.FromSeconds(120);

    [Fact]
    public async Task A_queued_job_survives_an_API_restart()
    {
        var db = postgres.NewDatabase();
        CreatedVenue v;
        string id;
        await using (var first = new ApiFactory(postgres, await JobHttp.SettingsAsync(sidecar, new() { ["ConnectionStrings:Bottleneck"] = db, ["Jobs:RunnerEnabled"] = "false" })))
        {
            var client = first.CreateClient();
            v = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
            id = (string)(await client.SubmitOkAsync(v, JobHttp.Batch("queued", Examples.Scenario("car-park-pay-station"), 2)))["id"]!;
            Assert.Equal("queued", (string?)(await client.GetJobAsync(v, id))["status"]);
        }

        await using var second = new ApiFactory(postgres, await JobHttp.SettingsAsync(sidecar, new() { ["ConnectionStrings:Bottleneck"] = db }));
        var job = await second.CreateClient().WaitForStatusAsync(v, id, "succeeded", Long);
        Assert.Equal(2, (int)job["result"]!["runs"]!);
    }

    [Fact]
    public async Task A_job_interrupted_while_running_is_requeued_and_resumes_without_redoing_finished_runs()
    {
        var db = postgres.NewDatabase();
        CreatedVenue v;
        string id;
        int doneBefore;
        await using (var first = new ApiFactory(postgres, await JobHttp.SettingsAsync(sidecar, new() { ["ConnectionStrings:Bottleneck"] = db, ["Jobs:MaxParallelRuns"] = "1" })))
        {
            var client = first.CreateClient();
            v = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
            id = (string)(await client.SubmitOkAsync(v, JobHttp.Batch("interrupted", Examples.Scenario("car-park-pay-station"), 8)))["id"]!;
            var running = await client.WaitForAsync(v, id, j => (int)j["progress"]!["completedRuns"]! >= 2, Long);
            Assert.Equal("running", (string?)running["status"]);
        }

        // The host stopped mid-job; simulate a crash on top (status left Running), which D2's startup reset handles.
        await using (var conn = new NpgsqlConnection(db))
        {
            await conn.OpenAsync();
            await using var cmd = new NpgsqlCommand("SELECT completed_runs FROM jobs WHERE id = @id", conn);
            cmd.Parameters.AddWithValue("id", id);
            doneBefore = (int)(await cmd.ExecuteScalarAsync())!;
            await using var crash = new NpgsqlCommand("UPDATE jobs SET status = 'Running' WHERE id = @id", conn);
            crash.Parameters.AddWithValue("id", id);
            await crash.ExecuteNonQueryAsync();
        }
        Assert.InRange(doneBefore, 2, 7);

        await using var second = new ApiFactory(postgres, await JobHttp.SettingsAsync(sidecar, new() { ["ConnectionStrings:Bottleneck"] = db }));
        var client2 = second.CreateClient();
        var job = await client2.WaitForStatusAsync(v, id, "succeeded", Long);
        Assert.Equal(2, (int)job["attempts"]!);
        Assert.Equal(8, (int)job["progress"]!["completedRuns"]!);
        Assert.Contains(second.Logs.Events, e => e.MessageTemplate.Text.StartsWith("Requeued", StringComparison.Ordinal));
        var runs = await client2.JobRunsAsync(v, id);
        Assert.Equal(8, runs.Count); // the runs stored before the restart were reused, not repeated
        Assert.Equal(8, runs.Select(r => (long)r!["seed"]!).Distinct().Count());
        Assert.Equal(ExpectedHashes.For("car-park-pay-station", 1), runs.Single(r => (long)r!["seed"]! == 1)!["metricsHash"]!.GetValue<string>());
    }
}

/// <summary>Submitting jobs: credentials, idempotency, validation and limits (D1). The runner is off, so jobs stay queued.</summary>
public sealed class JobSubmissionTests(PostgresFixture postgres)
{
    private static Dictionary<string, string?> Settings(Dictionary<string, string?>? extra = null)
    {
        var s = new Dictionary<string, string?> { ["Jobs:RunnerEnabled"] = "false", ["Sidecar:BaseUrl"] = "http://127.0.0.1:9" };
        foreach (var (k, v) in extra ?? []) s[k] = v;
        return s;
    }

    [Fact]
    public async Task Creating_or_cancelling_a_job_needs_the_edit_key_and_reading_needs_the_read_token()
    {
        await using var factory = new ApiFactory(postgres, Settings());
        var client = factory.CreateClient();
        var v = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var body = JobHttp.Batch("auth", Examples.Scenario("car-park-pay-station"), 2);

        await Http.ProblemAsync(await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs", content: Http.Json(body))), HttpStatusCode.Unauthorized);
        await Http.ProblemAsync(await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs", readToken: v.ReadToken, content: Http.Json(body))), HttpStatusCode.Unauthorized);
        var other = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        await Http.ProblemAsync(await client.SubmitAsync(v, body, editKey: other.EditKey), HttpStatusCode.Forbidden);

        var job = await client.SubmitOkAsync(v, body);
        var id = (string)job["id"]!;
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/jobs", readToken: v.ReadToken))).StatusCode);
        await Http.ProblemAsync(await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/jobs/{id}")), HttpStatusCode.Unauthorized);
        await Http.ProblemAsync(await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs/{id}/cancel", readToken: v.ReadToken)), HttpStatusCode.Unauthorized);
        await Http.ProblemAsync(await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{other.Id}/jobs/{id}", readToken: other.ReadToken)), HttpStatusCode.NotFound);

        // Cancelling a queued job takes effect at once; an active job cannot be deleted.
        var cancelled = await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/jobs/{id}/cancel", editKey: v.EditKey));
        Assert.Equal(HttpStatusCode.OK, cancelled.StatusCode);
        Assert.Equal("cancelled", (string?)(await cancelled.Content.ReadFromJsonAsync<JsonObject>())!["status"]);
        var active = await client.SubmitOkAsync(v, JobHttp.Batch("active", Examples.Scenario("car-park-pay-station"), 2));
        var problem = await Http.ProblemAsync(await client.SendAsync(Http.Request(HttpMethod.Delete, $"/api/venues/{v.Id}/jobs/{(string)active["id"]!}", editKey: v.EditKey)), HttpStatusCode.Conflict);
        Assert.EndsWith("job-active", problem.Type(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Resubmitting_the_same_requestId_returns_the_existing_job()
    {
        await using var factory = new ApiFactory(postgres, Settings());
        var client = factory.CreateClient();
        var v = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var body = JobHttp.Batch("same-request", Examples.Scenario("car-park-pay-station"), 2);

        var first = await client.SubmitAsync(v, body);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstId = (string)(await first.Content.ReadFromJsonAsync<JsonObject>())!["id"]!;
        var tasks = Enumerable.Range(0, 4).Select(_ => client.SubmitAsync(v, body)).ToList();
        foreach (var t in tasks)
        {
            var r = await t;
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            Assert.Equal(firstId, (string)(await r.Content.ReadFromJsonAsync<JsonObject>())!["id"]!);
        }
        var list = await client.SendAsync(Http.Request(HttpMethod.Get, $"/api/venues/{v.Id}/jobs", readToken: v.ReadToken));
        Assert.Single((await list.Content.ReadFromJsonAsync<JsonArray>())!);

        // Concurrent first submissions of a new requestId also end with one job.
        var racing = JobHttp.Batch("race", Examples.Scenario("car-park-pay-station"), 2);
        var results = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => client.SubmitAsync(v, racing)));
        Assert.Single(results, r => r.StatusCode == HttpStatusCode.Created);
        var ids = new HashSet<string>();
        foreach (var r in results) ids.Add((string)(await r.Content.ReadFromJsonAsync<JsonObject>())!["id"]!);
        Assert.Single(ids);
    }

    [Fact]
    public async Task Invalid_requests_and_the_work_budget_are_refused_with_422()
    {
        await using var factory = new ApiFactory(postgres, Settings(new() { ["Jobs:MaxSimulatedHours"] = "20" }));
        var client = factory.CreateClient();
        var v = await client.CreateVenueAsync(Examples.Venue("belgrade-fair-concert"));
        var scenario = Examples.Scenario("concert-3-lanes"); // 2.5 simulated hours per run (gates open 90 min before, horizon 60 min after)

        var budget = await Http.ProblemAsync(await client.SubmitAsync(v, JobHttp.Batch("budget", scenario, 10)), HttpStatusCode.UnprocessableEntity);
        Assert.EndsWith("work-budget-exceeded", budget.Type(), StringComparison.Ordinal);
        Assert.Contains("25.2 simulated hours", (string?)budget["detail"], StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Created, (await client.SubmitAsync(v, JobHttp.Batch("within", scenario, 7))).StatusCode);

        async Task<JsonObject> Invalid(JsonObject body)
        {
            var p = await Http.ProblemAsync(await client.SubmitAsync(v, body), HttpStatusCode.UnprocessableEntity);
            Assert.EndsWith("job-invalid", p.Type(), StringComparison.Ordinal);
            return p["errors"]!.AsObject();
        }
        Assert.True((await Invalid(new JsonObject { ["kind"] = "batch", ["scenario"] = scenario.DeepClone() })).ContainsKey("/requestId"));
        Assert.True((await Invalid(new JsonObject { ["requestId"] = "k", ["kind"] = "nope", ["scenario"] = scenario.DeepClone() })).ContainsKey("/kind"));
        Assert.True((await Invalid(new JsonObject { ["requestId"] = "s", ["kind"] = "batch" })).ContainsKey("/scenarioId"));
        var sweep = new JsonObject { ["requestId"] = "l", ["kind"] = "laneSweep", ["scenario"] = scenario.DeepClone(), ["elementId"] = "no-such-gate", ["maxLanes"] = 65 };
        var errors = await Invalid(sweep);
        Assert.True(errors.ContainsKey("/elementId") && errors.ContainsKey("/maxLanes") && errors.ContainsKey("/targetWait"));
        var gates = new JsonObject { ["requestId"] = "g", ["kind"] = "gateOpeningSweep", ["scenario"] = scenario.DeepClone(), ["gatesOpen"] = new JsonArray(-3600, 60) };
        Assert.True((await Invalid(gates)).ContainsKey("/gatesOpen"));

        // A broken inline scenario is a schema error, like any other write.
        var broken = scenario.DeepClone().AsObject();
        broken["attendance"] = -1;
        await Http.ProblemAsync(await client.SubmitAsync(v, JobHttp.Batch("broken", broken, 2)), HttpStatusCode.UnprocessableEntity);
        await Http.ProblemAsync(await client.SubmitAsync(v, new JsonObject { ["requestId"] = "x", ["kind"] = "batch", ["scenarioId"] = "aaaaaaaaaaaaaaaaaaaaaaaaaa" }), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Queue_caps_per_venue_and_globally_return_409()
    {
        await using var factory = new ApiFactory(postgres, Settings(new() { ["Jobs:MaxActivePerVenue"] = "2", ["Jobs:MaxActiveGlobal"] = "3" }));
        var client = factory.CreateClient();
        var a = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var b = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var scenario = Examples.Scenario("car-park-pay-station");
        Assert.Equal(HttpStatusCode.Created, (await client.SubmitAsync(a, JobHttp.Batch("a1", scenario, 2))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await client.SubmitAsync(a, JobHttp.Batch("a2", scenario, 2))).StatusCode);
        var perVenue = await Http.ProblemAsync(await client.SubmitAsync(a, JobHttp.Batch("a3", scenario, 2)), HttpStatusCode.Conflict);
        Assert.EndsWith("limit-reached", perVenue.Type(), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Created, (await client.SubmitAsync(b, JobHttp.Batch("b1", scenario, 2))).StatusCode);
        var global = await Http.ProblemAsync(await client.SubmitAsync(b, JobHttp.Batch("b2", scenario, 2)), HttpStatusCode.Conflict);
        Assert.Contains("queue is full", (string?)global["detail"], StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_job_can_run_a_stored_scenario()
    {
        await using var factory = new ApiFactory(postgres, Settings());
        var client = factory.CreateClient();
        var v = await client.CreateVenueAsync(Examples.Venue("standalone-car-park"));
        var s = await client.SendAsync(Http.Request(HttpMethod.Post, $"/api/venues/{v.Id}/scenarios", editKey: v.EditKey, content: Http.Json(Examples.Scenario("car-park-pay-station"))));
        var scenarioId = (string)(await s.Content.ReadFromJsonAsync<JsonObject>())!["id"]!;
        var job = await client.SubmitOkAsync(v, new JsonObject { ["requestId"] = "stored", ["kind"] = "batch", ["scenarioId"] = scenarioId, ["seeds"] = 3, ["baseSeed"] = 7 });
        var request = job["request"]!.AsObject();
        Assert.Equal(scenarioId, (string?)request["scenarioId"]);
        Assert.Equal(v.Id, (string?)request["scenario"]!["venueId"]);
        Assert.Equal(7, (long)request["seedList"]![0]!);
        Assert.Equal(3, request["seedList"]!.AsArray().Count);
    }
}

/// <summary>The C# statistics and seeds equal the TypeScript ones.</summary>
public sealed class JobMathTests
{
    [Fact]
    public void The_Student_t_table_equals_the_one_in_packages_analysis()
    {
        var source = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "analysis", "stats.ts"));
        var match = System.Text.RegularExpressions.Regex.Match(source, @"const T95 = \[(?<values>[^\]]*)\]");
        Assert.True(match.Success, "T95 table not found in packages/analysis/src/stats.ts");
        var ts = match.Groups["values"].Value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => double.Parse(x, System.Globalization.CultureInfo.InvariantCulture)).ToList();
        Assert.Equal(30, ts.Count);
        Assert.Equal(ts, Statistics.T95);
        Assert.Contains("n - 1 <= 30 ? (T95[n - 2] as number) : 1.96", source, StringComparison.Ordinal);
        Assert.Equal(1.96, Statistics.TCritical(31));
    }

    [Fact]
    public void Summarise_matches_packages_analysis()
    {
        var s = Statistics.Summarise([1, 2, 3, 4]);
        Assert.Equal(2.5, s.Mean);
        Assert.Equal(Math.Sqrt(5.0 / 3), s.Sd, 12);
        Assert.Equal(3.1824 * Math.Sqrt(5.0 / 3) / 2, s.Ci95HalfWidth!.Value, 12);
        Assert.Null(Statistics.Summarise([5]).Ci95HalfWidth);
        Assert.Equal(0, Statistics.Summarise([]).N);
    }

    [Fact]
    public void Derived_seeds_equal_the_web_apps_deriveSeeds()
    {
        var expected = ExpectedHashes.Load()["derivedSeeds"]!;
        var seeds = expected["seeds"]!.AsArray().Select(s => (long)s!).ToList();
        Assert.Equal(seeds, SeedDerivation.Derive((uint)(long)expected["base"]!, (int)expected["count"]!));
    }
}

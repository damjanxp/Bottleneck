using System.Globalization;
using System.Text.Json.Nodes;
using Bottleneck.Api.Options;

namespace Bottleneck.Api.Features.Jobs;

public static class JobKinds
{
    public const string Batch = "batch";
    public const string LaneSweep = "laneSweep";
    public const string GateOpeningSweep = "gateOpeningSweep";
}

/// <summary>Metrics a lane sweep can target; all are waits in seconds, so "meets" means at most the target.</summary>
public static class SweepMetrics
{
    public const string PeakHourP95Wait = "peakHourP95Wait";
    public const string P95Wait = "p95Wait";
    public const string MeanWait = "meanWait";
    /// <summary>The worst lane's p95 queue wait at the swept element (gate group, screening stage or barrier).</summary>
    public const string ElementP95Wait = "elementP95Wait";

    public static readonly IReadOnlyList<string> All = [PeakHourP95Wait, P95Wait, MeanWait, ElementP95Wait];

    /// <summary>The key in <see cref="MetricExtractor"/>'s output.</summary>
    public static string Key(string metric, string elementId) =>
        metric == ElementP95Wait ? MetricExtractor.ElementKey(elementId, "p95Wait") : metric;
}

/// <summary>Which statistic decides "meets the target" in a sweep (see <see cref="JobAggregator"/>).</summary>
public static class SweepRules
{
    /// <summary>The mean over the seeds meets the target (the point estimate the chart shows). Default.</summary>
    public const string Mean = "mean";
    /// <summary>The whole 95% interval is on the right side of the target (upper bound for waits, lower bound for shares).</summary>
    public const string Ci = "ci";

    public static readonly IReadOnlyList<string> All = [Mean, Ci];
}

/// <summary>One sweep point (or the only point of a batch): what changes relative to the scenario.</summary>
public sealed record JobPoint(int Index, string Label, double? Value, JsonObject Scenario, JsonObject? Overrides);

/// <summary>One run of a job: a point and a seed. Index = point × seeds + seed index.</summary>
public sealed record RunSpec(int Index, JobPoint Point, long Seed);

/// <summary>
/// A job's normalized request (stored as jsonb in jobs.request) and the runs it expands to. The plan is
/// rebuilt from the stored request whenever the runner (re)starts the job, so it must be deterministic.
/// </summary>
public sealed class JobPlan
{
    public required string Kind { get; init; }
    /// <summary>The normalized request as stored (with the scenario snapshot).</summary>
    public required JsonObject Request { get; init; }
    public required JsonObject Scenario { get; init; }
    public required IReadOnlyList<long> Seeds { get; init; }
    public required IReadOnlyList<JobPoint> Points { get; init; }

    public int TotalRuns => Seeds.Count * Points.Count;

    public RunSpec Run(int index) => new(index, Points[index / Seeds.Count], Seeds[index % Seeds.Count]);

    public IEnumerable<RunSpec> Runs() => Enumerable.Range(0, TotalRuns).Select(Run);

    /// <summary>Simulated hours of all runs together, for the work budget (D1).</summary>
    public double SimulatedHours() => Points.Sum(p => SimulatedHoursPerRun(p.Scenario)) * Seeds.Count;

    /// <summary>From the earliest of gate opening, first custom arrival point and first timed event, to the horizon.</summary>
    public static double SimulatedHoursPerRun(JsonObject scenario)
    {
        var tl = scenario["timeline"]!.AsObject();
        var start = (double)tl["gatesOpen"]!;
        if (scenario["arrivals"]?["points"] is JsonArray points)
            foreach (var p in points) start = Math.Min(start, (double)p!["t"]!);
        if (scenario["timedEvents"] is JsonArray events)
            foreach (var e in events) if (e?["at"] is JsonValue at) start = Math.Min(start, (double)at);
        var seconds = (double)tl["horizon"]! - (Math.Floor(start / 60) * 60 - 60);
        return Math.Max(seconds, 60) / 3600;
    }

    /// <summary>Seed and overrides applied the way the sidecar applies them: seed replaces; overrides merge per element id and field.</summary>
    public static JsonObject Apply(JsonObject scenario, long seed, JsonObject? overrides)
    {
        var s = scenario.DeepClone().AsObject();
        s["seed"] = seed;
        if (overrides is not null)
        {
            var merged = s["overrides"] as JsonObject ?? new JsonObject();
            foreach (var (id, o) in overrides)
            {
                var target = merged[id] as JsonObject ?? new JsonObject();
                foreach (var (field, value) in o!.AsObject()) target[field] = value?.DeepClone();
                merged[id] = target;
            }
            s["overrides"] = merged;
        }
        return s;
    }

    /// <summary>Rebuilds the plan from a stored, already validated request.</summary>
    public static JobPlan FromStored(JsonObject request, JsonObject venue)
    {
        var result = JobPlanner.Build(request, venue, new JobOptions { MaxBatchSeeds = int.MaxValue, MaxSeedsPerPoint = int.MaxValue, MaxSweepPoints = int.MaxValue }, out var errors);
        return result ?? throw new InvalidOperationException("Stored job request is invalid: " + string.Join("; ", errors.Select(e => $"{e.Key}: {string.Join(", ", e.Value)}")));
    }
}

/// <summary>Validates a job request (the "scenario" member already holds a validated scenario document) and expands it.</summary>
public static class JobPlanner
{
    public const int MaxLanes = 64; // ElementOverride.laneCount maximum in /schema

    public static JobPlan? Build(JsonObject body, JsonObject venue, JobOptions o, out Dictionary<string, string[]> errors)
    {
        var errs = new Dictionary<string, string[]>(StringComparer.Ordinal);
        void Err(string path, string message) => errs[path] = [message];
        errors = errs;

        var kind = body["kind"] is JsonValue kv && kv.TryGetValue<string>(out var k) ? k : null;
        if (kind is not (JobKinds.Batch or JobKinds.LaneSweep or JobKinds.GateOpeningSweep))
        {
            Err("/kind", $"Must be \"{JobKinds.Batch}\", \"{JobKinds.LaneSweep}\" or \"{JobKinds.GateOpeningSweep}\".");
            return null;
        }
        var scenario = body["scenario"]!.AsObject();
        var request = new JsonObject
        {
            ["kind"] = kind,
            ["requestId"] = body["requestId"]?.DeepClone(),
            ["scenarioId"] = body["scenarioId"]?.DeepClone(),
        };

        // Seeds: an explicit list, or a count (default per kind) derived from baseSeed (default: the scenario's seed).
        var defaultCount = kind == JobKinds.Batch ? o.DefaultBatchSeeds : o.DefaultSeedsPerPoint;
        var maxCount = kind == JobKinds.Batch ? o.MaxBatchSeeds : o.MaxSeedsPerPoint;
        var countField = kind == JobKinds.Batch ? "seeds" : "seedsPerPoint";
        IReadOnlyList<long> seeds = [];
        if (body["seedList"] is JsonArray list)
        {
            var parsed = new List<long>();
            foreach (var n in list)
            {
                if (n is JsonValue v && v.TryGetValue<long>(out var s) && s is >= 0 and <= uint.MaxValue && !parsed.Contains(s)) parsed.Add(s);
                else { Err("/seedList", "Distinct integers in 0..4294967295."); break; }
            }
            if (parsed.Count < 1 || parsed.Count > maxCount) Err("/seedList", $"1 to {maxCount} seeds.");
            seeds = parsed;
        }
        else
        {
            var count = ReadInt(body, countField, defaultCount, 1, maxCount, Err);
            var baseSeed = ReadLong(body, "baseSeed", (long)scenario["seed"]!, 0, uint.MaxValue, Err);
            if (count is not null && baseSeed is not null)
            {
                seeds = SeedDerivation.Derive((uint)baseSeed.Value, count.Value);
                request["baseSeed"] = baseSeed.Value;
            }
        }
        request["seedList"] = new JsonArray(seeds.Select(s => (JsonNode)s).ToArray());

        var points = new List<JobPoint>();
        switch (kind)
        {
            case JobKinds.Batch:
                points.Add(new JobPoint(0, "scenario", null, scenario, null));
                break;

            case JobKinds.LaneSweep:
            {
                var elementId = body["elementId"] is JsonValue ev && ev.TryGetValue<string>(out var e) ? e : null;
                var kindOf = elementId is null ? null : ElementKind(venue, elementId);
                if (kindOf is null) Err("/elementId", "Must name a gate group, screening stage or vehicle barrier of the venue.");
                var minLanes = ReadInt(body, "minLanes", 1, 1, MaxLanes, Err);
                var maxLanes = ReadInt(body, "maxLanes", null, 1, MaxLanes, Err);
                if (minLanes > maxLanes) Err("/maxLanes", "Must be at least minLanes.");
                var target = ReadDouble(body, "targetWait", null, 0, 1e7, Err);
                var metric = ReadEnum(body, "metric", SweepMetrics.PeakHourP95Wait, SweepMetrics.All, Err);
                var rule = ReadEnum(body, "rule", SweepRules.Mean, SweepRules.All, Err);
                if (errs.Count > 0) break;
                for (var lanes = minLanes!.Value; lanes <= maxLanes!.Value; lanes++)
                {
                    var overrides = new JsonObject { [elementId!] = new JsonObject { ["laneCount"] = lanes } };
                    points.Add(new JobPoint(points.Count, lanes.ToString(CultureInfo.InvariantCulture), lanes, scenario, overrides));
                }
                request["elementId"] = elementId;
                request["elementKind"] = kindOf;
                request["minLanes"] = minLanes;
                request["maxLanes"] = maxLanes;
                request["targetWait"] = target;
                request["metric"] = metric;
                request["rule"] = rule;
                break;
            }

            case JobKinds.GateOpeningSweep:
            {
                var tl = scenario["timeline"]!.AsObject();
                var eventStart = tl["eventStart"] is JsonValue es ? (double?)es : null;
                if (eventStart is null) Err("/scenario/timeline/eventStart", "A gate-opening sweep needs a fixed event start.");
                var candidates = new List<double>();
                if (body["gatesOpen"] is JsonArray arr && arr.Count >= 1 && arr.Count <= o.MaxSweepPoints)
                {
                    foreach (var n in arr)
                    {
                        if (n is JsonValue v && v.TryGetValue<double>(out var t) && double.IsFinite(t)) { if (!candidates.Contains(t)) candidates.Add(t); }
                        else { Err("/gatesOpen", "Numbers (scenario seconds)."); break; }
                    }
                }
                else Err("/gatesOpen", $"1 to {o.MaxSweepPoints} candidate gate-opening times (scenario seconds, e.g. -5400 for 90 minutes before the start).");
                if (eventStart is { } start && candidates.Any(c => c >= start)) Err("/gatesOpen", "Every candidate must be before the event start.");
                if (candidates.Any(c => c >= (double)tl["horizon"]!)) Err("/gatesOpen", "Every candidate must be before the horizon.");
                var target = ReadDouble(body, "targetShareInside", 0.95, 0, 1, Err);
                var rule = ReadEnum(body, "rule", SweepRules.Mean, SweepRules.All, Err);
                if (errs.Count > 0) break;
                candidates.Sort(); // earliest first; the answer is the latest that still meets the target
                foreach (var c in candidates)
                {
                    var s = scenario.DeepClone().AsObject();
                    s["timeline"]!["gatesOpen"] = c;
                    // "Inside by the start": the share-inside metric is taken at the event start.
                    var parameters = s["parameters"] as JsonObject ?? new JsonObject();
                    parameters["shareInsideAt"] = eventStart;
                    s["parameters"] = parameters;
                    points.Add(new JobPoint(points.Count, c.ToString(CultureInfo.InvariantCulture), c, s, null));
                }
                request["gatesOpen"] = new JsonArray(candidates.Select(c => (JsonNode)c).ToArray());
                request["targetShareInside"] = target;
                request["rule"] = rule;
                break;
            }
        }

        request["scenario"] = scenario.DeepClone();
        if (errs.Count > 0) return null;
        return new JobPlan { Kind = kind, Request = request, Scenario = scenario, Seeds = seeds, Points = points };
    }

    /// <summary>"gateGroup", "screeningStage" or "vehicleBarrier", or null if the venue has no such element.</summary>
    public static string? ElementKind(JsonObject venue, string id)
    {
        foreach (var (field, kind) in new[] { ("gateGroups", "gateGroup"), ("screeningStages", "screeningStage"), ("vehicleBarriers", "vehicleBarrier") })
            if (venue[field] is JsonArray arr && arr.Any(e => (string?)e?["id"] == id)) return kind;
        return null;
    }

    private static int? ReadInt(JsonObject body, string name, int? fallback, int min, int max, Action<string, string> err)
    {
        var node = body[name];
        if (node is null) { if (fallback is null) err("/" + name, "Required."); return fallback; }
        if (node is JsonValue v && v.TryGetValue<int>(out var i) && i >= min && i <= max) return i;
        err("/" + name, $"An integer from {min} to {max}.");
        return null;
    }

    private static long? ReadLong(JsonObject body, string name, long fallback, long min, long max, Action<string, string> err)
    {
        var node = body[name];
        if (node is null) return fallback;
        if (node is JsonValue v && v.TryGetValue<long>(out var i) && i >= min && i <= max) return i;
        err("/" + name, $"An integer from {min} to {max}.");
        return null;
    }

    private static double? ReadDouble(JsonObject body, string name, double? fallback, double min, double max, Action<string, string> err)
    {
        var node = body[name];
        if (node is null) { if (fallback is null) err("/" + name, "Required."); return fallback; }
        if (node is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) && d >= min && d <= max) return d;
        err("/" + name, $"A number from {min.ToString(CultureInfo.InvariantCulture)} to {max.ToString(CultureInfo.InvariantCulture)}.");
        return null;
    }

    private static string? ReadEnum(JsonObject body, string name, string fallback, IReadOnlyList<string> allowed, Action<string, string> err)
    {
        var node = body[name];
        if (node is null) return fallback;
        if (node is JsonValue v && v.TryGetValue<string>(out var s) && allowed.Contains(s)) return s;
        err("/" + name, "One of: " + string.Join(", ", allowed) + ".");
        return null;
    }
}

using System.Text.Json.Nodes;

namespace Bottleneck.Api.Features.Jobs;

/// <summary>
/// Picks the headline numbers out of one run's metrics (RecordedMetrics, /schema/run.schema.json) as a
/// flat map. Keys:
/// <list type="bullet">
/// <item>peakHourP95Wait, meanWait, p95Wait (s); shareInside (0..1, at the run's shareInsideAt);
/// stillOutsideAtStart, arrivedButOutsideAtStart, notYetArrivedAtStart (people; fixed-start events only)</item>
/// <item>elements/{id}/maxQueue, elements/{id}/p95Wait: the worst lane of a gate group, screening stage, pay station or barrier</item>
/// <item>lanes/{id}/{laneIndex}/maxQueue, lanes/{id}/{laneIndex}/p95Wait: each lane</item>
/// <item>parking/timeToEmpty (s, the last lot), lots/{id}/timeToEmpty, parking/maxEntryQueueMetres, parking/maxExitQueueMetres,
/// barriers/{id}/maxQueueMetres, parking/turnedAwayCars, parking/turnedAwayPeople (only when someone arrives by car)</item>
/// </list>
/// Missing or null values (e.g. a lot that never empties) are left out, so a summary's n can be below the seed count.
/// </summary>
public static class MetricExtractor
{
    public static string ElementKey(string elementId, string field) => $"elements/{elementId}/{field}";

    public static SortedDictionary<string, double> Extract(JsonObject metrics)
    {
        var m = new SortedDictionary<string, double>(StringComparer.Ordinal);
        void Put(string key, JsonNode? node)
        {
            if (node is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d)) m[key] = d;
        }
        void Max(string key, double value) => m[key] = m.TryGetValue(key, out var old) ? Math.Max(old, value) : value;

        Put("peakHourP95Wait", metrics["peakHour"]?["p95Wait"]);
        Put("meanWait", metrics["meanWait"]);
        Put("p95Wait", metrics["p95Wait"]);
        Put("shareInside", metrics["shareInside"]?["share"]);
        Put("stillOutsideAtStart", metrics["stillOutsideAtStart"]);
        Put("arrivedButOutsideAtStart", metrics["arrivedButOutsideAtStart"]);
        Put("notYetArrivedAtStart", metrics["notYetArrivedAtStart"]);

        void Lane(string elementId, JsonNode? laneIndex, JsonNode? laneMetrics)
        {
            if (laneMetrics is not JsonObject lm || laneIndex is null) return;
            var maxQueue = (double)lm["maxQueue"]!;
            var p95 = (double)lm["p95Wait"]!;
            m[$"lanes/{elementId}/{(int)laneIndex}/maxQueue"] = maxQueue;
            m[$"lanes/{elementId}/{(int)laneIndex}/p95Wait"] = p95;
            Max(ElementKey(elementId, "maxQueue"), maxQueue);
            Max(ElementKey(elementId, "p95Wait"), p95);
        }

        if (metrics["lanes"] is JsonArray lanes)
            foreach (var l in lanes) Lane((string)l!["elementId"]!, l["laneIndex"], l["metrics"]);

        if (metrics["parking"] is JsonObject parking)
        {
            Put("parking/turnedAwayCars", parking["turnedAwayCars"]);
            Put("parking/turnedAwayPeople", parking["turnedAwayPeople"]);
            if (parking["barrierLanes"] is JsonArray barrierLanes)
                foreach (var l in barrierLanes) Lane((string)l!["barrierId"]!, l["laneIndex"], l["metrics"]);
            if (parking["lots"] is JsonArray lots)
                foreach (var lot in lots)
                {
                    if (lot?["timeToEmpty"] is not JsonValue v || !v.TryGetValue<double>(out var t)) continue;
                    m[$"lots/{(string)lot["lotId"]!}/timeToEmpty"] = t;
                    Max("parking/timeToEmpty", t);
                }
            if (parking["barriers"] is JsonArray barriers)
                foreach (var b in barriers)
                {
                    var metres = (double)b!["maxQueueMetres"]!;
                    m[$"barriers/{(string)b["barrierId"]!}/maxQueueMetres"] = metres;
                    Max((string?)b["kind"] == "exit" ? "parking/maxExitQueueMetres" : "parking/maxEntryQueueMetres", metres);
                }
        }
        return m;
    }
}

/// <summary>
/// Turns the per-run values of a job into its result: mean, sd and 95% CI (Student t, as in the browser) for every
/// metric, and for sweeps the answer.
///
/// "Meets the target" (sweeps): by default the MEAN over the seeds (rule "mean"); with rule "ci" the whole 95%
/// interval must be on the right side (upper bound ≤ target wait; lower bound ≥ target share). The result always
/// reports both answers. The mean is the default because sweeps use few seeds per point: with 2–5 seeds the t value
/// is 12.7–2.8, so the interval rule mostly reflects the seed count rather than the venue and would recommend lanes
/// nobody needs; the "ci" answer is there for a cautious reading, and gets close to the mean answer as seeds grow.
/// </summary>
public static class JobAggregator
{
    public static JsonObject Summaries(IEnumerable<IReadOnlyDictionary<string, double>> runs)
    {
        var byKey = new SortedDictionary<string, List<double>>(StringComparer.Ordinal);
        foreach (var run in runs)
            foreach (var (k, v) in run)
            {
                if (!byKey.TryGetValue(k, out var list)) byKey[k] = list = [];
                list.Add(v);
            }
        var o = new JsonObject();
        foreach (var (k, values) in byKey) o[k] = ToJson(Statistics.Summarise(values));
        return o;
    }

    public static JsonObject ToJson(Summary s) => new()
    {
        ["n"] = s.N,
        ["mean"] = double.IsFinite(s.Mean) ? s.Mean : null,
        ["sd"] = s.Sd,
        ["ci95HalfWidth"] = s.Ci95HalfWidth,
        ["low"] = s.Low,
        ["high"] = s.High,
    };

    /// <summary>The job result. `values` holds the extracted metrics per run index; every run of the plan must be present.</summary>
    public static JsonObject Build(JobPlan plan, IReadOnlyDictionary<int, IReadOnlyDictionary<string, double>> values, string engineVersion)
    {
        var req = plan.Request;
        var result = new JsonObject
        {
            ["kind"] = plan.Kind,
            ["engineVersion"] = engineVersion,
            ["seeds"] = new JsonArray(plan.Seeds.Select(s => (JsonNode)s).ToArray()),
            ["runs"] = plan.TotalRuns,
        };
        IEnumerable<IReadOnlyDictionary<string, double>> PointRuns(JobPoint p) =>
            Enumerable.Range(0, plan.Seeds.Count).Select(i => values[p.Index * plan.Seeds.Count + i]);

        if (plan.Kind == JobKinds.Batch)
        {
            result["metrics"] = Summaries(PointRuns(plan.Points[0]));
            return result;
        }

        var rule = (string)req["rule"]!;
        var points = new JsonArray();
        if (plan.Kind == JobKinds.LaneSweep)
        {
            var elementId = (string)req["elementId"]!;
            var metric = (string)req["metric"]!;
            var key = SweepMetrics.Key(metric, elementId);
            var target = (double)req["targetWait"]!;
            int? byMean = null, byCi = null;
            foreach (var p in plan.Points)
            {
                var all = Summaries(PointRuns(p));
                var s = Statistics.Summarise(PointRuns(p).Where(r => r.ContainsKey(key)).Select(r => r[key]).ToList());
                var meetsMean = s.N > 0 && s.Mean <= target;
                var meetsCi = s.High is { } hi && hi <= target;
                var lanes = (int)p.Value!.Value;
                if (meetsMean && byMean is null) byMean = lanes;
                if (meetsCi && byCi is null) byCi = lanes;
                points.Add(new JsonObject
                {
                    ["laneCount"] = lanes,
                    ["target"] = ToJson(s),
                    ["meetsByMean"] = meetsMean,
                    ["meetsByCi"] = meetsCi,
                    ["metrics"] = all,
                });
            }
            result["elementId"] = elementId;
            result["metric"] = metric;
            result["metricKey"] = key;
            result["targetWait"] = target;
            result["rule"] = rule;
            result["points"] = points;
            result["smallestLaneCountByMean"] = byMean;
            result["smallestLaneCountByCi"] = byCi;
            result["answer"] = rule == SweepRules.Ci ? byCi : byMean;
            return result;
        }

        // Gate-opening sweep: points are sorted earliest first; the answer is the LATEST opening that still meets the share.
        var targetShare = (double)req["targetShareInside"]!;
        double? latestMean = null, latestCi = null;
        foreach (var p in plan.Points)
        {
            var all = Summaries(PointRuns(p));
            var s = Statistics.Summarise(PointRuns(p).Where(r => r.ContainsKey("shareInside")).Select(r => r["shareInside"]).ToList());
            var meetsMean = s.N > 0 && s.Mean >= targetShare;
            var meetsCi = s.Low is { } lo && lo >= targetShare;
            if (meetsMean) latestMean = p.Value;
            if (meetsCi) latestCi = p.Value;
            points.Add(new JsonObject
            {
                ["gatesOpen"] = p.Value,
                ["shareInsideAtStart"] = ToJson(s),
                ["meetsByMean"] = meetsMean,
                ["meetsByCi"] = meetsCi,
                ["metrics"] = all,
            });
        }
        result["targetShareInside"] = targetShare;
        result["rule"] = rule;
        result["points"] = points;
        result["latestGatesOpenByMean"] = latestMean;
        result["latestGatesOpenByCi"] = latestCi;
        result["answer"] = rule == SweepRules.Ci ? latestCi : latestMean;
        return result;
    }
}

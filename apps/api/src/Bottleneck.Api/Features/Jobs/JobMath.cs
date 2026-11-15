namespace Bottleneck.Api.Features.Jobs;

/// <summary>Mean, sample standard deviation and 95% confidence half-width of the mean (Student t). CI null for n &lt; 2.</summary>
public sealed record Summary(int N, double Mean, double Sd, double? Ci95HalfWidth)
{
    public double? Low => Ci95HalfWidth is { } h ? Mean - h : null;
    public double? High => Ci95HalfWidth is { } h ? Mean + h : null;
}

/// <summary>
/// The statistics of packages/analysis/src/stats.ts (summarise), ported exactly so a server batch and a
/// browser batch report the same interval. A test checks the table against the TypeScript source.
/// </summary>
public static class Statistics
{
    /// <summary>Two-sided 95% Student t critical values for 1..30 degrees of freedom; 1.96 beyond.</summary>
    public static readonly IReadOnlyList<double> T95 =
    [
        12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306, 2.2622, 2.2281, 2.201, 2.1788, 2.1604, 2.1448, 2.1315, 2.1199, 2.1098, 2.1009, 2.093, 2.086,
        2.0796, 2.0739, 2.0687, 2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452, 2.0423,
    ];

    public static double TCritical(int degreesOfFreedom) => degreesOfFreedom <= 30 ? T95[degreesOfFreedom - 1] : 1.96;

    public static Summary Summarise(IReadOnlyList<double> values)
    {
        var n = values.Count;
        if (n == 0) return new Summary(0, double.NaN, 0, null);
        var sum = 0.0;
        foreach (var v in values) sum += v;
        var mean = sum / n;
        if (n < 2) return new Summary(n, mean, 0, null);
        var ss = 0.0;
        foreach (var v in values) ss += (v - mean) * (v - mean);
        var sd = Math.Sqrt(ss / (n - 1));
        return new Summary(n, mean, sd, TCritical(n - 1) * sd / Math.Sqrt(n));
    }
}

/// <summary>
/// Batch seeds exactly as the web app derives them (apps/web/src/compare/plan.ts deriveSeeds, decision D-034):
/// the base seed, then hash4(base, 0x5eed, k, 0) for k = 1, 2, … skipping repeats. A server batch with the same
/// base seed therefore runs the same seeds as a browser batch.
/// </summary>
public static class SeedDerivation
{
    private const uint SeedStream = 0x5eed;

    /// <summary>packages/engine/src/rng.ts mix32 (Math.imul and unsigned shifts are plain uint arithmetic).</summary>
    public static uint Mix32(uint x)
    {
        unchecked
        {
            x ^= x >> 16;
            x *= 0x21f0aaad;
            x ^= x >> 15;
            x *= 0x735a2d97;
            x ^= x >> 15;
            return x;
        }
    }

    public static uint Hash4(uint seed, uint stream, uint entity, uint index)
    {
        unchecked
        {
            var h = Mix32(seed + 0x9e3779b9);
            h = Mix32((h ^ stream) + 0x85ebca6b);
            h = Mix32((h ^ entity) + 0xc2b2ae35);
            h = Mix32((h ^ index) + 0x27d4eb2f);
            return h;
        }
    }

    public static IReadOnlyList<long> Derive(uint baseSeed, int count)
    {
        var seeds = new List<long> { baseSeed };
        for (uint k = 1; seeds.Count < count; k++)
        {
            long s = Hash4(baseSeed, SeedStream, k, 0);
            if (!seeds.Contains(s)) seeds.Add(s);
        }
        return seeds.Take(Math.Max(0, count)).ToList();
    }
}

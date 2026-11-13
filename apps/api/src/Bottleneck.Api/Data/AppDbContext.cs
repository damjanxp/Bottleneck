using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Bottleneck.Api.Data;

public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public const int IdLength = 26;

    public DbSet<Venue> Venues => Set<Venue>();
    public DbSet<Scenario> Scenarios => Set<Scenario>();
    public DbSet<Run> Runs => Set<Run>();
    public DbSet<Upload> Uploads => Set<Upload>();
    public DbSet<Job> Jobs => Set<Job>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var b = modelBuilder;
        b.Entity<Venue>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(IdLength);
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Document).HasColumnType("jsonb");
            e.Property(x => x.ReadToken).HasMaxLength(64);
            e.Property(x => x.EditKeyHash).HasMaxLength(32);
            e.Property(x => x.Revision).IsConcurrencyToken();
            e.HasIndex(x => x.LastActivityAt);
            e.HasMany(x => x.Scenarios).WithOne().HasForeignKey(x => x.VenueId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Runs).WithOne().HasForeignKey(x => x.VenueId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Uploads).WithOne().HasForeignKey(x => x.VenueId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Jobs).WithOne().HasForeignKey(x => x.VenueId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<Scenario>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(IdLength);
            e.Property(x => x.VenueId).HasMaxLength(IdLength);
            e.Property(x => x.Name).HasMaxLength(120);
            e.Property(x => x.Document).HasColumnType("jsonb");
            e.Property(x => x.Revision).IsConcurrencyToken();
            e.HasIndex(x => new { x.VenueId, x.CreatedAt });
        });

        b.Entity<Run>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(IdLength);
            e.Property(x => x.VenueId).HasMaxLength(IdLength);
            e.Property(x => x.ScenarioId).HasMaxLength(IdLength);
            e.Property(x => x.JobId).HasMaxLength(IdLength);
            e.Property(x => x.Origin).HasMaxLength(20);
            e.Property(x => x.EngineVersion).HasMaxLength(40);
            e.Property(x => x.MetricsHash).HasMaxLength(16);
            e.Property(x => x.Record).HasColumnType("jsonb");
            e.HasIndex(x => new { x.VenueId, x.Origin, x.CreatedAt });
            e.HasOne<Scenario>().WithMany().HasForeignKey(x => x.ScenarioId).OnDelete(DeleteBehavior.SetNull);
            e.ToTable(t => t.HasCheckConstraint("ck_runs_origin", "origin IN ('job', 'clientReported')"));
        });

        b.Entity<Upload>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(IdLength);
            e.Property(x => x.VenueId).HasMaxLength(IdLength);
            e.Property(x => x.ContentType).HasMaxLength(20);
            e.HasIndex(x => x.VenueId);
            e.ToTable(t => t.HasCheckConstraint("ck_uploads_content_type", "content_type IN ('image/png', 'image/jpeg')"));
        });

        b.Entity<Job>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(IdLength);
            e.Property(x => x.VenueId).HasMaxLength(IdLength);
            e.Property(x => x.RequestId).HasMaxLength(64);
            e.Property(x => x.Kind).HasMaxLength(20);
            e.Property(x => x.Status).HasConversion<string>().HasMaxLength(20);
            e.Property(x => x.Request).HasColumnType("jsonb");
            e.Property(x => x.Result).HasColumnType("jsonb");
            e.Property(x => x.Error).HasMaxLength(2000);
            e.Property(x => x.EngineVersion).HasMaxLength(40);
            e.HasIndex(x => new { x.VenueId, x.RequestId }).IsUnique();
            e.HasIndex(x => new { x.Status, x.CreatedAt });
            e.HasMany(x => x.Runs).WithOne().HasForeignKey(x => x.JobId).OnDelete(DeleteBehavior.SetNull);
        });
    }
}

/// <summary>Used only by `dotnet ef migrations add`; no database is needed to create a migration.</summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Database=bottleneck_design")
            .UseSnakeCaseNamingConvention()
            .Options);
}

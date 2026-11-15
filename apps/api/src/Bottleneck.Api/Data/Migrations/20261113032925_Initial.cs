using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Bottleneck.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "venues",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    schema_version = table.Column<int>(type: "integer", nullable: false),
                    document = table.Column<string>(type: "jsonb", nullable: false),
                    read_token = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    edit_key_hash = table.Column<byte[]>(type: "bytea", maxLength: 32, nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false),
                    pinned = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_activity_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_venues", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "jobs",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    venue_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    request_id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    request = table.Column<string>(type: "jsonb", nullable: false),
                    completed_runs = table.Column<int>(type: "integer", nullable: false),
                    total_runs = table.Column<int>(type: "integer", nullable: false),
                    result = table.Column<string>(type: "jsonb", nullable: true),
                    error = table.Column<string>(type: "character varying(2000)", maxLength: 2000, nullable: true),
                    engine_version = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    cancel_requested = table.Column<bool>(type: "boolean", nullable: false),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    started_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    finished_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    heartbeat_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_jobs", x => x.id);
                    table.ForeignKey(
                        name: "fk_jobs_venues_venue_id",
                        column: x => x.venue_id,
                        principalTable: "venues",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "scenarios",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    venue_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    schema_version = table.Column<int>(type: "integer", nullable: false),
                    document = table.Column<string>(type: "jsonb", nullable: false),
                    revision = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_scenarios", x => x.id);
                    table.ForeignKey(
                        name: "fk_scenarios_venues_venue_id",
                        column: x => x.venue_id,
                        principalTable: "venues",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "uploads",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    venue_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    content_type = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    bytes = table.Column<long>(type: "bigint", nullable: false),
                    width = table.Column<int>(type: "integer", nullable: false),
                    height = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_uploads", x => x.id);
                    table.CheckConstraint("ck_uploads_content_type", "content_type IN ('image/png', 'image/jpeg')");
                    table.ForeignKey(
                        name: "fk_uploads_venues_venue_id",
                        column: x => x.venue_id,
                        principalTable: "venues",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "runs",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    venue_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: false),
                    scenario_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: true),
                    job_id = table.Column<string>(type: "character varying(26)", maxLength: 26, nullable: true),
                    origin = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    engine_version = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    seed = table.Column<long>(type: "bigint", nullable: false),
                    metrics_hash = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    schema_version = table.Column<int>(type: "integer", nullable: false),
                    record = table.Column<string>(type: "jsonb", nullable: false),
                    size_bytes = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_runs", x => x.id);
                    table.CheckConstraint("ck_runs_origin", "origin IN ('job', 'clientReported')");
                    table.ForeignKey(
                        name: "fk_runs_jobs_job_id",
                        column: x => x.job_id,
                        principalTable: "jobs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_runs_scenarios_scenario_id",
                        column: x => x.scenario_id,
                        principalTable: "scenarios",
                        principalColumn: "id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "fk_runs_venues_venue_id",
                        column: x => x.venue_id,
                        principalTable: "venues",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_jobs_status_created_at",
                table: "jobs",
                columns: new[] { "status", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_jobs_venue_id_request_id",
                table: "jobs",
                columns: new[] { "venue_id", "request_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_runs_job_id",
                table: "runs",
                column: "job_id");

            migrationBuilder.CreateIndex(
                name: "ix_runs_scenario_id",
                table: "runs",
                column: "scenario_id");

            migrationBuilder.CreateIndex(
                name: "ix_runs_venue_id_origin_created_at",
                table: "runs",
                columns: new[] { "venue_id", "origin", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_scenarios_venue_id_created_at",
                table: "scenarios",
                columns: new[] { "venue_id", "created_at" });

            migrationBuilder.CreateIndex(
                name: "ix_uploads_venue_id",
                table: "uploads",
                column: "venue_id");

            migrationBuilder.CreateIndex(
                name: "ix_venues_last_activity_at",
                table: "venues",
                column: "last_activity_at");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "runs");

            migrationBuilder.DropTable(
                name: "uploads");

            migrationBuilder.DropTable(
                name: "jobs");

            migrationBuilder.DropTable(
                name: "scenarios");

            migrationBuilder.DropTable(
                name: "venues");
        }
    }
}

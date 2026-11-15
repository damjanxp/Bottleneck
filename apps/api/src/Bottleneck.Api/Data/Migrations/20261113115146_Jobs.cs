using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Bottleneck.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class Jobs : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_runs_job_id",
                table: "runs");

            migrationBuilder.AddColumn<int>(
                name: "job_run_index",
                table: "runs",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "scenario_id",
                table: "jobs",
                type: "character varying(26)",
                maxLength: 26,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "venue_snapshot",
                table: "jobs",
                type: "jsonb",
                nullable: false,
                defaultValue: "{}");

            migrationBuilder.CreateIndex(
                name: "ix_runs_job_id_job_run_index",
                table: "runs",
                columns: new[] { "job_id", "job_run_index" },
                unique: true,
                filter: "job_id IS NOT NULL AND job_run_index IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_runs_job_id_job_run_index",
                table: "runs");

            migrationBuilder.DropColumn(
                name: "job_run_index",
                table: "runs");

            migrationBuilder.DropColumn(
                name: "scenario_id",
                table: "jobs");

            migrationBuilder.DropColumn(
                name: "venue_snapshot",
                table: "jobs");

            migrationBuilder.CreateIndex(
                name: "ix_runs_job_id",
                table: "runs",
                column: "job_id");
        }
    }
}

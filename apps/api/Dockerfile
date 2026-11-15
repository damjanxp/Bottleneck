# Build context = repository root (the API embeds /schema, see Bottleneck.Schema.csproj):
#   docker build -f apps/api/Dockerfile -t bottleneck-api .
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /repo
# Restore first (cached until a project file or package version changes).
COPY apps/api/global.json apps/api/Directory.Build.props apps/api/Directory.Packages.props apps/api/
COPY apps/api/src/Bottleneck.Api/Bottleneck.Api.csproj apps/api/src/Bottleneck.Api/
COPY apps/api/src/Bottleneck.Schema/Bottleneck.Schema.csproj apps/api/src/Bottleneck.Schema/
RUN cd apps/api && dotnet restore src/Bottleneck.Api/Bottleneck.Api.csproj
COPY schema ./schema
COPY apps/api ./apps/api
# TreatWarningsAsErrors off here: the floating sdk:10.0 image is newer than global.json's 10.0.1xx and its
# newer analyzers (e.g. CA1873) would fail the deploy build; analyzers are enforced by CI instead.
RUN cd apps/api && dotnet publish src/Bottleneck.Api/Bottleneck.Api.csproj -c Release --no-restore -o /out -p:UseAppHost=false -p:TreatWarningsAsErrors=false

# Debian-based runtime (not chiseled) so the HEALTHCHECK can use bash's /dev/tcp: no curl needed.
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out ./
# Uploads live on a volume owned by the unprivileged "app" user (uid 1654).
RUN mkdir -p /data/uploads && chown -R app:app /data
ENV ASPNETCORE_HTTP_PORTS=8080 \
    Uploads__Path=/data/uploads \
    DOTNET_EnableDiagnostics=0 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
USER app
EXPOSE 8080
VOLUME /data/uploads
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["dotnet", "Bottleneck.Api.dll"]

$ErrorActionPreference = "Stop"

$OSRM_IMAGE = if ($env:OSRM_IMAGE) { $env:OSRM_IMAGE } else { "osrm/osrm-backend:latest" }
$OSRM_PBF_URL = if ($env:OSRM_PBF_URL) { $env:OSRM_PBF_URL } else { "https://geo2day.com/asia/indonesia/east_java.pbf" }

$ROOT_DIR = (Get-Item $PSScriptRoot).Parent.FullName
$DATA_DIR = Join-Path $ROOT_DIR "osrm-data"
$PBF_PATH = Join-Path $DATA_DIR "map.osm.pbf"

New-Item -ItemType Directory -Force -Path (Join-Path $DATA_DIR "bicycle") | Out-Null

if (-not (Test-Path $PBF_PATH)) {
    Write-Host "Downloading OSM extract: $OSRM_PBF_URL"
    Invoke-WebRequest -Uri $OSRM_PBF_URL -OutFile $PBF_PATH
}

function Prepare-Profile {
    param (
        [string]$Name,
        [string]$Profile
    )

    $Target = Join-Path $DATA_DIR $Name

    Write-Host "Preparing OSRM $Name graph..."
    Remove-Item -Path "$Target\*" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path $PBF_PATH -Destination (Join-Path $Target "map.osm.pbf") -Force

    $TargetUnix = $Target.Replace('\', '/')
    $ProfilesUnix = (Join-Path $ROOT_DIR "osrm-profiles").Replace('\', '/')

    docker run --rm -t -v "$TargetUnix`:/data" -v "$ProfilesUnix`:/profiles:ro" $OSRM_IMAGE osrm-extract -p "/profiles/$Profile.lua" /data/map.osm.pbf
    docker run --rm -t -v "$TargetUnix`:/data" $OSRM_IMAGE osrm-partition /data/map.osrm
    docker run --rm -t -v "$TargetUnix`:/data" $OSRM_IMAGE osrm-customize /data/map.osrm

    Remove-Item -Path (Join-Path $Target "map.osm.pbf") -Force
}

Prepare-Profile -Name "bicycle" -Profile "bicycle"

Write-Host "OSRM data ready. Run: docker compose up -d osrm-bicycle"

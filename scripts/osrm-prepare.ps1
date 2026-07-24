$ErrorActionPreference = "Stop"

$OSRM_IMAGE = if ($env:OSRM_IMAGE) { $env:OSRM_IMAGE } else { "ghcr.io/project-osrm/osrm-backend:v26.7.3-debian" }
$OSRM_PBF_URL = if ($env:OSRM_PBF_URL) { $env:OSRM_PBF_URL } else { "https://download.geofabrik.de/asia/indonesia/java-latest.osm.pbf" }
$VOLUME = if ($env:OSRM_VOLUME) { $env:OSRM_VOLUME } else { "dashly-osrm-bicycle" }
$ROOT_DIR = (Get-Item $PSScriptRoot).Parent.FullName
$WORK_DIR = Join-Path $ROOT_DIR ".osrm-work"
$PBF_PATH = Join-Path $WORK_DIR "java-latest.osm.pbf"

New-Item -ItemType Directory -Force -Path $WORK_DIR | Out-Null
docker volume create $VOLUME | Out-Null

if (-not (Test-Path $PBF_PATH)) {
    Write-Host "Downloading Java OSM data..."
    Invoke-WebRequest -Uri $OSRM_PBF_URL -OutFile $PBF_PATH
}

$WORK_UNIX = $WORK_DIR.Replace('\', '/')

docker run --rm --memory 5g --memory-swap 12g --cpus 4 -v "${WORK_UNIX}:/input:ro" -v "${VOLUME}:/data" $OSRM_IMAGE sh -c "rm -f /data/java.osrm* && osrm-extract -p /opt/bicycle.lua /input/java-latest.osm.pbf --output /data/java.osrm"
docker run --rm --memory 5g --memory-swap 12g --cpus 4 -v "${VOLUME}:/data" $OSRM_IMAGE osrm-partition /data/java.osrm
docker run --rm --memory 5g --memory-swap 12g --cpus 4 -v "${VOLUME}:/data" $OSRM_IMAGE osrm-customize /data/java.osrm
docker run --rm -v "${VOLUME}:/data" $OSRM_IMAGE test -f /data/java.osrm

Remove-Item $PBF_PATH -Force
Write-Host "OSRM bicycle graph ready in Docker volume: $VOLUME"

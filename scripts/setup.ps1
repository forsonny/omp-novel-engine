$ErrorActionPreference = "Stop"

Write-Host "OMP Novel Engine setup"

$missing = @()
$requiredBunVersion = [Version]"1.3.14"

function Test-RequiredCommand {
  param (
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$InstallUrl
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    Write-Warning "$Name was not found on PATH. Install it: $InstallUrl"
    $script:missing += $Name
    return
  }

  $versionOutput = & $Name --version
  $exitCode = $LASTEXITCODE
  $versionOutput | ForEach-Object { Write-Host $_ }
  if ($exitCode -ne 0) {
    Write-Warning "$Name was found but returned exit code $exitCode."
    $script:missing += $Name
    return
  }

  if ($Name -eq "bun") {
    try {
      $bunVersion = [Version](($versionOutput | Select-Object -First 1).Trim())
      if ($bunVersion -lt $requiredBunVersion) {
        Write-Warning "Bun $bunVersion is installed, but Bun $requiredBunVersion or newer is required."
        $script:missing += "bun>=$requiredBunVersion"
      }
    } catch {
      Write-Warning "Could not parse Bun version output: $versionOutput"
      $script:missing += "bun-version"
    }
  }
}

Test-RequiredCommand -Name "bun" -InstallUrl "https://bun.sh/docs/installation"
Test-RequiredCommand -Name "docker" -InstallUrl "https://docs.docker.com/desktop/"
Test-RequiredCommand -Name "omp" -InstallUrl "https://github.com/can1357/oh-my-pi"

if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker info | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Docker is installed but the daemon is not responding. Start Docker Desktop and rerun setup."
    $missing += "docker-daemon"
  }
}

New-Item -ItemType Directory -Force -Path "stories" | Out-Null
New-Item -ItemType Directory -Force -Path "stories/demo/canon/graph" | Out-Null
New-Item -ItemType Directory -Force -Path "stories/demo/chapters" | Out-Null
New-Item -ItemType Directory -Force -Path "stories/demo/diagrams" | Out-Null
New-Item -ItemType Directory -Force -Path "docker/story-os-mcp/stories" | Out-Null

if ($missing.Count -gt 0) {
  $items = $missing -join ", "
  throw "Setup prerequisites are missing or unavailable: $items"
}

Write-Host "Setup checks passed."
Write-Host "Next: .\scripts\docker-up.ps1"

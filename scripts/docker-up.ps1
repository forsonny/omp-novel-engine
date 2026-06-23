$ErrorActionPreference = "Stop"

$composeFile = "docker/compose.yml"
$mcpHealthUrl = "http://127.0.0.1:7127/health"
$qdrantHealthUrl = "http://127.0.0.1:6333/collections"
$timeoutSeconds = 120
$pollIntervalMs = 1000
$deadline = (Get-Date).AddSeconds($timeoutSeconds)

function Wait-ForUrl {
  param (
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Validator,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
      if (& $Validator $response) {
        Write-Host "$Label is ready."
        return $true
      }
    } catch {
      # Retry until timeout.
    }

    Start-Sleep -Milliseconds $pollIntervalMs
  }

  Write-Host "Timed out waiting for $Label readiness after $timeoutSeconds seconds."
  return $false
}

docker compose -f $composeFile up -d --build

$storyReady = Wait-ForUrl -Url $mcpHealthUrl -Label "Story OS MCP" -Validator {
  param($response)
  $response.ok -eq $true
}

$qdrantReady = Wait-ForUrl -Url $qdrantHealthUrl -Label "Qdrant" -Validator {
  param($response)
  $collections = $response.collections
  if ($null -eq $collections -and $null -ne $response.result) {
    $collections = $response.result.collections
  }
  return $null -ne $collections
}

if (-not ($storyReady -and $qdrantReady)) {
  throw "One or more services failed to become ready. Story OS ready=$storyReady; Qdrant ready=$qdrantReady."
}

Write-Host "Story OS MCP and Qdrant are ready."

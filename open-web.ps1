$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$job = Get-Job -Name "hikvision-site" -ErrorAction SilentlyContinue
if (-not $job) {
  Start-Job -Name "hikvision-site" -ScriptBlock {
    Set-Location "C:\Users\Administrator\Documents\hikvision 技术栈"
    npm run serve | Out-Null
  } | Out-Null
  Start-Sleep -Seconds 3
}

Start-Process "http://127.0.0.1:4173"

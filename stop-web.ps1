$job = Get-Job -Name "hikvision-site" -ErrorAction SilentlyContinue
if ($job) {
  Stop-Job $job
  Remove-Job $job
}

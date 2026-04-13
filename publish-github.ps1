$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".git")) {
  git init
  git branch -M main
}

git add .
git status --short

Write-Host ""
Write-Host "下一步："
Write-Host "1. 在 GitHub 新建一个公开仓库"
Write-Host "2. 运行：git remote add origin <你的仓库地址>"
Write-Host "3. 运行：git commit -m \"Initial publish\""
Write-Host "4. 运行：git push -u origin main"
Write-Host "5. 到 GitHub 仓库 Settings > Pages，Source 选择 GitHub Actions"

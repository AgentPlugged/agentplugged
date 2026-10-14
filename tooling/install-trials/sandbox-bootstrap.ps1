# Runs INSIDE Windows Sandbox (started at logon by agentplugged-trials.wsb, see local.mjs).
# A clean, disposable Windows: nothing is installed in it, nothing here touches the real machine.
#   1. installs Node.js (the portable archive from nodejs.org, no installer, no rights);
#   2. first trial WITHOUT Git: a creator who has Node.js but not Git must be told, plainly;
#   3. installs MinGit (the portable Git from git-for-windows, no installer);
#   3b. second trial, complete.
# The results are written in C:\Trial\out (mapped to a folder of the real machine); the exit code
# of each trial is in exit-code.txt, which local.mjs waits for.
param(
  [string]$Node = "24",
  [Parameter(Mandatory = $true)][string]$Package
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$in = "C:\Trial\in"
$out = "C:\Trial\out"
$tools = "C:\Trial\tools"
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Say($text) { Write-Host "[$(Get-Date -Format HH:mm:ss)] $text" }

$codes = @()
try {
  Say "Looking for the latest Node.js $Node"
  $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
  $release = $index | Where-Object { $_.version -like "v$Node.*" } | Select-Object -First 1
  if (-not $release) { throw "no Node.js $Node release found on nodejs.org" }
  $name = "node-$($release.version)-win-x64"
  Say "Downloading $name"
  Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/$name.zip" -OutFile "$tools\node.zip"
  Expand-Archive "$tools\node.zip" -DestinationPath $tools -Force
  $env:Path = "$tools\$name;" + $env:Path
  Say "Node.js $(node --version) ready; Git is not installed yet"

  $trial = "$in\install-trials\trial.mjs"
  Say "TRIAL 1 of 2: Node.js without Git (the first minutes of a creator who has only Node.js)"
  & node $trial --package $Package --shell all --scenario install-flow --summary "$out\1-without-git.md"
  $codes += $LASTEXITCODE

  Say "Looking for the latest MinGit"
  $git = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "agentplugged-trials" }
  $asset = $git.assets | Where-Object { $_.name -match "^MinGit-[\d.]+-64-bit\.zip$" } | Select-Object -First 1
  if (-not $asset) { throw "no MinGit archive in the latest Git for Windows release" }
  Say "Downloading $($asset.name)"
  Invoke-WebRequest $asset.browser_download_url -OutFile "$tools\mingit.zip"
  Expand-Archive "$tools\mingit.zip" -DestinationPath "$tools\git" -Force
  $env:Path = "$tools\git\cmd;" + $env:Path
  Say "$(git --version) ready"

  Say "TRIAL 2 of 2: complete (Node.js and Git, every scenario)"
  & node $trial --package $Package --shell all --summary "$out\2-complete.md"
  $codes += $LASTEXITCODE
}
catch {
  Say "The trial could not run: $_"
  $codes += 2
}
finally {
  $worst = ($codes | Measure-Object -Maximum).Maximum
  if ($null -eq $worst) { $worst = 2 }
  Set-Content -Path "$out\exit-code.txt" -Value $worst
  Say "Done (exit code $worst). The results are in the folder you started this from; you can close this window."
}

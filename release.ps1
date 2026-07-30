# release.ps1 -- one-command release for kids_player on WINDOWS.
# PowerShell port of release.sh (same steps, same conventions).
#
#   .\release.ps1                 build + publish the CURRENT package.json version
#   .\release.ps1 patch           bump 1.0.3 -> 1.0.4 first (also: minor / major / X.Y.Z)
#   .\release.ps1 patch "notes"   optional release notes as 2nd arg
#
# If script execution is blocked, run once:
#   powershell -ExecutionPolicy Bypass -File release.ps1
#
# Steps: sync main -> (optional bump+commit) -> tests -> signed build -> signature
# verification -> conventionally-named APK in apk_versions\ -> GitHub release (or
# clear manual instructions when the current gh login lacks write access).
#
# Requirements (see INSTALL_AND_RELEASE.md, "Step 0"): Node.js, Android Studio
# (JDK + SDK), the signing keystore in ~\.keystores\. JAVA_HOME / ANDROID_HOME
# are auto-defaulted to the standard Android Studio locations when unset.

param(
    [string]$Bump = "",
    [string]$Notes = ""
)

# Deliberately NOT "Stop": under Windows PowerShell 5.1, Stop + a stderr redirect
# on a native command (git/gh/apksigner) turns ordinary stderr output into a
# terminating error. Every native call below is checked via $LASTEXITCODE instead,
# and critical cmdlets pass -ErrorAction Stop explicitly.
$ErrorActionPreference = "Continue"
$Repo = "devfassaf/kids_player"
$ApkDir = "apk_versions"   # built releases are collected here (gitignored)

Set-Location -Path $PSScriptRoot

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# ---- guards ----------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is not installed" }

$SigningProps = if ($env:KIDS_PLAYER_SIGNING_PROPS) { $env:KIDS_PLAYER_SIGNING_PROPS }
                else { Join-Path $HOME ".keystores\kids-player.properties" }
if (-not (Test-Path $SigningProps)) {
    Die "No signing properties at $SigningProps -- see INSTALL_AND_RELEASE.md (moving the signing key)"
}
if (-not (Test-Path "www\js\keys.local.js")) {
    Die "Missing www\js\keys.local.js (YouTube API key) -- see INSTALL_AND_RELEASE.md"
}
if (git status --porcelain) { Die "Uncommitted git changes -- commit or stash first" }

# ---- Android build environment (the npm scripts hardcode macOS paths) -------
if (-not $env:JAVA_HOME)    { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $env:JAVA_HOME))    { Die "JAVA_HOME not found at $env:JAVA_HOME -- install Android Studio or set JAVA_HOME" }
if (-not (Test-Path $env:ANDROID_HOME)) { Die "ANDROID_HOME not found at $env:ANDROID_HOME -- install the Android SDK or set ANDROID_HOME" }

# ---- sync main (fetch from the public repo needs no credentials) ------------
$Branch = git rev-parse --abbrev-ref HEAD
if ($Branch -eq "main") {
    Say "Syncing main with GitHub..."
    git fetch origin
    git merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { Die "Local main has diverged from GitHub -- reconcile manually first" }
} else {
    Say "Warning: you are on branch '$Branch' (not main) -- the release will be built from this local code"
}

# ---- optional version bump ---------------------------------------------------
if ($Bump) {
    Say "Bumping version ($Bump)..."
    npm version $Bump --no-git-tag-version | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "Version bump failed (use patch / minor / major / X.Y.Z)" }
    $V = node -p "require('./package.json').version"
    git add package.json
    if (Test-Path package-lock.json) { git add package-lock.json }
    git commit -q -m "release v$V"
    Say "Bump commit created -- remember to push it (PR or direct push)"
} else {
    $V = node -p "require('./package.json').version"
}
$Tag = "v$V"
$Apk = Join-Path $ApkDir "kids-player-$Tag.apk"
# v1.0.19: a SECOND asset under a version-less name. GitHub resolves
# /releases/latest/download/<name> only for an exactly-named asset, so this stable
# name is what lets the website's download button hit the newest APK directly.
# Keep it identical to the href in docs/index.html (a test pins the two together).
$ApkLatest = Join-Path $ApkDir "kids-player.apk"

# ---- tests -------------------------------------------------------------------
Say "Running tests..."
npm test *> $null
if ($LASTEXITCODE -ne 0) { Die "Tests failed -- never release a broken build (run npm test for details)" }

# ---- signed build + verification ----------------------------------------------
Say "Building signed APK ($Tag)..."
npx cap copy android *> $null
if ($LASTEXITCODE -ne 0) { Die "cap copy failed -- run npx cap copy android for details" }
Push-Location android
& .\gradlew.bat assembleRelease *> $null
$BuildOk = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $BuildOk) { Die "Build failed -- run android\gradlew.bat assembleRelease for details" }

# apksigner: take the newest installed build-tools that has it
$ApkSigner = Get-ChildItem -Path (Join-Path $env:ANDROID_HOME "build-tools\*\apksigner.bat") -ErrorAction SilentlyContinue |
             Sort-Object FullName | Select-Object -Last 1
if (-not $ApkSigner) { Die "apksigner.bat not found under $env:ANDROID_HOME\build-tools -- install build-tools via Android Studio" }
$ReleaseApk = "android\app\build\outputs\apk\release\app-release.apk"
$Verify = & $ApkSigner.FullName verify --print-certs -v $ReleaseApk 2>$null
if (-not ($Verify | Select-String -Quiet "^Verifies")) { Die "Signature verification failed -- do NOT publish!" }

New-Item -ItemType Directory -Force -Path $ApkDir -ErrorAction Stop | Out-Null
Copy-Item $ReleaseApk $Apk -Force -ErrorAction Stop
Copy-Item $ReleaseApk $ApkLatest -Force -ErrorAction Stop
$SizeMb = [math]::Round((Get-Item $Apk).Length / 1MB, 1)
Say "Built and verified: $Apk (${SizeMb}M)"

# ---- publish -------------------------------------------------------------------
# The release body is what PARENTS read in the app's what's-new screen (v1.0.13):
# Hebrew, user-facing, one bullet per change. Technical detail belongs in the PR.
if (-not $Notes) { $Notes = "שיפורים ותיקונים כלליים" }
$Body = "## מה חדש`n`n$Notes"
Say "Publishing GitHub release..."
$Published = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh release create $Tag $Apk $ApkLatest --repo $Repo -t $Tag -n $Body 2>$null
    $Published = ($LASTEXITCODE -eq 0)
}
if ($Published) {
    Write-Host "`nOK: Published! Devices will see the update via the `"check for update`" button." -ForegroundColor Green
} else {
    $FullPath = Join-Path (Get-Location) $Apk
    $FullPathLatest = Join-Path (Get-Location) $ApkLatest
    Write-Host @"

WARNING: could not publish with the current gh account (missing gh, not logged
in, or no write access). Publish manually (2 minutes):
   1. https://github.com/$Repo/releases/new
   2. Tag: $Tag  <- type it by hand with an ENGLISH keyboard (invisible bidi
      marks from a Hebrew-context copy-paste broke version detection once)
   3. Drag BOTH files:  $FullPath
                        $FullPathLatest   <- the website download button needs
                        this exact name, or it 404s
   4. Publish release

   (or: gh auth login with the devfassaf account and run again)
"@
}

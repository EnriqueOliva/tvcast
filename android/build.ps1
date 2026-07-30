$ErrorActionPreference = 'Stop'

$proj  = 'C:\workshops\tvcast\android'
$tools = 'C:\workshops\rooting\A04\flagsecure\tools'

$jdkBin  = 'C:\Program Files\Java\jdk-21\bin'
$javac   = Join-Path $jdkBin 'javac.exe'
$jar     = Join-Path $jdkBin 'jar.exe'
$keytool = Join-Path $jdkBin 'keytool.exe'
$java    = Join-Path $jdkBin 'java.exe'

$androidJar   = Join-Path $tools 'android.jar'
$aapt2        = Join-Path $tools 'aapt2.exe'
$zipalign     = Join-Path $tools 'zipalign.exe'
$d8Jar        = Join-Path $tools 'd8.jar'
$apksignerJar = Join-Path $tools 'apksigner.jar'

$out = Join-Path $proj 'out'
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out, (Join-Path $out 'compiled_res'), (Join-Path $out 'gen'), (Join-Path $out 'classes'), (Join-Path $out 'dex') | Out-Null

function Invoke-Step($name, [scriptblock]$block) {
    Write-Output "==== $name ===="
    & $block
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" }
}

Invoke-Step 'aapt2 compile' {
    & $aapt2 compile --dir (Join-Path $proj 'res') -o (Join-Path $out 'compiled_res\res.zip')
}

Invoke-Step 'aapt2 link' {
    & $aapt2 link `
        -I $androidJar `
        --manifest (Join-Path $proj 'AndroidManifest.xml') `
        --java (Join-Path $out 'gen') `
        --min-sdk-version 29 `
        --target-sdk-version 30 `
        -o (Join-Path $out 'base.apk') `
        (Join-Path $out 'compiled_res\res.zip')
}

Invoke-Step 'javac' {
    $sources = @()
    $sources += Get-ChildItem (Join-Path $proj 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
    $sources += Get-ChildItem (Join-Path $out 'gen') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
    & $javac --release 8 -encoding UTF-8 -cp $androidJar -d (Join-Path $out 'classes') $sources
}

& $jar cf (Join-Path $out 'classes.jar') -C (Join-Path $out 'classes') .

Invoke-Step 'd8' {
    & $java -cp $d8Jar com.android.tools.r8.D8 --release --min-api 29 --lib $androidJar --output (Join-Path $out 'dex') (Join-Path $out 'classes.jar')
}

& $jar uf (Join-Path $out 'base.apk') -C (Join-Path $out 'dex') 'classes.dex'

Invoke-Step 'zipalign' {
    & $zipalign -f 4 (Join-Path $out 'base.apk') (Join-Path $out 'aligned.apk')
}

$keystore = Join-Path $proj 'tvcast.keystore'
if (-not (Test-Path $keystore)) {
    Invoke-Step 'keytool genkeypair' {
        & $keytool -genkeypair -keystore $keystore -storepass android -keypass android -alias tvcast -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=TV Cast, O=Personal, C=AR"
    }
}

Invoke-Step 'apksigner sign' {
    & $java -jar $apksignerJar sign --ks $keystore --ks-pass pass:android --key-pass pass:android --min-sdk-version 29 --v1-signing-enabled true --v2-signing-enabled true --out (Join-Path $out 'tvcast.apk') (Join-Path $out 'aligned.apk')
}

Invoke-Step 'apksigner verify' {
    & $java -jar $apksignerJar verify (Join-Path $out 'tvcast.apk')
}

Write-Output '==== BUILD OK ===='
Write-Output ("APK: " + (Join-Path $out 'tvcast.apk') + " (" + [math]::Round((Get-Item (Join-Path $out 'tvcast.apk')).Length / 1KB, 1) + " KB)")

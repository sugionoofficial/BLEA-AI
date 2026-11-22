# tools/ollama-tunnel-quick.ps1
#
# Menjalankan Cloudflare quick tunnel untuk Ollama lokal, lalu (opsional)
# memperbarui base_url provider "ollama" di Supabase secara otomatis.
#
# Dipakai kalau Anda TIDAK punya domain untuk named tunnel. URL quick tunnel
# berubah setiap cloudflared dijalankan ulang; skrip ini menghilangkan langkah
# "salin URL lalu tempel ke Admin Panel".
#
# Contoh:
#   .\tools\ollama-tunnel-quick.ps1
#   .\tools\ollama-tunnel-quick.ps1 -NoUpdate
#
# Untuk pembaruan otomatis, isi dulu dua environment variable (sekali saja):
#   setx SUPABASE_URL "https://<project-ref>.supabase.co"
#   setx SUPABASE_SERVICE_ROLE_KEY "<service-role-key>"
#
# PERINGATAN: service-role key memberi akses penuh ke database. Hanya pakai di
# komputer pribadi. Tanpa key tersebut skrip tetap jalan dan hanya mencetak SQL
# yang bisa Anda tempel ke Supabase SQL Editor.

[CmdletBinding()]
param(
  [int]$Port = 11434,
  [string]$Provider = 'ollama',
  [string]$SupabaseUrl = $env:SUPABASE_URL,
  [string]$ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY,
  [switch]$NoUpdate,
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
$httpHeader = "127.0.0.1:$Port"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. Ollama
Write-Step "Cek Ollama di http://127.0.0.1:$Port"
try {
  $tags = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tags" -TimeoutSec 10
} catch {
  Write-Host "Ollama tidak menjawab di port $Port. Jalankan Ollama lebih dulu (tray icon / 'ollama serve')." -ForegroundColor Red
  exit 1
}
$models = @($tags.models | ForEach-Object { $_.name })
if ($models.Count -eq 0) {
  Write-Warn2 "Belum ada model ter-pull. Jalankan: ollama pull huihui_ai/qwen2.5-abliterate:3b"
} else {
  Write-Ok ("Model: " + ($models -join ', '))
}

# ------------------------------------------------------------ 2. cloudflared
Write-Step "Cari cloudflared"
$cf = $null
$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cmd) {
  $cf = $cmd.Source
} else {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')) }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  if ($pf86) { $candidates.Add((Join-Path $pf86 'cloudflared\cloudflared.exe')) }
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { $cf = $p; break }
  }
}
if (-not $cf) {
  Write-Host "cloudflared tidak ditemukan. Jalankan: winget install --id Cloudflare.cloudflared" -ForegroundColor Red
  exit 1
}
Write-Ok $cf

# --------------------------------------------------------------- 3. Jalankan
$log = Join-Path $env:TEMP ("blea-ollama-tunnel-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
if (Test-Path $log) { Remove-Item $log -Force }

Write-Step "Mulai tunnel (log: $log)"
$proc = Start-Process -FilePath $cf `
  -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port", '--http-host-header', $httpHeader) `
  -RedirectStandardError $log `
  -WindowStyle Hidden `
  -PassThru

# ------------------------------------------------------------ 4. Ambil URL
Write-Step "Menunggu URL trycloudflare (maks $TimeoutSec detik)"
$url = $null
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if ($proc.HasExited) {
    Write-Host "cloudflared berhenti lebih awal. Isi log terakhir:" -ForegroundColor Red
    if (Test-Path $log) { Get-Content $log -Tail 15 | ForEach-Object { Write-Host "    $_" } }
    exit 1
  }
  if (Test-Path $log) {
    $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
    $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $url = $m.Value; break }
  }
}
if (-not $url) {
  Write-Host "URL belum muncul dalam $TimeoutSec detik. Coba jalankan ulang, atau cek log: $log" -ForegroundColor Red
  Write-Host "Matikan proses cloudflared dengan: Stop-Process -Id $($proc.Id)" -ForegroundColor Yellow
  exit 1
}
Write-Ok "URL: $url"

# ------------------------------------------------------------ 5. Verifikasi
Write-Step "Verifikasi endpoint publik"
$verified = $false
for ($i = 1; $i -le 20; $i++) {
  try {
    $resp = Invoke-WebRequest -Uri "$url/v1/models" -UseBasicParsing -TimeoutSec 15
    if ($resp.StatusCode -eq 200) { $verified = $true; break }
  } catch {
    Start-Sleep -Seconds 2
  }
}
if ($verified) {
  Write-Ok "GET $url/v1/models -> 200"
} else {
  Write-Warn2 "Belum 200 (tunnel kadang butuh beberapa detik). Cek manual: $url/v1/models"
}

# ------------------------------------------------- 6. Perbarui base_url BLEA
$needsUpdate = $true
if ($NoUpdate) { $needsUpdate = $false }

if ($needsUpdate -and $SupabaseUrl -and $ServiceRoleKey) {
  Write-Step "Perbarui base_url provider '$Provider' di Supabase"
  try {
    $body = @{ base_url = $url; updated_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
    $headers = @{
      apikey        = $ServiceRoleKey
      Authorization = "Bearer $ServiceRoleKey"
      Prefer        = 'return=representation'
    }
    $patchUrl = "$($SupabaseUrl.TrimEnd('/'))/rest/v1/provider_api_keys?provider=eq.$Provider"
    $res = Invoke-RestMethod -Uri $patchUrl -Method Patch -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 20
    if (@($res).Count -gt 0) {
      Write-Ok "base_url diperbarui: $url"
    } else {
      Write-Warn2 "Tidak ada baris provider '$Provider'. Tambahkan dulu lewat Admin Panel."
    }
  } catch {
    Write-Warn2 "Gagal memperbarui otomatis: $($_.Exception.Message)"
    $needsUpdate = $false  # supaya SQL tetap dicetak
  }
} elseif ($needsUpdate) {
  Write-Warn2 "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diset — lewati pembaruan otomatis."
  $needsUpdate = $false
}

if (-not $needsUpdate) {
  Write-Host ""
  Write-Host "Tempel SQL ini di Supabase SQL Editor:" -ForegroundColor Yellow
  Write-Host "  update public.provider_api_keys" -ForegroundColor White
  Write-Host "     set base_url = '$url', updated_at = now()" -ForegroundColor White
  Write-Host "   where provider = '$Provider';" -ForegroundColor White
}

Write-Host ""
Write-Host "Tunnel aktif (PID $($proc.Id))." -ForegroundColor Cyan
Write-Host "  Uji  : curl.exe -s $url/v1/models" -ForegroundColor Gray
Write-Host "  Stop : Stop-Process -Id $($proc.Id)" -ForegroundColor Gray
Write-Host "Catatan: menutup jendela ini TIDAK mematikan tunnel; laptop harus tetap menyala." -ForegroundColor Gray

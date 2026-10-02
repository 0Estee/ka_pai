<#
  一键发 Release：建 Release 并把 dist 里的 APK 传上去。

  用法：
    powershell -ExecutionPolicy Bypass -File tools/publish-release.ps1 -Version 0.29.0
    powershell -ExecutionPolicy Bypass -File tools/publish-release.ps1 -Version 0.29.0 -All   # 连历史包一起挂

  token 来源（按顺序）：-Token 参数  环境变量 KA_PAI_GH_TOKEN  $HOME\.ka_pai\github-token.txt
   token 绝不入库（.gitignore 已挡，且本脚本只从**仓库外**读）。
  需要的权限：该仓库的 Contents: Read and write。

  做四件事：
    1. 校验 token 与目标仓库（身份/写权限都实测一遍，不靠猜）
    2. tag v<版本> 不存在就本地建注释 tag 并推送（Release 必须挂 tag）
    3. POST 建 Release（已存在则直接报错退出，不覆盖）
    4. 上传 dist/ka-pai-<版本>.apk（-All 则把 dist 里所有 APK 都挂上）
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = '0Estee/ka_pai',
  [string]$Token = '',
  [string]$NotesFile = '',
  [switch]$All,
  [switch]$Prerelease
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $Token) { $Token = $env:KA_PAI_GH_TOKEN }
if (-not $Token) {
  $f = Join-Path (Join-Path $HOME '.ka_pai') 'github-token.txt'
  if (-not (Test-Path -LiteralPath $f)) { throw "找不到 token：既没给 -Token/环境变量，也没有 $f" }
  $Token = ([System.IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)).Trim()
}
if ($Token.Length -ne 93 -or -not $Token.StartsWith('github_pat_')) {  # 只校验形状，令牌本身绝不落盘到仓库
  throw "token 形状不对（长度 $($Token.Length)，应以 github_pat_ 开头、共 93 字符） 别把中文/空格带进去"
}
$H = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'ka_pai-agent'; Accept = 'application/vnd.github+json' }

# 1) 校验身份与写权限（写一个游离 blob：不产生提交、不污染历史）
$me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $H -TimeoutSec 20
Write-Host "身份: $($me.login)"
try {
  Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/git/blobs" -Headers $H `
    -Body '{"content":"cHJvYmU=","encoding":"base64"}' -ContentType 'application/json' -TimeoutSec 20 | Out-Null
} catch {
  throw "写权限不足（Contents 需要 Read and write）：$($_.ErrorDetails.Message)"
}
Write-Host "写权限: OK"

# 2) tag
$tag = "v$Version"
& git -C $root rev-parse -q --verify "refs/tags/$tag" | Out-Null
if ($LASTEXITCODE -ne 0) {
  & git -C $root tag -a $tag -m "卡牌对战原型 $Version"
  Write-Host "已建 tag $tag"
}
& git -C $root push origin $tag
Write-Host "tag $tag 已推送"

# 3) Release
$notes = if ($NotesFile -and (Test-Path -LiteralPath $NotesFile)) { [System.IO.File]::ReadAllText($NotesFile, [Text.Encoding]::UTF8) } else { "卡牌对战原型 $Version。装法：adb install -r ka-pai-$Version.apk" }
$payload = @{ tag_name = $tag; name = $Version; body = $notes; draft = $false; prerelease = [bool]$Prerelease } | ConvertTo-Json -Depth 5
$rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $H -Body $payload -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
Write-Host "Release 已建: $($rel.html_url)"

# 4) 附件
$assets = if ($All) { Get-ChildItem (Join-Path $root 'dist') -Filter 'ka-pai-*.apk' | Sort-Object Name }
          else { Get-ChildItem (Join-Path $root 'dist') -Filter "ka-pai-$Version.apk" }
if (-not $assets) { throw "dist 里找不到要上传的 APK（版本 $Version；-All 则找 ka-pai-*.apk）" }
foreach ($a in $assets) {
  $uri = "https://uploads.github.com/repos/$Repo/releases/$($rel.id)/assets?name=$($a.Name)"
  $r = Invoke-RestMethod -Method Post -Uri $uri -Headers $H -InFile $a.FullName -ContentType 'application/vnd.android.package-archive' -TimeoutSec 300
  Write-Host ("  + {0}  {1} KB" -f $a.Name, [Math]::Round($r.size / 1KB, 1))
}
Write-Host ""
Write-Host "完成：$($rel.html_url)"
Write-Host "固定链接：https://github.com/$Repo/releases/latest/download/ka-pai-$Version.apk"
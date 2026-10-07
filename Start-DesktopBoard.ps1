# Windows PowerShell 5.1+. No global execution-policy changes.
[CmdletBinding()]
param([switch]$Rebuild, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$toolchain = 'stable-x86_64-pc-windows-msvc'

function Refresh-ProcessPath {
    $paths = @((Join-Path $env:USERPROFILE '.cargo\bin'),
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path)
    $env:Path = ($paths | Where-Object { $_ }) -join ';'
}
function Invoke-Tool([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "命令执行失败：$Command（退出码 $LASTEXITCODE）。请查看上方提示，处理后重新双击启动文件。" }
}
function Install-Package([string]$Id, [string[]]$Extra = @()) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw '找不到 winget。请在 Microsoft Store 安装或更新“应用安装程序（App Installer）”，再重新启动本脚本。'
    }
    Write-Host "正在准备 $Id，请保持联网；系统可能弹出管理员确认。" -ForegroundColor Cyan
    Invoke-Tool 'winget.exe' (@('install', '--id', $Id, '--exact', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') + $Extra)
    Refresh-ProcessPath
}
function Test-WebView2 {
    $key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($path in @("HKCU:\Software\$key", "HKLM:\Software\WOW6432Node\$key", "HKLM:\Software\$key")) {
        $version = (Get-ItemProperty -LiteralPath $path -Name pv -ErrorAction SilentlyContinue).pv
        if ($version -and $version -match '^\d+\.\d+\.\d+\.\d+$' -and [version]$version -gt [version]'0.0.0.0') { return $true }
    }
    return $false
}
function Node-Version {
    if (Get-Command node.exe -ErrorAction SilentlyContinue) {
        $value = & node.exe -p 'process.versions.node' 2>$null
        if ($LASTEXITCODE -eq 0 -and $value -match '^\d+\.\d+\.\d+$') { return [version]$value }
    }
    return $null
}
function Test-Node {
    $version = Node-Version
    return ($version -and (($version.Major -eq 22 -and $version -ge [version]'22.13.0') -or $version.Major -eq 24 -or $version.Major -ge 26))
}
function VsWhere-Path {
    $base = ${env:ProgramFiles(x86)}
    if ($base) {
        $path = Join-Path $base 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    return $null
}
function Test-Sdk {
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots')) {
        $sdkRoot = (Get-ItemProperty -LiteralPath $key -Name KitsRoot10 -ErrorAction SilentlyContinue).KitsRoot10
        if (-not $sdkRoot) { continue }
        foreach ($directory in @(Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Lib') -Directory -ErrorAction SilentlyContinue)) {
            if ((Test-Path -LiteralPath (Join-Path $directory.FullName 'ucrt\x64\ucrt.lib')) -and
                (Test-Path -LiteralPath (Join-Path $directory.FullName 'um\x64\kernel32.lib'))) { return $true }
        }
    }
    return $false
}
function Test-Msvc {
    $vswhere = VsWhere-Path
    if (-not $vswhere) { return $false }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    return ($LASTEXITCODE -eq 0 -and [bool]$installation -and (Test-Sdk))
}
function Ensure-Msvc {
    if (Test-Msvc) { return }
    $vswhere = VsWhere-Path
    $instances = @()
    if ($vswhere) { $instances = @(& $vswhere -latest -products '*' -format json -utf8 | ConvertFrom-Json) }
    if ($instances.Count -gt 0) {
        # Add the workload to an existing VS instance instead of reinstalling it.
        $instance = $instances[0]
        $workload = if ($instance.productId -match 'BuildTools') { 'Microsoft.VisualStudio.Workload.VCTools' } else { 'Microsoft.VisualStudio.Workload.NativeDesktop' }
        $installer = Join-Path (Split-Path -Parent $vswhere) 'setup.exe'
        $arguments = @('modify', '--installPath', ('"' + $instance.installationPath + '"'),
            '--channelId', $instance.channelId, '--add', $workload, '--includeRecommended', '--passive', '--norestart')
        Write-Host '正在为已有 Visual Studio 补充 C++ 和 Windows SDK。请确认管理员提示。' -ForegroundColor Cyan
        $process = Start-Process -FilePath $installer -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -eq 3010) { throw 'C++ 工具安装完成，需要重启 Windows。重启后再次双击启动文件即可继续。' }
        if ($process.ExitCode -ne 0) { throw "C++ 工具安装失败（退出码 $($process.ExitCode)）。请关闭 Visual Studio 后重试。" }
    } else {
        Install-Package 'Microsoft.VisualStudio.2022.BuildTools' @('--override', '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
    }
    if (-not (Test-Msvc)) { throw '尚未检测到完整 C++ 工具及 Windows SDK。若安装提示需要重启，请重启 Windows 后再次启动。' }
}
function Existing-Executable {
    foreach ($relative in @('DesktopBoard.exe', 'DesktopBoard-current.exe', 'releases\DesktopBoard-current.exe', 'src-tauri\target\release\desktop-board.exe')) {
        $path = Join-Path $projectRoot $relative
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
    return $null
}

if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    Write-Host '请使用 64 位 Windows 和 64 位 Windows PowerShell。' -ForegroundColor Red
    exit 1
}
Refresh-ProcessPath
if ($CheckOnly) {
    [PSCustomObject]@{ WebView2 = Test-WebView2; Node = [string](Node-Version); CompatibleNode = Test-Node;
        CppAndSdk = Test-Msvc; Rustup = [bool](Get-Command rustup.exe -ErrorAction SilentlyContinue);
        ExecutableAvailable = [bool](Existing-Executable) }
    exit 0
}

$previousToolchain = $env:RUSTUP_TOOLCHAIN
$pushed = $false
try {
    Push-Location -LiteralPath $projectRoot
    $pushed = $true
    if (-not (Test-WebView2)) {
        Install-Package 'Microsoft.EdgeWebView2Runtime' @('--scope', 'user', '--silent')
        if (-not (Test-WebView2)) { throw 'WebView2 尚未准备完成，请重启启动文件再试。' }
    }
    $executable = Existing-Executable
    if (-not $executable -or $Rebuild) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json')) -or
            -not (Test-Path -LiteralPath (Join-Path $projectRoot 'src-tauri\Cargo.toml'))) {
            throw '未找到完整源码或 EXE。请先将项目 ZIP 全部解压，再从解压后的文件夹启动。'
        }
        Write-Host '首次从源码启动需要下载开发工具和依赖，可能耗时较长。完成后会自动打开板子。' -ForegroundColor Cyan
        if (-not (Test-Node)) { Install-Package 'OpenJS.NodeJS.LTS' @('--silent', '--force') }
        if (-not (Test-Node) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw '未找到兼容的 Node.js/npm。请关闭窗口后重新运行本脚本。' }
        Ensure-Msvc
        if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) {
            Install-Package 'Rustlang.Rustup' @('--override', '-y --profile minimal --default-toolchain stable-x86_64-pc-windows-msvc')
        }
        if (-not (Get-Command rustup.exe -ErrorAction SilentlyContinue)) { throw 'Rust 安装后尚未可用，请关闭窗口后重新运行。' }
        Invoke-Tool 'rustup.exe' @('toolchain', 'install', $toolchain, '--profile', 'minimal')
        $env:RUSTUP_TOOLCHAIN = $toolchain
        Write-Host '正在安装项目依赖……' -ForegroundColor Cyan
        Invoke-Tool 'npm.cmd' @('exec', '--yes', '--package=pnpm@10', '--', 'pnpm', 'install', '--frozen-lockfile')
        Write-Host '正在构建 EXE……' -ForegroundColor Cyan
        Invoke-Tool 'npm.cmd' @('run', 'tauri', '--', 'build', '--no-bundle')
        $executable = Join-Path $projectRoot 'src-tauri\target\release\desktop-board.exe'
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '构建没有生成预期的 EXE，请查看上方错误信息。' }
    }
    Write-Host '正在启动桌面随手记。以后仍可双击启动文件；程序退出入口位于托盘。' -ForegroundColor Green
    Start-Process -FilePath $executable -WorkingDirectory $projectRoot -WindowStyle Hidden
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    $env:RUSTUP_TOOLCHAIN = $previousToolchain
    if ($pushed) { Pop-Location }
}

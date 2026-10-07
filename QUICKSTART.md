# 小白启动说明

1. 下载项目 ZIP，完整解压到一个普通文件夹，避免放在需要管理员写入权限的目录。
2. 双击 **Start-DesktopBoard.cmd**。
3. 首次准备期间保持联网。遇到系统管理员确认，请允许依赖安装；完成后板子会自动打开。

已有 EXE 时直接启动，并在缺少 WebView2 时补装运行环境。从源码首次启动时，脚本会自动准备 Node.js、C++ Build Tools/Windows SDK 和 Rust，安装锁定的项目依赖，再构建并启动。已有环境会复用；第二次启动直接使用已生成的 EXE。

首次源码构建需要下载较大的开发工具，可能耗时较长。如果安装程序要求重启，重启后再次双击即可继续。如果提示没有 winget，在 Microsoft Store 安装或更新“应用安装程序（App Installer）”后重试。脚本不会自动重启电脑，也不会修改全局 PowerShell 执行策略。

## 复制一条命令启动

在解压后的项目文件夹空白处右键选择“在终端中打开”，复制下面一行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-DesktopBoard.ps1
```

更新源码后，需要重新构建时使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-DesktopBoard.ps1 -Rebuild
```

启动新版本前，从托盘退出旧版，避免单实例机制只唤醒旧程序。程序资料保存在当前使用者的 `%APPDATA%\DesktopBoard`，与项目源码分开。

仅支持 Windows。安装权限、公司电脑策略和网络连接可能影响首次准备，遇到失败时窗口会保留错误信息，不会继续启动未构建完成的程序。

实现依据：[WinGet 安装参数](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)、[Visual Studio 安装参数](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=vs-2022)、[WebView2 检测与分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。

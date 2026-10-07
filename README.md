# 桌面随手记

这是一个由Agent辅助完成的办公自动化与生产力辅助工具。

设置内打开“桌面图标让位动画"开启图标与记事板互动功能（读取与加载图标需要一段时间，点击没反应请耐心等待）。
在记事板内任意位置写字，或拖入图标、快捷方式、pdf、docx文档等，office系列文档会显示文档名。

裁剪工具可将符合裁剪条件的记事板按裁剪轨迹切成两半。
框选工具可框选范围内文本及图标文档等，进行整体移动。
铅笔工具可在记事板内任意位置涂画痕迹，shift+鼠标左键在该行绘制横线，用于手动划掉已处理事项。
橡皮擦工具可擦除对应内容痕迹。
所有工具均可通过右键返回上一级。

点击书签（可更换）后，当记事板有像素位于屏幕外侧则会自动吸附在角落。再次点击书签弹出。
## 怎么运行
在该目录打开终端，运行此脚本。
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-DesktopBoard.ps1
```
或
解压项目后双击['Start-DesktopBoard.cmd'](Start-DesktopBoard.cmd)
详细说明在['QUICKSTART.md'](QUICKSTART.md)
## 环境要求
- Windows 64 位，目前在 Windows 11 上验证。
- Node.js：22.13+ 的 22.x，或 24.x / 26.x，附带 npm。
- Rust MSVC 工具链。
- Visual Studio C++ Build Tools，安装“使用 C++ 的桌面开发”和 Windows SDK。
- Microsoft Edge WebView2 Runtime。
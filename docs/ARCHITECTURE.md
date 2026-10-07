# 工程说明

Windows 桌面随手记使用 Tauri 2、React、TypeScript 与 Rust。前端管理连续编辑、工具和绘制；Rust 管理窗口、文件、持久化与 Explorer 交互。本说明只保留通用实现信息。

## 编辑与持久化

`src/App.tsx` 协调板子、工具、菜单、窗口几何与 500ms 自动保存。`src/host.ts` 适配浏览器预览和 Tauri；`src/model.ts` 定义版本 2 状态与兼容字段。

`src/paper-editor.tsx` 使用一个 contenteditable，文字节点与不可编辑的文件图标属于同一个选择范围。`src/paper-model.ts` 中的 paperRows 保存逻辑行、图标和实际视觉行高度，items 是用于裁剪和兼容的坐标镜像。输入法组合期间避免重建 DOM；已发布的自身快照不作为外部变化重新套用。前方内容变化优先消耗留白和空行，保持后续信息的锚点。

编辑器使用 word-break: break-all 与 line-break: anywhere，按完整字符续行，避免浏览器将已写好的英文/数字单词或中文标点前的旧字整体退回下一行。文件图标和固定留白仍是完整内嵌元素。`tests/append-wrap.spec.ts` 比较每个原有字形的坐标，覆盖数字、英文、中文标点、emoji 与保存重载。

窗口缩放前固定现有视觉行宽度、留白和坐标，扩大或缩小边框不重排已有文字、图标、笔迹；溢出通过双向滚动查看。行距与字号联动，保持行号并缩放笔迹。`paper-scroll.ts`、`paper-selection.ts`、`text-eraser.ts` 和 `ink.ts` 分别处理滚动、整组移动、文本擦除及绘画。

`src/file-presentation.ts` 统一 Office/PDF 分类、类型角标、显示模式和占位；`src/file-tile.tsx` 负责实际图标/名称。行距足够时显示图标和下方文件名，较小时使用文字与左上角类型角标。普通快捷方式和目录只显示图标。`src/preview.tsx` 提供文本、图片及 PDF 首页预览。

`src-tauri/src/board_store.rs` 校验状态、备份、刷盘并原子替换文件。`commands.rs` 处理引用/托管、打开、导出和退出保存。多板子的结构操作先等待保存屏障，失败保留草稿；`board_ops.rs` 提供新建继承、按相对位置合并、删除存档和恢复。`paper_state.rs` 处理拆合后的编辑行与笔迹。删除条目不删除原引用文件。

资料位于 `%APPDATA%/DesktopBoard`，不随源码导出。新增状态字段保持可选；旧数据迁移至整板编辑模式，原完成勾选由铅笔划线替代。

## 窗口与书签

`src-tauri/src/window.rs` 直接设置位置，避免 Aero Snap；提供锁定、窗口层级、尺寸调整与网格适配。锁定同时禁止编辑、文件操作、移动、拉伸及工具操作，保留解锁和已启用的桌面碰撞效果。

`src/bookmark-styles.ts` 定义稳定样式 ID、名称、推荐配色与尺寸；鲸鱼样式 ID 为 whale，显示名称为“用户”。推荐颜色仅在点击后应用，选择书签不覆盖自定义背景。`bookmark-picker.tsx` 提供样式目录，`bookmark.tsx` 绘制透明 SVG/PNG，素材和生成提示词在 `src/assets/bookmarks`。

鲸鱼、中国结使用 66×90 CSS px 槽位，其他款式为 44×60。对应左侧留白为 50/28px，含 body 留白的纸面起点为 58/36px。切换大小款原子补偿 HWND 位置/宽度，保持实际内容位置；可选 bookmarkGutter 记录已应用补偿，旧资料只迁移一次，重载不重复扩宽。新建子板继承样式和相关参数。

`edge_hide.rs` 维护书签尺寸和窗口可见区域。展开时使用纸面与书签矩形并集，透明空白可穿透，不参与拉伸。开启书签收缩后，越过工作区边缘的窗口在松开鼠标时吸附；同时越过两边优先超出更多的一侧。区域内保留 16 CSS px 近边吸附。离开 1 秒后约 180ms 滑动隐藏，仅书签区域可见；点击展开并退出收缩，悬停保持隐藏。只保存展开坐标，锁定、工具和菜单操作暂停隐藏。

`native_chrome.rs` 在窗口所属线程安装 subclass，禁止失焦时原生边框重画；书签外框返回 HTCLIENT，实际纸面 CSS 把手显式启动 OS 拉伸。区域及尺寸跟随窗口和 DPI 更新。隐藏正文退出碰撞，避免不可见板子阻挡桌面图标。

`cut.rs` 与 `cut-overlay.tsx` 提供全屏剪刀轨迹、切割与取消；板子内外可拖动，右键取消并阻止桌面右键菜单。裁剪、合并和删除使用操作 token 与保存屏障。

## 桌面图标碰撞

`icon_engine.rs` 和 `collision.rs` 使用所属线程的 COM STA、消息泵和通道，每次重新获取 Explorer 接口。稳定身份优先来自绝对 Shell 解析名，虚拟项使用相对 PIDL 哈希；恢复或启动时重新枚举匹配活对象。

`src/collision-model.ts` 按 alpha 占用单元近似图案轮廓，保留透明空洞，文件名不参与碰撞。速度、偏转、弹簧、阻尼、接触冲量、摩擦和工作区边界共同驱动。图标回位受阻时规划绕行，深度重叠使用稳定分离方向；手动改变原生位置的图标退出当前管理。

`src/collision-overlay.tsx` 只绘制活动图标。`desktop_clip.rs` 临时裁剪这些图标的原位单元；Explorer 始终绘制未参与的图标、系统字体和名称。`file_icon.rs` 用绝对解析名提取 Shell 图像，保留非正方形比例，并用桌面尺寸参考图校准缓存缩小问题。回位后撤销裁剪、恢复原生显示。

`desktop_image.rs` 与 `desktop_clip.rs` 校验动画呈现。画布截图或 rAF 只说明内部渲染，不能证明 Windows 实屏显示。`icon_recovery.rs` 先刷盘恢复记录，再操作桌面；独立守护、心跳、所有权标识与会话 token 在退出、崩溃或动画失效时恢复区域。恢复尊重用户手动移动或隐藏的图标。

性能优化包括空间分桶、alpha 距离场、变换缓存、静止休眠和限制每帧回位规划。碰撞计算时间不等于实际帧率。尚未提供活动图标的完整右键/拖拽操作，未接入 Shell 实时通知；多显示器、不同 DPI 和 Explorer 重启重建需要进一步覆盖。

## 构建与检查

运行和构建命令见 [中文说明](../README.zh-CN.md)。默认关闭安装包，构建产物在 `src-tauri/target/release`，源码副本不包含已编译 EXE。

前端单元测试位于 src 中，浏览器及原生检查脚本位于 tests 中。原生检查需要独立资料目录和调试端口，部分脚本会移动鼠标并采集桌面，执行前应阅读脚本。不要将生成的截图或真实资料提交到 Git。

`native-bookmark-layout.mjs` 检查一次迁移、大小样式反复切换、逐字形/文件/笔迹位置和重载。`native-bookmark-pixels.mjs` 用自有纯色背板对比实屏 alpha 合成，并拒绝点击被其他应用遮挡的位置。`native-bookmark.mjs` 检查四边隐藏、越界、区域、真实拉伸与取消。浏览器截图与实屏验证分别记录，不能混为同一结果。

Git 导出范围与凭证扫描记录见 [Git 导出说明](GIT-EXPORT.md)。

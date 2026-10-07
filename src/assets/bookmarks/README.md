# 书签素材

用户提供的三张参考图用于制作四款书签：第一张仅取左上“极简几何”和右下“像素科技”，另取鲸鱼与中国结。所有款式均放在板子左上角。

- 几何：`../../bookmark.tsx` 中的原生 SVG。
- `pixel-v2.png`：依据补发的放大参考图重新生成的透明 PNG，1289×1220；近方形青蓝带身、深色阶梯燕尾与顶部高光。提示词见 [pixel-v2-prompt.md](pixel-v2-prompt.md)。
- `whale.png`：内置 image_gen 生成的透明 PNG，1024×1536；保留白色肚皮、海浪和高光。
- `knot.png`：内置 image_gen 生成的透明 PNG，1070×1470；中国结横向连接带缩至约半个花结直径，保留金色中心、珠子与短流苏。

没有修改原始 PNG 的透明通道。SVG 视口依据可见轮廓范围显示素材。鲸鱼、中国结使用 66×90 CSS px 槽位（原尺寸的 1.5 倍），其余款式仍为 44×60；左侧留白分别为 50/28px。切换时同步补偿窗口位置和宽度，保持纸面与已有文字、文件、笔迹的位置，原生可见/隐藏区域跟随尺寸；透明空白不参与拉伸。可选 bookmarkGutter 记录已应用的留白，旧资料只补偿一次。旧资料缺省为爱心；未知样式也回退为爱心。

成功生成所用提示词（built-in image_gen，transparent_background=true）：

## whale.png

Extract ONLY the blue whale bookmark from user's second reference image, ignoring other styles. A cute navy whale white belly pink cheeks water spout sitting on a vertical blue/white wave V-tail ribbon. Transparent background, no UI, no text, no board. Preserve character, intrinsic white. Single isolated compact icon tightly centered full height. Return real-alpha PNG.

## knot.png

Extract ONLY the coral-red Chinese-knot bookmark from user's reference image labeled 中国结·宽柄伸出 (ignore the newly generated whale and other images). Preserve flower-shaped red knot at left outer tip, cream/gold center, small gold bead, short hanging red tassel and a wide coral ribbon extending RIGHT to attach to board. Shorten the exposed horizontal ribbon to HALF the flower diameter, placing the flower close to the board. Compact nearly square/tall silhouette fitting44x60 pixel slot, front-facing soft handmade illustrated style. One full isolated bookmark tightly centered, real transparent alpha background. Remove board, interface, labels, backdrop and all surrounding shadows/glows. Only motif itself may be colored or opaque; intrinsically pale flower center remains opaque. No text, no white background panel, no gradient haze or external glow.

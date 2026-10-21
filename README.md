# card-change

Windows 本地卡牌显示映射工具：自己指定原卡 A 显示成卡面 B，支持静态图和本地动态骨架，保留原卡编号、名称、费用与技能。

## 下载与使用

在 [Releases](https://github.com/slyzhydt/card-change/releases) 下载 `card-change-0.2.1-windows-x64.zip`，完整解压后运行 `card-change.exe`。不需要安装 Python、Node.js。

1. 首次点击“从游戏资源准备数据”，选择本机游戏 `gameres/manifest.ssra`。相邻的 `chunks` 分卷需要已下载到本机。
2. 左侧按角色、卡名或编号选原卡；右侧选异画卡面、其他卡牌或本地动态异画。
3. 点“添加 / 替换选中映射”，可逐项开关、删除，保存配置供下次编辑。
4. 点“生成测试副本”，选择已有明文脚本层的游戏程序。程序副本位于工具 `out/trial-.../`，选择结果已内嵌，原文件不覆盖。
5. 手动安装与回滚步骤见 [使用说明](REDIRECTS.md)。只支持已有明文脚本层的输入，编译脚本 .jbin 的还原不属于本工具能力。

发布包不含游戏程序、分卷、卡牌表或美术资源；数据由使用者从自己的游戏文件准备。工具不会自动安装或启动游戏。角色皮肤更换已删除，按角色筛卡保留。

## 动态异画状态

- 当前完整本地候选：`unique_30134_skin`。使用者已反馈上一版映射测试成功。
- “异画卡面”中的两张 SR 动态卡已按实际资源接入：北极星的邀请（9810001）、你专属的守护天使（9810002）。它们的完整资源位于 `effect/`。v0.2.0 只检查 `card/` 而误报缺失，v0.2.1 已更正。主骨架、背景、效果层及 CFX 一起检查，缺配套文件则保留原卡。
- 窗口可以预览静态图，尚无动画预览。资源齐全不保证所有目标的动画与界面布局兼容。

## 源码运行与构建

需要 Windows、Python 3.11+ 和 Node.js。源码运行先安装 pefile，再运行 `python selector.py`；数据准备和预览需要官方 [ASSet Ripper CLI](https://github.com/cznrip/Chaos-Zero-Nightmare-ASSet-Ripper)，放到 `tools/asset-ripper/ChaosZeroNightmareRipper-CLI.exe`。

```powershell
python -m pip install -r requirements-build.txt
python -m unittest test_mapping test_reliability test_portable
node dryrun.js
python build_portable.py --node <node.exe> --ripper <ChaosZeroNightmareRipper-CLI.exe> --node-license <Node-LICENSE> --ripper-license <Ripper-LICENSE> --output dist
```

构建脚本要求新输出目录，保留已有产物。Windows 包内置 Node 运行检查，并内置解包器完成本地数据准备。全部 Python 依赖与运行组件的许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 检查与来源

36 项 Python 检查、72 项 JavaScript 检查；已从压缩包重新解压并在空 PATH 环境完成冻结程序自检、真实本地数据准备与程序副本生成。游戏程序未被本轮发布流程安装或启动。具体版本记录见 CHANGELOG.md。

基于 [yporoc/Chaoszeronightmare-RenderFreedom](https://github.com/yporoc/Chaoszeronightmare-RenderFreedom) 0.1.0 修改，沿用 [GPL-3.0](LICENSE)，对应源码与可执行包一起公开。

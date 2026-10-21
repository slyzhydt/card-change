# 来源与许可证

本项目基于 [yporoc/Chaoszeronightmare-RenderFreedom](https://github.com/yporoc/Chaoszeronightmare-RenderFreedom) 0.1.0 的源码继续修改，沿用 GPL-3.0。完整许可证见 LICENSE；发布包对应源码位于 https://github.com/slyzhydt/card-change 。本次修改包括卡牌选择器、资源检查、配置内嵌、可靠性检查和便携数据准备。

便携包另含以下独立组件；许可证副本位于 licenses/：

| 组件 | 用途与来源 | 许可证 |
|---|---|---|
| Python 3.11 与 Tcl/Tk | Python 官方运行时和标准窗口库 | PSF 与相应组件许可 |
| Node.js v24.13.0 | 离线 JavaScript 检查；https://github.com/nodejs/node/tree/v24.13.0 | MIT 与随 Node 分发的第三方许可 |
| pefile 2023.2.7 | 读取程序资源表；https://github.com/erocarrera/pefile | MIT |
| PyInstaller 6.16.0 bootloader | Windows 打包；https://github.com/pyinstaller/pyinstaller | GPL 与分发例外，见许可全文 |
| ASSet Ripper CLI | 从本地游戏文件准备表格和静态预览；https://github.com/cznrip/Chaos-Zero-Nightmare-ASSet-Ripper ，构建源提交 4bf2f1f1e4719a6670b5bd51ce80b6cef0a8915a | MIT，2025 akioukun |
| ASTC encoder、Zstandard、nlohmann/json | 上述解包器使用的组件 | Apache-2.0、BSD、MIT，见对应文件 |

`prepare_data.text_labels` 与 `assets/db-format-xor.hex` 的格式读取依据来自上述 MIT 解包器的 DBParser.cpp。hex 文件是公开游戏格式的静态 XOR 表，不是账号凭据。

发布包不包含游戏程序、清单、分卷、解出的卡牌表或美术素材。这些数据由使用者在本机选择自己的游戏资源后生成，留在 data/、work/、out/；这些目录不纳入源码发布。

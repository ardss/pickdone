# 音频资产来源与许可

## 真实录音（OpenGameArt，可自由分发）

| 文件 | 来源 | 作者 | 许可 |
|---|---|---|---|
| rain.mp3 | opengameart.org/content/rain-loop (1_7) | Ylmir | CC0 |
| rain_to_glass.mp3 | opengameart.org/content/rain-on-window-loop | alxl | CC-BY |
| cave.ogg | opengameart.org/content/loopable-dungeon-ambience | JaggedStone | CC0 |
| train.ogg | opengameart.org/content/background-rumble-noise | gryc | CC-BY |

> thunderstorm.wav（DoKashiteru, CC-BY 3.0）曾评估收录，因瞬态变化干扰专注被否决未随包分发。

## 程序化合成（历史方案，未随包分发）

`scripts/generate-audio.mjs` 曾合成 ocean/brook/fire/forest/coffee_shop/street.wav 等环境音（WAV/PCM 22.05kHz 单声道，14s 无缝循环），后改用「30 CC0 SFX Loops」真实录音替代，当前 assets/media 内已无合成文件。脚本保留作为音色再生成工具。

## 30 CC0 SFX Loops（OpenGameArt CC0 大礼包）

ambient.ogg（氛围音景）/ machine.ogg（机械舱）/ whitenoise.ogg（白噪音）/
waterflow.ogg（流水）/ boiling.ogg（沸腾）
来源：opengameart.org/content/30-cc0-sfx-loops（整包 CC0）

## 完成提示音（Kenney，CC0）

confirm1.ogg / confirm2.ogg / confirm3.ogg / confirm4.ogg
来源：kenney.nl/assets/confirmation-sounds（Confirmation SFX 包，整包 CC0）

注意：替换/更新素材后需同步 `TomatoBar.js` 的 MEDIA 映射扩展名。

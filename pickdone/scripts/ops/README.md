> **2026-11-01 Windows A/B 正式安装流程已切换到 [install-windows.ps1](./install-windows.ps1)。** 下文 update-machine.sh 是 beta.22 旧版记录，其中 Windows A/B 身份、SSH 登录和测试目录已过期；**禁止用它更新 Windows A/B 的正式安装**，其 board 分支仍属历史用途。
>
> 在目标机器已登录用户会话中使用：
> ```powershell
> # 默认只读检查现有安装和运行进程，机器身份不匹配则立即失败
> powershell -NoProfile -File .\install-windows.ps1 -Target A -Version 0.4.0-beta.24
> powershell -NoProfile -File .\install-windows.ps1 -Target B -Version 0.4.0-beta.24
> # 需要升级时，显式给官方 Setup 路径与 SHA256，并传 -Apply
> powershell -NoProfile -File .\install-windows.ps1 -Target A -Version <版本> -Installer <Setup.exe> -Sha256 <64位哈希> -Apply
> ```
> 已安装相同版本时 `-Apply` 不重复安装；缺少用户桌面会话、不正确主机、缺包或哈希不符时拒绝执行。脚本仅证明安装文件版本、注册表版本与真实运行进程路径一致，**用户界面和功能仍须独立 QA，且不执行公开 Publish**。

# pickdone/scripts/ops — 发版后三台机器更新

一个脚本分发三台机器：`update-machine.sh <local|win64|board>`。在开发机 Git Bash 里跑。
机器事实（IP、路径、注册表键）写死在脚本头部，变更时同步改脚本与本文。

```
bash update-machine.sh local  [--dist DIR] [--version X] [--yes]
bash update-machine.sh win64  [--dist DIR] [--version X] [--yes]
bash update-machine.sh board  [--dist DIR] [--version X] [--yes]
```

通用流程：前置检查（dist 存在 / 版本一致 / 目标可达）→ 备份（时间戳，落
`scripts/ops/backups/<machine>/<时间戳>/`，无自动清理，人工按版本保留最近 2–3 个）→
停应用 → 换装 → 启动 → 健康验证（进程 / 版本 / 日志无 corrupt）→ SUMMARY。
任何一步失败即停并打印回滚指引。停进程/换装前必须交互确认，`--yes` 跳过；绝不默认执行。

## 1. local — 本机 Windows A（F:\PickDone 安装版）

前置：`F:\PickDone` 已安装（NSIS 装的，**禁用 `Setup.exe /S`——有挂死前科**）；开发机 Git Bash、node、robocopy。
dist：`pickdone/dist-b*/win-unpacked`（自动取最新，或 `--dist`）。

做什么：备份 `%APPDATA%\PickDone`（用户数据 tar.gz）+ `resources\app.asar(.unpacked)` →
`taskkill` 停 PickDone.exe → `robocopy /MIR` 新 dist 的 resources 树 →
改注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<键>\DisplayVersion`
（键按 DisplayName=PickDone 自动探测，beta.22 实测为 `4503ebc1-8839-5326-87f5-8a103336c900`）→ 启动 → 验证。

回滚：关 PickDone，把备份里的 app.asar(.unpacked) 覆盖回 `F:\PickDone\resources\`，
用户数据 tar.gz 解回 `%APPDATA%\`，`reg add ... /v DisplayVersion /d <旧版本> /f`。

## 2. win64 — 局域网机 cat@192.168.31.64（C:\pickdone-drill\app）

前置：ssh 免密可达；对端有 powershell（启动用）与 tar（Win10+ 自带）。
dist：同上 win-unpacked。

做什么：tar 打包 dist → scp → `taskkill /IM PickDone.exe /F` → 旧 app 整目录 `move` 成
`C:\pickdone-drill\app-backup-<ts>` → 解包新包改名成 app → powershell Start-Process → 验证。

回滚：ssh 后停进程，`rmdir /s app`，`ren app-backup-<ts> app`，重启进程。

## 3. board — 板机 cat@192.168.31.68（ARM64 Linux，~/d11-src/pickdone/dist/linux-arm64-unpacked）

前置：ssh 免密可达；板机 glibc 2.31（vendor 的 better_sqlite3 prebuild 需 GLIBC 2.33，**不能直接用**）。
dist：`pickdone/dist-b*-linux/linux-unpacked`（自动取最新，或 `--dist`）。
注意：构建产物目录名是 `linux-unpacked`，板机上的部署目录名是 `linux-arm64-unpacked`，脚本已处理这个改名。

做什么：tar 打包 → scp → `pkill pickdone` → 旧 app `cp -a` 备份成 `~/d11-src/pickdone/app-backup-<ts>` →
解包到 `<app>.new` → **glibc .node 保留替换**：把
`resources/vendor/better-sqlite3-multiple-ciphers/prebuilds/linux-arm64.node`
从备份（找不到就用当前运行版）拷回新树 → rename 上位 →
`DISPLAY=:0 nohup ./pickdone >~/d11-src/pickdone/run-<ts>.log 2>&1 &` → 验证。

回滚：ssh 后 `pkill`，`rm -rf <app>`，`mv ~/d11-src/pickdone/app-backup-<ts> <app>`，再 `DISPLAY=:0 nohup` 启动。

## 未覆盖 / 已知限制

- 本机日志检查只扫 `%APPDATA%\PickDone\logs`（不存在则跳过）；.64 的日志未做 corrupt 检查（只验进程+版本）。
- 备份不自动清理；`scripts/ops/backups/` 会随发版增长，人工删旧的。
- 脚本只做了 `bash -n` 语法检查与 usage 路径冒烟，未对三台机器真跑过。

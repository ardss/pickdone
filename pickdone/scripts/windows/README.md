# PickDone Windows 受控升级（内部试装）

这份文档只描述本地内部候选，不授权公开发布，不创建定时任务，不修改 GitHub Release。

## 闭环与验收

1. Windows B 开发、定向单测，冻结 Git 提交与不重复的候选版本号。构建渲染器和 NSIS 安装包，验证版本、文件哈希、打包内容。
2. 升级前执行 `verify-upgrade.ps1 -ExpectedExe <当前正式版> -ExpectedVersion <当前版本> -KnownOldRoots <经核对的旧版目录>`，检查单一运行根、其他启动入口、数据库/密钥、安装注册项。
3. 同目录内旧版本由 NSIS 覆盖升级。不同目录中的已确认旧版本先禁用相关启动任务并导出配置、归档程序并校验 SHA256 后再移除。用户数据、设置、数据库、附件、密钥、恢复备份一律保留。发现未知安装根则拒绝处理。
4. Windows B 先执行 `deploy-in-place.ps1 -Installer <安装包> -InstalledExe <B正式路径> -ExpectedVersion <候选版本> -RecoveryRoot <私有目录> -ExpectedInstallerSha256 <文件哈希>`，脚本备份程序+静止数据库/WAL/SHM/配置/附件，安装验证版本、数据库不变、单程序根。
5. 把同 SHA256 安装包发送 Windows A，在原正式目录安装，并通过 `-StartTask PickDoneStart` 恢复用户桌面会话，不开第二个版本。
6. 分别 `verify-upgrade.ps1`，然后 B 私有运维目录运行 `check-sync-deep.ps1`：互配身份、网络、全部任务 ID/字段、应用重启等真实验收。
7. 仅内部候选核验通过后才考虑公开发布。GitHub Draft 不可用于自动更新；公开正式 Release 必须有 NSIS、latest.yml、SHA256，公开发布另行审批，CI 只在冻结候选时运行。

## 产品行为

- 后台可下载更新，但普通退出**不安装**；用户主动选择“立即重启更新”才执行安装。
- 有新版本时主窗口提示并可进入更新管理；配对设备版本不同则在同步页展示警告和更新入口，不自动断开同步。
- 内部测试版不存在已发布更新 feed 时解释 `FEED_MISSING`，不反复重试 404。
- 升级不得更换设备身份或盲目重合并数据库，不宣称 Sync v2 / Relay 已完成。

## 安全限制

- `deploy-in-place.ps1` 为本地固定路径的内部升级流程，不是公开自动更新服务。遇到安装失败保留原程序和数据备份，**不得直接覆盖任何可能出现新写入的数据库**。
- 脚本需要真实安装验收后才能标记为可用；只跑语法检查或单元测试不能算双机安装通过。

## beta.28 (internal-only) — failed-upgrade recovery and release-feed gates

The checked-in managed installer `deploy-in-place.ps1` is designed for Windows B first, then Windows A. **Do not use it to downgrade or to install a candidate whose hash is unknown.** It requires `verify-upgrade.ps1` and `restore-program.ps1` in the **same directory** on the target machine; a missing helper blocks installation before processes are stopped.

- The installer SHA-256, previous version, running executable roots, startup tasks, and the live encrypted database/key must pass preflight.
- After stopping a known installation, it backs up the entire old program, SQLite database/WAL/SHM, `db.key`, configuration and attachments.
- If backup fails **before** installation, the original application is preserved and an attempt is made to reopen it.
- If the NSIS installer runs but exits unsuccessfully, installs the wrong build, mutates the offline database/key or fails a post-install check, the wrapper invokes `restore-program.ps1`. The prior program is restored and the failed build is moved aside, not silently deleted. The backup remains intact.
- User data is never automatically overwritten during program rollback. If its hash changed, automatic reopening is withheld, preserving the original backup for deliberate, offline recovery. A successful restoration of the executable does **not** imply that the user's database has been rolled back.
- Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/test-restore-program.ps1` for small isolated fake-program tests. This uses a private temporary test directory and has no permission to kill the real PickDone instance. It validates hash refusal, program restoration, failure quarantine, and unchanged fake user data.
- **Scope limitation:** this is the **managed A/B upgrade script**, not Electron's built-in `electron-updater.quitAndInstall()` route. The application's automatic-update path still needs its own real published-release and failure-recovery acceptance test; do not represent these as the same path.

### Release channel acceptance

`electron-builder` is set to create **draft** GitHub releases; a draft does not provide a usable public `latest.yml` update feed. Internal `beta.27` installations are ahead of the public `beta.23` published channel; the next local `beta.28` version is source-only until separately packaged and accepted.

For a proposed public release, keep the candidate commit frozen, verify a fresh installer and local `latest.yml` match (size + SHA-512 + expected version), then verify the actual GitHub Release is **published**, not draft, with accessible `latest.yml`, installer and matching asset names. Finally test installed-client **update available → optional download → explicit install confirmation → restart → one executable root → data/sync health**, with the older installed test client kept in a **separate, isolated test environment**. Never test an in-place downgrade against the user's current live database. Public publication requires separate approval; do not promote a draft merely to clear a 404.

Network/DNS failures are transient and should not be presented as missing published releases. A first direct 404 must surface once; repeated identical missing-feed failures must not spam the user or create 30-second retry chains.

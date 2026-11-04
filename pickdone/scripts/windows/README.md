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

# SOP-06 发布流程(Release SOP)——可执行形态: npm run release X.Y.Z + npm run release:finalize X.Y.Z(流程已代码化,本文档是它的说明书;两者以脚本为准)

> 依据:2026-09-07 v0.2.0 发布实战教训——v0.1.0 无 Releases 条目、v0.1.1 残留重复 draft、
> v0.1.2 空正文、视觉门禁在 CI 裸机上不可跑(机器本地基线)。本 SOP 固化正确路径,凡发布照此执行。
> 规范:CHANGELOG 遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),版本号遵循 [SemVer](https://semver.org/)。

## 0. 版本号决策(发版前第一件事)

| 变更内容 | 版本动作 |
|---|---|
| 只有 bug 修复 / CI 基础设施 | patch:`0.x.Y+1` |
| 新增用户可见功能(含实验功能) | minor:`0.x+1.0` |
| 0.x 阶段不因"重构/内部改善"单独升 minor——跟随同船的功能取最高水位 |

## 1. 发版前检查单(全部勾完才允许打 tag)

1. **CHANGELOG.md**: `[Unreleased]` 内容整理成 `## [x.y.z] - YYYY-MM-DD` 段落(Added/Changed/Fixed 三段式,用户语言,不写内部术语);`[Unreleased]` 清空。
2. **package.json**: `version` 字段与目标 tag **严格一致**(release.yml 第一步会校验 `v$version == tag`,不一致直接红)。
3. **缓存戳**:凡动了 `assets/css/**` 或 index.html 直引资源,`npm run bump` 且与 css 改动同笔提交(check-cache-stamp 门禁)。
4. **全量门禁**:`npm run check:all` 本机 29 项全绿(含本机专属的视觉回归第④组)。
5. **实验功能口径**:新增/变更的实验功能在 CHANGELOG 标注 `(experimental, off by default)`,默认值必须为关。
6. **工作区干净**:`git status --short` 无未提交变更。

## 2. 发布执行(顺序固定)

```bash
git push origin main                     # ① 先 main 后 tag,顺序不可反
git tag vX.Y.Z && git push origin vX.Y.Z # ② tag 触发 release.yml(windows runner)
```

3. 盯 Actions:**Release** 工作流链 = 版本校验 → `check:all`(CI 自适应降道;视觉第④组 CI 自动跳过) → electron-builder 打包 → 打包产物活体验证(verify:packaged) → 上传 **Draft** Release。全程约 10 分钟。
4. 失败处理:**不删 tag 重跑旧代码**——在 main 上修复 → push → `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` → 重新打 tag 指向新 HEAD。
5. 构建成功后 **Draft Release 已自动挂产物**(Setup/Portable/latest.yml/SHA256SUMS.txt)。发布前人工三查:
   - 正文不为空(空正文=丑闻,从 CHANGELOG 对应段落填入 `gh release edit vX.Y.Z --notes-file ...`);
   - 标题统一 `PickDone x.y.z`;
   - 产物四个齐活、latest.yml 在列(自动更新依赖它)。
6. **点 Publish**。发布后到已装版本验证:应用内「检查更新」能收到新版本(latest.yml 生效)。

## 3. 发布后检查单

- [ ] Releases 页面:按版本递增、命名统一 `PickDone x.y.z`、每版有正文、无重复/无孤儿条目(历史教训:v0.1.1 曾残留一份重跑 draft、v0.1.0 曾整条缺失)
- [ ] 已装用户自动更新链路实测(或至少 latest.yml 内容 spot-check)
- [ ] 若含实验功能:确认默认关闭

## 4. 已知边界(记录在案,勿当作 bug 反复报)

- **视觉回归第④组是本机门禁**:基线为 gitignored 的机器本地文件(`tests/.artifacts/visual-web/`)且依赖本机 agent-browser;CI 自动跳过并打印说明。视觉护航责任在发版人本机的 `check:all`。
- **ui-smoke --launch 隔离守卫**:本机 9333 端口被活体应用占用时,该测试的守卫分支不可达(环境性假绿);CI 无此面。发版前关掉本机 Electron 实例即可。
- 0.1.x 的 dependabot 已停(手动控依赖)。

## 5. 跨平台现状(0.3.0 候选,截至 2026-09-07)

- **Linux**:CI 已有 Ubuntu Electron 活体门禁(xvfb),应用可运行;缺 `AppImage/deb` 打包目标。**成本最低,优先**。
- **macOS**:不需要自备 Mac 也可起步——GitHub Actions 的 `macos-14` runner 可构建**未签名 dmg**;缺口在 ① Apple Developer 账号($99/年)做签名+公证(否则用户要右键绕 Gatekeeper),② mac 侧交互适配(自定义标题栏/taskbar 集成等 Windows 专属分支)。建议路径:先出未签名 dmg 给愿意反馈的用户收问题清单,签名按需补。

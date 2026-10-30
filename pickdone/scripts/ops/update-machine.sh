#!/usr/bin/env bash
# update-machine.sh — 发版后三台机器手工更新的脚本化（beta.22 实战流程）
# 在开发机 Git Bash 里运行。用法见同目录 README.md。
#
# 用法: bash update-machine.sh <local|win64|board> [--version X] [--dist DIR] [--yes]
#
# 安全约定:
#  - 停进程/换装是破坏性步骤，默认必须交互确认，--yes 才跳过。
#  - 任何一步失败立即停，打印回滚指引（备份路径 + 恢复命令）。
#  - 本脚本只做更新，不做首次安装。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_DIR="$REPO_ROOT/pickdone"
TS="$(date +%Y%m%d-%H%M%S)"

# ---- 目标机器事实（beta.22 实战确认，改机器要同步改这里与 README） ----
WIN64_SSH="cat@192.168.31.64"
WIN64_APP='C:\pickdone-drill\app'
BOARD_SSH="cat@192.168.31.68"
BOARD_APP='~/d11-src/pickdone/dist/linux-arm64-unpacked'
BOARD_NODE_REL='resources/vendor/better-sqlite3-multiple-ciphers/prebuilds/linux-arm64.node'
LOCAL_INSTALL='F:\PickDone'

MACHINE="" ; WANT_VERSION="" ; DIST_DIR="" ; ASSUME_YES=0
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
die()  { printf '[FAIL] %s\n' "$*" >&2; print_rollback; exit 1; }

usage() { sed -n '2,8p' "$0"; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    local|win64|board) MACHINE="$1" ;;
    --version) WANT_VERSION="${2:?}"; shift ;;
    --dist) DIST_DIR="${2:?}"; shift ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac; shift
done
[ -n "$MACHINE" ] || usage

BACKUP_ROOT="$REPO_ROOT/pickdone/scripts/ops/backups/$MACHINE/$TS"

print_rollback() {
  cat <<EOF

========== 回滚指引 ==========
本次备份目录: $BACKUP_ROOT
(若备份尚未创建，说明未动目标机器，直接重跑即可)
按机器恢复:
  local : 关闭 PickDone 后，把备份里的 resources/ 与用户数据覆盖回原位，注册表
          DisplayVersion 改回旧版本号（键见 SUMMARY 或
          HKCU\\...\\Uninstall\\4503ebc1-8839-5326-87f5-8a103336c900）。
  win64 : ssh $WIN64_SSH 后，删除 $WIN64_APP，把备份目录改名/解包回 $WIN64_APP，再起进程。
  board : ssh $BOARD_SSH 后，rm -rf $BOARD_APP，把备份目录 mv 回 $BOARD_APP，
          确认 $BOARD_NODE_REL 是旧版 glibc 兼容 .node，DISPLAY=:0 nohup 启动。
==============================
EOF
}

confirm() {
  if [ "$ASSUME_YES" = "1" ]; then log "--yes: 跳过确认: $*"; return 0; fi
  printf '确认执行破坏性步骤? %s [y/N] ' "$*"
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || die "用户取消。"
}

# ---- 前置检查: 定位 dist 产物并取版本 ----
if [ -n "$DIST_DIR" ]; then
  DIST_PATH="$DIST_DIR"
else
  case "$MACHINE" in
    board) DIST_PATH="$(ls -d "$APP_DIR"/dist-b*-linux/linux-unpacked 2>/dev/null | sort | tail -1 || true)" ;;
    *)     DIST_PATH="$(ls -d "$APP_DIR"/dist-b*/win-unpacked 2>/dev/null | sort | tail -1 || true)" ;;
  esac
fi
[ -n "$DIST_PATH" ] || { echo "[FAIL] 未找到 dist 产物目录（--dist 指定）。查找根: $APP_DIR/dist-b*/win-unpacked 或 dist-b*-linux/linux-unpacked" >&2; print_rollback; exit 1; }
[ -f "$DIST_PATH/resources/package.json" ] || { echo "[FAIL] $DIST_PATH/resources/package.json 不存在，dist 不完整" >&2; print_rollback; exit 1; }
DIST_VERSION="$(node -p "require('$DIST_PATH/resources/package.json').version")"
if [ -n "$WANT_VERSION" ] && [ "$DIST_VERSION" != "$WANT_VERSION" ]; then
  echo "[FAIL] dist 版本 $DIST_VERSION != 期望 $WANT_VERSION" >&2; print_rollback; exit 1
fi
log "machine=$MACHINE dist=$DIST_PATH version=$DIST_VERSION"

# ---- 健康验证 ----
verify_local() {
  tasklist //FI "IMAGENAME eq PickDone.exe" | grep -qi PickDone.exe || { echo "[FAIL] PickDone.exe 未运行" >&2; return 1; }
  local v; v="$(node -p "require('$LOCAL_INSTALL_POSIX/resources/package.json').version")"
  [ "$v" = "$DIST_VERSION" ] || { echo "[FAIL] 本机 resources/package.json=$v != $DIST_VERSION" >&2; return 1; }
  if [ -d "$APPDATA/PickDone/logs" ]; then
    if grep -riEl 'corrupt|Cannot find module|Unable to load' "$APPDATA/PickDone/logs" --include='*.log' | head -1 | grep -q .; then
      echo "[FAIL] 本机日志发现 corrupt/加载失败，见上一行文件" >&2; return 1
    fi
  else
    warn "未找到 %APPDATA%\\PickDone\\logs，跳过日志检查"
  fi
  log "健康验证通过: 进程在 / 版本=$DIST_VERSION / 日志无 corrupt"
}

verify_win64() {
  ssh "$WIN64_SSH" "tasklist /FI \"IMAGENAME eq PickDone.exe\" | find /I \"PickDone.exe\" >nul" || { echo "[FAIL] .64 PickDone.exe 未运行" >&2; return 1; }
  local v
  v="$(ssh "$WIN64_SSH" "type \"$WIN64_APP\\resources\\package.json\"" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).version))")"
  [ "$v" = "$DIST_VERSION" ] || { echo "[FAIL] .64 版本=$v != $DIST_VERSION" >&2; return 1; }
  log "健康验证通过(.64): 进程在 / 版本=$DIST_VERSION（日志检查见 README 未覆盖项）"
}

verify_board() {
  ssh "$BOARD_SSH" "pgrep -f 'linux-arm64-unpacked/pickdone' >/dev/null" || { echo "[FAIL] 板机 pickdone 未运行" >&2; return 1; }
  local v
  v="$(ssh "$BOARD_SSH" "grep -o '\"version\": *\"[^\"]*\"' $BOARD_APP/resources/package.json | head -1 | cut -d'\"' -f4")"
  [ "$v" = "$DIST_VERSION" ] || { echo "[FAIL] 板机版本=$v != $DIST_VERSION" >&2; return 1; }
  if ssh "$BOARD_SSH" "test -d ~/d11-src/pickdone/logs"; then
    ssh "$BOARD_SSH" "grep -riE 'corrupt|Cannot find module|Unable to load' ~/d11-src/pickdone/logs --include='*.log' | head -3" && { echo "[FAIL] 板机日志有 corrupt/加载失败" >&2; return 1; } || true
  else
    warn "板机日志目录 ~/d11-src/pickdone/logs 不存在，跳过日志检查"
  fi
  log "健康验证通过(板机): 进程在 / 版本=$DIST_VERSION / glibc .node 已保留"
}

SUMMARY_LINES=()
summarize() {
  echo
  echo "========== SUMMARY =="
  echo "machine   : $MACHINE"
  echo "dist      : $DIST_PATH"
  echo "version   : $DIST_VERSION"
  echo "backup    : $BACKUP_ROOT"
  for l in "${SUMMARY_LINES[@]:-}"; do echo "$l"; done
  echo "结果      : 成功"
}

# ============================================================
case "$MACHINE" in
local)
  LOCAL_INSTALL_POSIX="$(cygpath -u "$LOCAL_INSTALL")"
  APPDATA_POSIX="${APPDATA:-$(cygpath -u "${LOCALAPPDATA}\\..")}"; APPDATA_POSIX="$(cygpath -u "$APPDATA")"
  [ -d "$LOCAL_INSTALL_POSIX" ] || { echo "[FAIL] 本机未安装: $LOCAL_INSTALL" >&2; print_rollback; exit 1; }
  [ -f "$LOCAL_INSTALL_POSIX/resources/package.json" ] || { echo "[FAIL] $LOCAL_INSTALL\\resources\\package.json 不存在" >&2; print_rollback; exit 1; }
  OLD_VERSION="$(node -p "require('$LOCAL_INSTALL_POSIX/resources/package.json').version")"
  log "本机当前版本: $OLD_VERSION -> 目标: $DIST_VERSION"

  # 备份: 用户数据 + asar（NSIS /S 禁用，不跑安装器）
  mkdir -p "$BACKUP_ROOT"
  log "备份用户数据 %APPDATA%\\PickDone ..."
  tar -czf "$BACKUP_ROOT/appdata-PickDone.tgz" -C "$(dirname "$APPDATA_POSIX")" "$(basename "$APPDATA_POSIX")" \
    || { echo "[FAIL] 用户数据备份失败" >&2; print_rollback; exit 1; }
  log "备份 asar ..."
  cp -a "$LOCAL_INSTALL_POSIX/resources/app.asar" "$BACKUP_ROOT/app.asar" \
    || { echo "[FAIL] asar 备份失败" >&2; print_rollback; exit 1; }
  [ -d "$LOCAL_INSTALL_POSIX/resources/app.asar.unpacked" ] && \
    cp -a "$LOCAL_INSTALL_POSIX/resources/app.asar.unpacked" "$BACKUP_ROOT/app.asar.unpacked"

  REG_KEY="$(powershell -NoProfile -Command "Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { \$p=Get-ItemProperty \$_.PSPath; if (\$p.DisplayName -like '*PickDone*') { \$_.PSChildName } }" | tr -d '\r' | head -1)"
  [ -n "$REG_KEY" ] || { echo "[FAIL] 注册表未找到 PickDone Uninstall 键" >&2; print_rollback; exit 1; }
  SUMMARY_LINES+=("reg-key  : HKCU\\...\\Uninstall\\$REG_KEY")

  confirm "停本机 PickDone.exe 并 robocopy /MIR 换装 $LOCAL_INSTALL\\resources"
  taskkill //IM PickDone.exe //F >/dev/null 2>&1 || warn "没有在运行的 PickDone.exe"
  sleep 2
  log "robocopy /MIR 换装 resources ..."
  robocopy "$(cygpath -w "$DIST_PATH/resources")" "$LOCAL_INSTALL\\resources" //MIR //NFL //NDL //NJH //NJS
  rc=$?; [ "$rc" -lt 8 ] || { echo "[FAIL] robocopy 失败 rc=$rc" >&2; print_rollback; exit 1; }
  log "改注册表 DisplayVersion=$DIST_VERSION ..."
  reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$REG_KEY" //v DisplayVersion //t REG_SZ //d "$DIST_VERSION" //f >/dev/null \
    || { echo "[FAIL] 注册表写入失败" >&2; print_rollback; exit 1; }

  log "启动 PickDone ..."
  cmd //c start "" "F:\\PickDone\\PickDone.exe"
  sleep 5
  verify_local || { echo >&2; print_rollback; exit 1; }
  SUMMARY_LINES+=("reg-display-version: $DIST_VERSION")
  ;;

win64)
  command -v ssh >/dev/null && command -v scp >/dev/null || { echo "[FAIL] 需要 ssh/scp" >&2; exit 1; }
  ssh -o ConnectTimeout=5 "$WIN64_SSH" "echo ok" >/dev/null || { echo "[FAIL] $WIN64_SSH 不可达" >&2; print_rollback; exit 1; }
  OLD_VERSION="$(ssh "$WIN64_SSH" "type \"$WIN64_APP\\resources\\package.json\"" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch(e){console.log('unknown')}})")"
  log ".64 当前版本: $OLD_VERSION -> 目标: $DIST_VERSION"

  mkdir -p "$BACKUP_ROOT"
  log "打包 dist win-unpacked -> tar.gz ..."
  TARBALL="$BACKUP_ROOT/win-unpacked-$DIST_VERSION.tar.gz"
  tar -czf "$TARBALL" -C "$DIST_PATH/.." "$(basename "$DIST_PATH")" \
    || { echo "[FAIL] 打包失败" >&2; print_rollback; exit 1; }
  log "scp -> $WIN64_SSH ..."
  scp -q "$TARBALL" "$WIN64_SSH:C:/pickdone-drill/win-unpacked-$DIST_VERSION.tar.gz" \
    || { echo "[FAIL] scp 失败" >&2; print_rollback; exit 1; }

  confirm "在 .64 上停进程 / 备份旧 app / 解包换装 ($WIN64_APP)"
  ssh "$WIN64_SSH" "taskkill /IM PickDone.exe /F >nul 2>&1 & exit 0" || true
  sleep 2
  ssh "$WIN64_SSH" "if exist \"$WIN64_APP\" move \"$WIN64_APP\" \"C:\\pickdone-drill\\app-backup-$TS\"" \
    || { echo "[FAIL] .64 旧 app 备份失败" >&2; print_rollback; exit 1; }
  ssh "$WIN64_SSH" "cd C:\\pickdone-drill && tar -xzf win-unpacked-$DIST_VERSION.tar.gz && ren win-unpacked app" \
    || { echo "[FAIL] .64 解包换装失败（旧包在 C:\\pickdone-drill\\app-backup-$TS）" >&2; print_rollback; exit 1; }

  log "在 .64 上启动 ..."
  ssh "$WIN64_SSH" "powershell -NoProfile -Command \"Start-Process '$WIN64_APP\\PickDone.exe'\"" \
    || { echo "[FAIL] .64 启动失败" >&2; print_rollback; exit 1; }
  sleep 5
  verify_win64 || { echo >&2; print_rollback; exit 1; }
  SUMMARY_LINES+=("remote-backup: C:\\pickdone-drill\\app-backup-$TS")
  ;;

board)
  ssh -o ConnectTimeout=5 "$BOARD_SSH" "echo ok" >/dev/null || { echo "[FAIL] $BOARD_SSH 不可达" >&2; print_rollback; exit 1; }
  OLD_VERSION="$(ssh "$BOARD_SSH" "grep -o '\"version\": *\"[^\"]*\"' $BOARD_APP/resources/package.json 2>/dev/null | head -1 | cut -d'\"' -f4" || true)"
  log "板机当前版本: ${OLD_VERSION:-unknown} -> 目标: $DIST_VERSION"

  mkdir -p "$BACKUP_ROOT"
  log "打包 dist linux-unpacked -> tar.gz ..."
  TARBALL="$BACKUP_ROOT/linux-unpacked-$DIST_VERSION.tar.gz"
  tar -czf "$TARBALL" -C "$DIST_PATH/.." "$(basename "$DIST_PATH")" \
    || { echo "[FAIL] 打包失败" >&2; print_rollback; exit 1; }
  log "scp -> $BOARD_SSH ..."
  scp -q "$TARBALL" "$BOARD_SSH:~/linux-unpacked-$DIST_VERSION.tar.gz" \
    || { echo "[FAIL] scp 失败" >&2; print_rollback; exit 1; }

  confirm "在板机上停进程 / 备份旧 app（保留 glibc .node）/ 解包换装 ($BOARD_APP)"
  ssh "$BOARD_SSH" "pkill -f 'linux-arm64-unpacked/pickdone' 2>/dev/null; exit 0" || true
  sleep 2
  ssh "$BOARD_SSH" "if [ -d $BOARD_APP ]; then cp -a $BOARD_APP ~/d11-src/pickdone/app-backup-$TS; fi" \
    || { echo "[FAIL] 板机旧 app 备份失败" >&2; print_rollback; exit 1; }
  ssh "$BOARD_SSH" "rm -rf $BOARD_APP.new && mkdir -p ~/d11-src/pickdone/dist && tar -xzf ~/linux-unpacked-$DIST_VERSION.tar.gz -C ~/d11-src/pickdone/dist && mv ~/d11-src/pickdone/dist/linux-unpacked $BOARD_APP.new" \
    || { echo "[FAIL] 板机解包失败" >&2; print_rollback; exit 1; }
  # glibc 兼容 .node 保留替换: 板机 glibc 2.31, vendor prebuild 需 2.33 —— 必须用运行版/备份里的旧 .node
  ssh "$BOARD_SSH" "SRC=~/d11-src/pickdone/app-backup-$TS/$BOARD_NODE_REL; [ -f \$SRC ] || SRC=$BOARD_APP/$BOARD_NODE_REL; \
    if [ -f \$SRC ]; then mkdir -p \$(dirname $BOARD_APP.new/$BOARD_NODE_REL) && cp -a \$SRC $BOARD_APP.new/$BOARD_NODE_REL && echo '.node 保留替换: '\$SRC; \
    else echo '警告: 找不到 glibc 兼容 .node，回退目录里也没有'; exit 1; fi" \
    || { echo "[FAIL] glibc .node 保留替换失败，禁止上板" >&2; print_rollback; exit 1; }
  ssh "$BOARD_SSH" "mv $BOARD_APP.new $BOARD_APP" \
    || { echo "[FAIL] 换装 rename 失败" >&2; print_rollback; exit 1; }

  log "板机启动 (DISPLAY=:0 nohup) ..."
  ssh "$BOARD_SSH" "cd $BOARD_APP && DISPLAY=:0 nohup ./pickdone >~/d11-src/pickdone/run-$TS.log 2>&1 & exit 0" \
    || { echo "[FAIL] 板机启动失败" >&2; print_rollback; exit 1; }
  sleep 5
  verify_board || { echo >&2; print_rollback; exit 1; }
  SUMMARY_LINES+=("remote-backup: ~/d11-src/pickdone/app-backup-$TS")
  SUMMARY_LINES+=("run-log     : ~/d11-src/pickdone/run-$TS.log")
  ;;
esac

summarize

#!/usr/bin/env bash
# =============================================================================
# backup-dsh.sh
# dsh 升级前备份 ~/.dsh 全量本地状态（Session 日志 / Profile 配置 / preset / 数据库）。
#
# 背景: dsh 0.1.7 起 Session 日志自动迁移 V4 且不可降级，Agent preset 改由
# 插件组合包声明，settings.yaml 仅一次性导入——升级前先留档，出问题可整树回滚。
#
# 备份内容: ~/.dsh 整树（含 .agent-presets 等隐藏目录），仅排除可用
# pnpm install 重建的 node_modules / .pnpm 依赖目录。
# 输出: <dest>/dsh-backup-<时间戳>.tar.gz，附 .sha256 校验与 .manifest 清单。
#
# 用法:
#   scripts/backup-dsh.sh [--dest PATH] [--force]
# 选项:
#   --dest PATH   备份输出目录（默认 ~/.dsh-backups）
#   --force       dsh 正在运行时仍备份（数据库可能写入中，快照可能不一致）
# =============================================================================
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
BACKUP_DEST="${BACKUP_DEST:-$HOME/.dsh-backups}"
BACKUP_FORCE="${BACKUP_FORCE:-0}"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) BACKUP_DEST="${2:-}"; shift 2 ;;
    --force) BACKUP_FORCE=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

if [[ ! -d "$DSH_HOME" ]]; then
  echo "✗ 未找到 $DSH_HOME，无需备份" >&2
  exit 1
fi

if [[ "$BACKUP_FORCE" != "1" ]] && pgrep -f "dsh-desktop|deepseek-ai/dsh" >/dev/null 2>&1; then
  echo "✗ 检测到 dsh 正在运行（dsh-desktop / @deepseek-ai/dsh）" >&2
  echo "  rel.db 等本地数据可能正在写入，此刻备份的快照可能不一致。" >&2
  echo "  请先退出 dsh 桌面应用与 web 服务后重试，或加 --force 跳过检查。" >&2
  exit 1
fi

mkdir -p "$BACKUP_DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DEST/dsh-backup-$STAMP.tar.gz"

cleanup() { rm -f "$OUT" "$OUT.sha256" "$OUT.manifest"; }
trap cleanup ERR

PARENT="$(cd "$DSH_HOME/.." && pwd)"
BASENAME="$(basename "$DSH_HOME")"

echo "来源: $DSH_HOME ($(du -sh "$DSH_HOME" | cut -f1))"
echo "输出: $OUT"
echo "----------------------------------------"

tar -C "$PARENT" -czf "$OUT" \
  --exclude node_modules \
  --exclude '*/node_modules' \
  --exclude '*/node_modules/*' \
  --exclude .pnpm \
  --exclude '*/.pnpm' \
  --exclude '*/.pnpm/*' \
  --exclude .pnpm-store \
  --exclude '*/.pnpm-store/*' \
  "$BASENAME"

gzip -t "$OUT"
shasum -a 256 "$OUT" > "$OUT.sha256"
{
  echo "created: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "source:  $DSH_HOME"
  echo "node:    $(node --version 2>/dev/null || echo unknown)"
  echo "dsh:     $(dsh --version 2>/dev/null || npx --no-install @deepseek-ai/dsh --version 2>/dev/null || echo unknown)"
  echo "entries: $(tar -tzf "$OUT" | wc -l | tr -d ' ')"
  echo "size:    $(du -h "$OUT" | cut -f1)"
} > "$OUT.manifest"

trap - ERR

echo "✔ 备份完成: $OUT"
echo "✔ 校验和:   $OUT.sha256"
echo "✔ 清单:     $OUT.manifest"
echo "----------------------------------------"
echo "恢复方式（会覆盖现有 ~/.dsh，先确认目标干净）:"
echo "  shasum -a 256 -c \"$OUT.sha256\""
echo "  tar -C \"$PARENT\" -xzf \"$OUT\""

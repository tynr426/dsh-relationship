#!/usr/bin/env bash
# =============================================================================
# install-relationship-preset.sh
# 把 dsh-relationship 的「关系记忆」（preset id: relationship）安装为 DSH 用户 preset。
#
# DSH 的 agent preset 是目录：目录名即 preset id，放在
#   ~/.dsh/.agent-presets/<id>/
# 含 agent.cordis.yml（必需）+ preset.yml（可选元数据）。复制即可被发现，
# 无需重启（发现逻辑每次调用都重读目录）。
#
# 用法:
#   scripts/install-relationship-preset.sh [--dest PATH] [--dry-run]
# 选项:
#   --dest PATH   目标预设目录（默认 ~/.dsh/.agent-presets/relationship）
#   --dry-run     仅预览，不写入
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/preset/relationship"
REL_DEST="${REL_DEST:-$HOME/.dsh/.agent-presets/relationship}"
REL_DRY_RUN="${REL_DRY_RUN:-0}"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) REL_DEST="${2:-}"; shift 2 ;;
    --dry-run) REL_DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

if [[ ! -f "$SRC_DIR/agent.cordis.yml" ]]; then
  echo "✗ 未找到 preset 源文件: $SRC_DIR/agent.cordis.yml" >&2
  exit 1
fi

echo "来源: $SRC_DIR"
echo "目标: ${REL_DEST}（DSH 用户 preset：relationship / 关系记忆）"
echo "----------------------------------------"

if [[ "$REL_DRY_RUN" == "1" ]]; then
  echo "[DRY-RUN] 创建 ${REL_DEST}/"
  echo "[DRY-RUN] 复制 agent.cordis.yml"
  echo "[DRY-RUN] 复制 preset.yml"
else
  mkdir -p "$REL_DEST"
  cp "$SRC_DIR/agent.cordis.yml" "$REL_DEST/agent.cordis.yml"
  cp "$SRC_DIR/preset.yml" "$REL_DEST/preset.yml"
  echo "✔ 已安装 relationship preset：${REL_DEST}"
fi

echo "----------------------------------------"
echo "完成。现在 DSH 的 agentPreset.list 会包含 id=relationship（关系记忆）。"
echo "在 DSH 会话中选择「关系记忆」即可对话录入；工作台入口在 GUI 侧边栏「关系记忆」。"

// 关系记忆工作台本地配置：数据目录与端口。对话模型与凭据统一由 DSH 管理。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.REL_DATA_DIR || path.join(ROOT, 'data');
export const MATERIALS_DIR = path.join(DATA_DIR, 'materials');
export const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
export const MEMORIES_PATH = path.join(DATA_DIR, 'memories.json');
export const MATERIALS_PATH = path.join(DATA_DIR, 'materials.json');
export const MATERIAL_REPORTS_PATH = path.join(DATA_DIR, 'material-reports.json');
export const ORGANIZE_QUESTIONS_PATH = path.join(DATA_DIR, 'organize-questions.json');
export const PLAN_SUGGESTIONS_PATH = path.join(DATA_DIR, 'plan-suggestions.json');
export const PLANS_PATH = path.join(DATA_DIR, 'plans.json');
export const RELATION_TYPES_PATH = path.join(DATA_DIR, 'relation_types.json');
export const META_PATH = path.join(DATA_DIR, 'meta.json');

export const DEFAULTS = {
  port: 8901,
  host: '127.0.0.1',
};

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MATERIALS_DIR, { recursive: true });
}

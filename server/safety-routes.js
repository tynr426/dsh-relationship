import crypto from 'node:crypto';
import store, { STORE_MODE } from './store-facade.js';
import { createBackup, listBackups, exportBackup, previewBackup, restoreBackup, requiresDataRecovery } from './data-safety.js';
import { broadcast } from './sse.js';

let restorePreview = null;
let backupError = '';

export function recordBackupError(error) {
  backupError = error ? String(error.message || error) : '';
}

function send(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function requireLocalRequest(req) {
  const host = new URL(`http://${req.headers.host || ''}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
    || req.headers['sec-fetch-site'] === 'cross-site'
    || (req.headers.origin && new URL(req.headers.origin).origin !== host.origin)) {
    throw store.httpError(403, '数据安全操作仅允许从本机工作台执行');
  }
  if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw store.httpError(415, '请使用 JSON 请求');
  }
}

export function handleSafetyRequest(req, res, url, body, context) {
  const parts = url.pathname.split('/').filter(Boolean);
  const dataRoute = parts[1] === 'data';
  const revisionRoute = parts[1] === 'memory-revisions';
  const historyRoute = parts[1] === 'memories' && parts[3] === 'history';
  if (!dataRoute && !revisionRoute && !historyRoute) return false;
  try {
    requireLocalRequest(req);
    if (dataRoute) {
      if (req.method === 'GET' && url.pathname === '/api/data/status') {
        send(res, { ok: true, backend: STORE_MODE, backups: listBackups(), backupError, recoveryRequired: requiresDataRecovery() });
        return true;
      }
      if (req.method === 'GET' && parts[2] === 'backups' && parts[3] && parts[4] === 'download' && parts.length === 5) {
        const envelope = exportBackup(parts[3]);
        res.writeHead(200, {
          'Content-Type': 'application/json', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="relationship-backup-${Date.now()}.json"`,
        });
        res.end(JSON.stringify(envelope));
        return true;
      }
      if (req.method !== 'POST') return false;
      if (requiresDataRecovery()) throw store.httpError(503, '数据恢复未完成，请先下载现有备份并重启工作台，不要删除恢复日志');
      if (context.busy) throw store.httpError(409, '仍有操作正在保存，请稍后重试');
      if (url.pathname === '/api/data/backups') {
        const backup = createBackup('manual');
        recordBackupError(null);
        send(res, { ok: true, backup });
        return true;
      }
      if (url.pathname === '/api/data/restore/preview') {
        restorePreview = null;
        const envelope = body.backupId ? exportBackup(body.backupId) : body.backup;
        const preview = previewBackup(envelope);
        const token = crypto.randomBytes(24).toString('hex');
        restorePreview = { token, envelope, generation: context.generation, expiresAt: Date.now() + 10 * 60_000 };
        send(res, { ok: true, preview, token });
        return true;
      }
      if (url.pathname === '/api/data/restore/confirm') {
        const preview = restorePreview;
        if (!preview || body.token !== preview.token || Date.now() > preview.expiresAt) {
          throw store.httpError(409, '恢复预览已失效，请重新预览');
        }
        if (preview.generation !== context.generation) {
          restorePreview = null;
          throw store.httpError(409, '预览后数据发生变化，请重新预览再恢复');
        }
        restorePreview = null;
        const result = restoreBackup(preview.envelope);
        context.onRestore();
        broadcast('data.restored', { at: new Date().toISOString() });
        send(res, { ok: true, ...result });
        return true;
      }
      return false;
    }
    if (revisionRoute && req.method === 'POST' && parts.length === 4) {
      if (parts[3] === 'confirm') {
        const result = store.confirmMemoryRevision(parts[2]);
        broadcast('memory.changed', { action: 'revision-confirmed', revisionId: parts[2] });
        send(res, { ok: true, result });
        return true;
      }
      if (parts[3] === 'reject') {
        const proposal = store.rejectMemoryRevision(parts[2]);
        broadcast('memory.changed', { action: 'revision-rejected', revisionId: parts[2] });
        send(res, { ok: true, proposal });
        return true;
      }
    }
    if (historyRoute && req.method === 'GET' && parts.length === 4) {
      send(res, { ok: true, history: store.memoryHistory(parts[2]) });
      return true;
    }
    if (historyRoute && req.method === 'POST' && parts.length === 6 && parts[5] === 'restore') {
      const memory = store.restoreMemoryHistory(parts[2], parts[4]);
      broadcast('memory.changed', { action: 'history-restored', memoryId: parts[2] });
      send(res, { ok: true, memory });
      return true;
    }
    return false;
  } catch (error) {
    const message = error.recoveryRequired
      ? `恢复未完成，已暂停业务读写。请先下载现有备份并重启工作台，不要删除恢复日志（${error.code}）`
      : error.message || '数据安全操作失败';
    send(res, { ok: false, error: message }, error.status || 400);
    return true;
  }
}

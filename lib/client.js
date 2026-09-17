/**
 * dsh-relationship 浏览器半：GUI 侧边栏「关系记忆」入口 + 会话区嵌入工作台。
 * 纯 DOM（无 React）：自愈 MutationObserver 注入入口行；点击后以同源
 * iframe（/api/dsh-relationship/workbench/）接管会话区，工具栏可「在标签页打开」。
 * 与其他面板插件（dsh-qa / dsh-law / taskboard / ssh / lawbench）共用 dsh-panel-activate 互斥约定。
 */
window.__ModuleLoader__.load({
  id: 'dsh-relationship',
  factory: function () {
    'use strict';
    var exports = {};
    var inject = [];

    var VIEW_URL = '/api/dsh-relationship/workbench/';
    var ENTRY_SELECTOR = '[data-dsh-relationship-entry]';
    var VIEW_SELECTOR = '[data-dsh-relationship-view]';
    var ACTIVE_ATTR = 'data-dsh-relationship-active';
    var PANEL_ATTRS = ['data-dsh-qa-active', 'data-dsh-dev-active', 'data-dsh-law-active', 'data-dsh-taskboard-active', 'data-dsh-ssh-active', 'data-dsh-lawbench-active'];

    var ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.4C7.3 13.4 2.5 10.4 2.5 6.9a2.9 2.9 0 0 1 5.5-1.3A2.9 2.9 0 0 1 13.5 6.9c0 3.5-4.8 6.5-5.5 6.5Z"/></svg>';
    var POPOUT_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5H3v9h9v-3.5"/><path d="M9 2h5v5"/><path d="M7.5 8.5 14 2"/></svg>';
    var CLOSE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

    var CSS = [
      '[data-pane="conversation"]{position:relative}',
      '[data-dsh-relationship-view]{position:absolute;inset:0;display:none;z-index:60;background:var(--dsw-alias-bg-base,#fff);flex-direction:column}',
      'html[data-dsh-relationship-active]:not([data-dsh-qa-active]):not([data-dsh-law-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-lawbench-active]):not([data-dsh-dev-active]) [data-dsh-relationship-view]{display:flex}',
      'html[data-dsh-relationship-active]:not([data-dsh-qa-active]):not([data-dsh-law-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-lawbench-active]):not([data-dsh-dev-active]) [data-pane="conversation"] > :not([data-dsh-relationship-view]),html[data-dsh-relationship-active]:not([data-dsh-qa-active]):not([data-dsh-law-active]):not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]):not([data-dsh-lawbench-active]):not([data-dsh-dev-active]) [class*="centerCol"] > :not([data-dsh-relationship-view]){display:none !important}',
      '.rel-viewbar{flex:none;display:flex;align-items:center;gap:10px;height:42px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#e4e9f2);background:var(--dsw-alias-bg-base,#fff)}',
      '.rel-viewbar-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1c2333);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rel-viewbar-actions{display:flex;gap:4px;align-items:center}',
      '.rel-viewbar-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6478);cursor:pointer}',
      '.rel-viewbar-btn:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#eef1f6);color:var(--dsw-alias-label-primary,#1c2333)}',
      '.rel-frame{flex:1;min-height:0;width:100%;border:none;background:#f6f4f1}',
      '.rel-entry{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 12px;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-secondary,#5b6478);cursor:pointer;font-size:13px;white-space:nowrap}',
      '.rel-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover,#eef1f6);color:var(--dsw-alias-label-primary,#1c2333)}',
      '.rel-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active,#e8effc);color:var(--dsw-alias-label-primary,#1c2333);font-weight:600}',
      '.rel-entry-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}',
      '.rel-entry-label{overflow:hidden;text-overflow:ellipsis}',
    ].join('\n');

    function ensureStyle() {
      if (document.getElementById('dsh-relationship-style')) return;
      var style = document.createElement('style');
      style.id = 'dsh-relationship-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var entryButton;
    var viewRoot;

    function isActive() { return document.documentElement.getAttribute(ACTIVE_ATTR) === 'true'; }
    function setActive(active) {
      if (active) document.documentElement.setAttribute(ACTIVE_ATTR, 'true');
      else document.documentElement.removeAttribute(ACTIVE_ATTR);
      if (entryButton !== undefined) {
        if (active) entryButton.dataset.active = '';
        else delete entryButton.dataset.active;
      }
    }

    function conversationPane() {
      var pane = document.querySelector('[data-pane="conversation"]');
      if (pane !== null) return pane;
      return document.querySelector('[class*="centerCol"]') || undefined;
    }

    function ensureView() {
      if (viewRoot !== undefined && viewRoot.isConnected) return viewRoot;
      var pane = conversationPane();
      if (pane === undefined) return undefined;

      viewRoot = document.createElement('div');
      viewRoot.dataset.dshRelationshipView = '';

      var bar = document.createElement('div');
      bar.className = 'rel-viewbar';
      var title = document.createElement('span');
      title.className = 'rel-viewbar-title';
      title.textContent = '关系记忆工作台 · dsh-relationship';
      var actions = document.createElement('span');
      actions.className = 'rel-viewbar-actions';

      var popout = document.createElement('button');
      popout.type = 'button';
      popout.className = 'rel-viewbar-btn';
      popout.title = '在标签页打开';
      popout.innerHTML = POPOUT_ICON;
      popout.addEventListener('click', function () { try { window.open(VIEW_URL, '_blank', 'noopener'); } catch (e) { /* ignore */ } });

      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'rel-viewbar-btn';
      close.title = '关闭';
      close.innerHTML = CLOSE_ICON;
      close.addEventListener('click', function () { setActive(false); });

      actions.appendChild(popout);
      actions.appendChild(close);
      bar.appendChild(title);
      bar.appendChild(actions);

      var frame = document.createElement('iframe');
      frame.className = 'rel-frame';
      frame.src = VIEW_URL;
      frame.title = '关系记忆工作台';
      frame.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-downloads');

      viewRoot.appendChild(bar);
      viewRoot.appendChild(frame);
      pane.insertBefore(viewRoot, pane.firstChild);
      return viewRoot;
    }

    function toggleView() {
      var existed = viewRoot !== undefined && viewRoot.isConnected;
      if (ensureView() === undefined) {
        window.alert('关系记忆工作台暂不可用：页面挂载点未就绪（请稍后重试）。');
        return;
      }
      if (isActive() && existed) { setActive(false); return; }
      // 中心列单占用者约定：打开本面板时让位其他面板插件。
      for (var i = 0; i < PANEL_ATTRS.length; i++) {
        document.documentElement.removeAttribute(PANEL_ATTRS[i]);
      }
      document.dispatchEvent(new CustomEvent('dsh-panel-activate', { detail: 'dsh-relationship' }));
      setActive(true);
    }

    function onOtherActivate(event) {
      var detail = event.detail;
      if (detail !== undefined && detail !== 'dsh-relationship' && isActive()) setActive(false);
    }
    document.addEventListener('dsh-panel-activate', onOtherActivate);

    // 工作台 iframe 内点击「返回 DSH」→ 关闭面板回到 DSH 主页面
    function onFrameMessage(event) {
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source === 'dsh-relationship' && data.type === 'close-panel') setActive(false);
    }
    window.addEventListener('message', onFrameMessage);

    function sidebarRoot() {
      var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      var logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
      return logoOwner ?? (column.firstElementChild || undefined);
    }

    function newSessionButton(root) {
      var nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (var i = 0; i < root.children.length; i++) {
        if (root.children[i].tagName === 'BUTTON') return root.children[i];
      }
      return undefined;
    }

    function createEntry() {
      var entry = document.createElement('button');
      entry.type = 'button';
      entry.dataset.dshRelationshipEntry = '';
      entry.className = 'rel-entry';
      entry.setAttribute('aria-label', '关系记忆');
      entry.innerHTML = '<span class="rel-entry-icon">' + ICON + '</span><span class="rel-entry-label">关系记忆</span>';
      entry.addEventListener('click', function () { toggleView(); });
      entryButton = entry;
      return entry;
    }

    function placeEntry(root, entry) {
      var button = newSessionButton(root);
      if (button === undefined) return false;
      if (entry.parentElement !== root) {
        var row = button.closest('[class*="logoRow"]');
        var base = (row !== null && row.parentElement === root) ? row : button;
        var family = Array.prototype.filter.call(root.children, function (el) {
          return el instanceof HTMLElement && el.matches('[data-dsh-relationship-entry], [data-dsh-qa-entry], [data-dsh-dev-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-law-entry], [data-dsh-lawbench-entry]');
        });
        var anchor = family.length > 0 ? family[0] : base.nextElementSibling;
        root.insertBefore(entry, anchor);
      }
      return true;
    }

    function mountSidebarEntry() {
      var entry = createEntry();
      var root;
      var placed = false;

      var tryPlace = function () {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (placed) {
          if (document.body.contains(entry)) return;
          rootObserver.disconnect();
          root = undefined;
          placed = false;
        }
        if (root === undefined) root = sidebarRoot();
        if (root === undefined) return;
        placed = placeEntry(root, entry);
        if (placed) rootObserver.observe(root, { childList: true, subtree: true });
      };

      var waitObserver = new MutationObserver(function () { tryPlace(); });
      waitObserver.observe(document.body, { childList: true, subtree: true });

      var rootObserver = new MutationObserver(function () {
        if (root === undefined || !root.isConnected) { placed = false; tryPlace(); return; }
        if (!root.contains(entry)) placed = placeEntry(root, entry);
      });

      tryPlace();

      return function () {
        waitObserver.disconnect();
        rootObserver.disconnect();
        entry.remove();
        entryButton = undefined;
        setActive(false);
        if (viewRoot !== undefined) { viewRoot.remove(); viewRoot = undefined; }
      };
    }

    function apply(ctx) {
      ensureStyle();
      var disposers = [];
      try { disposers.push(mountSidebarEntry()); }
      catch (error) { console.warn('[dsh-relationship] mount failed:', error); }
      ctx.effect(function () {
        return function () {
          document.removeEventListener('dsh-panel-activate', onOtherActivate);
          window.removeEventListener('message', onFrameMessage);
          for (var i = 0; i < disposers.length; i++) disposers[i]();
        };
      }, 'dsh-relationship: ui mounts');
    }

    exports.apply = apply;
    exports.inject = inject;
    return exports;
  },
});

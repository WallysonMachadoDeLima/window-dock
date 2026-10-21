const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEARTBEAT_MS = 5000;
const POLL_MS = 3000;
const STALE_MS = 20000;
const PRIORITY_BASE = 100000;
const IS_MAC = process.platform === 'darwin';
const EDITOR_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup'
];

let liveDir;
let selfFile;
let selfUri;
let statusItems = [];
let lastSig = '';
let renderTimer;

// ---------- helpers ----------

function normUri(s) {
  if (!s) return null;
  try {
    const u = /^[a-z][\w+.-]*:\/\//i.test(s) ? vscode.Uri.parse(s) : vscode.Uri.file(s);
    return u.toString();
  } catch {
    return null;
  }
}

function currentWindowUri() {
  const wf = vscode.workspace.workspaceFile;
  if (wf && wf.scheme !== 'untitled') return wf.toString();
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri.toString();
  return null;
}

function currentWindowName() {
  return (vscode.workspace.name || 'Janela').replace(/ \(Workspace\)$/, '');
}

function uriLabel(uri) {
  try {
    const u = vscode.Uri.parse(uri);
    return u.scheme === 'file' ? u.fsPath.replace(require('os').homedir(), '~') : uri;
  } catch {
    return uri;
  }
}

function nameFromUri(uri) {
  try {
    return path.basename(vscode.Uri.parse(uri).path).replace(/\.code-workspace$/, '');
  } catch {
    return uri;
  }
}

function shortcutLabel(key) {
  return IS_MAC ? `⌘${key}` : `Ctrl+Alt+${key}`;
}

function cfg() {
  return vscode.workspace.getConfiguration('windowDock');
}

function getItems() {
  return (cfg().get('items') || [])
    .filter(it => it && it.uri)
    .map(it => ({ ...it, uri: normUri(it.uri) || it.uri }));
}

async function saveItems(items) {
  await cfg().update('items', items, vscode.ConfigurationTarget.Global);
  scheduleRender();
}

function isPinned(it) {
  return it.pinned !== false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------- live window registry ----------

function heartbeat() {
  if (!selfUri) return;
  const data = { uri: selfUri, name: currentWindowName(), pid: process.pid, ts: Date.now() };
  try {
    const tmp = `${selfFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, selfFile);
  } catch {
    // ignore
  }
}

function readLive() {
  const now = Date.now();
  const live = new Map();
  let files = [];
  try {
    files = fs.readdirSync(liveDir);
  } catch {
    // ignore
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(liveDir, f);
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!pidAlive(d.pid) || now - d.ts > STALE_MS) {
        fs.unlinkSync(p);
        continue;
      }
      live.set(d.uri, d);
    } catch {
      // partially written or already removed
    }
  }
  if (selfUri) live.set(selfUri, { uri: selfUri, name: currentWindowName() });
  return live;
}

function updateSelf() {
  const next = currentWindowUri();
  if (next === selfUri) return;
  removeSelf();
  selfUri = next;
  selfFile = selfUri
    ? path.join(liveDir, crypto.createHash('sha1').update(selfUri).digest('hex') + '.json')
    : undefined;
  heartbeat();
}

function removeSelf() {
  if (!selfFile) return;
  try {
    fs.unlinkSync(selfFile);
  } catch {
    // ignore
  }
}

// ---------- rendering ----------

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}

function buildView() {
  const showUnpinned = cfg().get('showUnpinned');
  const defaultIcon = cfg().get('defaultIcon') || '$(window)';
  const live = readLive();
  const entries = [];
  const known = new Set();
  for (const it of getItems()) {
    known.add(it.uri);
    if (!isPinned(it) && !live.has(it.uri)) continue;
    entries.push({
      name: it.name || nameFromUri(it.uri),
      icon: it.icon || defaultIcon,
      uri: it.uri,
      pinned: isPinned(it)
    });
  }
  if (showUnpinned) {
    for (const [uri, d] of live) {
      if (!known.has(uri)) entries.push({ name: d.name || nameFromUri(uri), icon: defaultIcon, uri, pinned: false });
    }
  }
  return entries.map((e, i) => ({
    ...e,
    key: i < 9 ? i + 1 : undefined,
    open: live.has(e.uri),
    current: e.uri === selfUri
  }));
}

function render() {
  const showNames = cfg().get('showNames');
  const view = buildView();
  const sig = JSON.stringify([view, showNames]);
  if (sig === lastSig) return;
  lastSig = sig;

  statusItems.forEach(s => s.dispose());
  statusItems = [];

  view.forEach((e, i) => {
    const s = vscode.window.createStatusBarItem(`windowDock.item${i}`, vscode.StatusBarAlignment.Left, PRIORITY_BASE - i);
    s.name = `Window Dock: ${e.name}`;
    s.text = `${e.icon}${showNames ? ' ' + e.name : ''}`;
    if (e.current) s.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    else s.color = new vscode.ThemeColor('disabledForeground');

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${e.icon} ${e.name}**\n\n`);
    md.appendMarkdown(e.current ? '$(location) Janela atual' : e.open ? '$(circle-filled) Aberta' : '$(circle-outline) Fechada — clique para abrir');
    if (e.key) md.appendMarkdown(`  \n$(keyboard) ${shortcutLabel(e.key)}`);
    if (!e.pinned) md.appendMarkdown('  \n$(pin) Não fixada — use a engrenagem para fixar');
    md.appendMarkdown(`\n\n\`${uriLabel(e.uri)}\``);
    s.tooltip = md;

    s.command = { command: 'windowDock.open', title: 'Abrir', arguments: [e.uri] };
    s.show();
    statusItems.push(s);
  });

  const plus = vscode.window.createStatusBarItem('windowDock.plus', vscode.StatusBarAlignment.Left, PRIORITY_BASE - view.length);
  plus.name = 'Window Dock: Gerenciar';
  plus.text = '$(gear)';
  plus.tooltip = 'Window Dock: janelas abertas — fixar, nome, ícone';
  plus.command = 'windowDock.manage';
  plus.show();
  statusItems.push(plus);
}

// ---------- navigation ----------

function resolveTarget(arg) {
  if (typeof arg === 'number') return buildView()[arg - 1]?.uri;
  const items = getItems();
  if (arg && typeof arg === 'object') arg = arg.uri || arg.name;
  if (typeof arg !== 'string') return undefined;
  const byName = items.find(it => it.name && it.name.toLowerCase() === arg.toLowerCase());
  return byName ? byName.uri : normUri(arg);
}

async function openTarget(arg) {
  const uri = arg === undefined ? undefined : resolveTarget(arg);
  if (!uri) return quickSwitch();
  if (uri === selfUri) return;
  // Opening a folder that is already open focuses its existing window.
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(uri), { forceNewWindow: true });
}

async function openSlot(n) {
  const uri = resolveTarget(n);
  if (!uri) {
    if (IS_MAC && EDITOR_GROUP_COMMANDS[n - 1]) return vscode.commands.executeCommand(EDITOR_GROUP_COMMANDS[n - 1]);
    const choice = await vscode.window.showInformationMessage(`Nenhuma janela no slot ${n}.`, 'Gerenciar dock');
    if (choice) manage();
    return;
  }
  return openTarget(uri);
}

async function quickSwitch() {
  const view = buildView().filter(e => !e.current);
  if (!view.length) {
    vscode.window.showInformationMessage('Nenhuma outra janela no dock.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    view.map(e => ({
      label: `${e.icon} ${e.name}`,
      description: [e.open ? 'aberta' : 'fechada', e.key ? shortcutLabel(e.key) : ''].filter(Boolean).join(' · '),
      detail: uriLabel(e.uri),
      uri: e.uri
    })),
    { placeHolder: 'Ir para janela…', matchOnDetail: true }
  );
  if (pick) openTarget(pick.uri);
}

// ---------- management ----------

function pickIcon(current) {
  return vscode.window.showInputBox({
    prompt: 'Ícone: cole um emoji (🦊) ou um codicon ($(rocket))',
    value: current || ''
  });
}

async function pinCurrent() {
  if (!selfUri) {
    vscode.window.showWarningMessage('Esta janela não tem pasta aberta — abra uma pasta para fixá-la no dock.');
    return;
  }
  return editWindow(selfUri, currentWindowName());
}

async function pinFolder() {
  const sel = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: true,
    canSelectMany: false,
    filters: { 'Workspace': ['code-workspace'] },
    openLabel: 'Fixar no dock'
  });
  if (!sel || !sel.length) return;
  const uri = normUri(sel[0].toString());
  const items = getItems();
  const existing = items.find(it => it.uri === uri);
  if (existing) existing.pinned = true;
  else items.push({ name: nameFromUri(uri), uri });
  await saveItems(items);
  return editWindow(uri, nameFromUri(uri));
}

async function editWindow(uri, defaultName) {
  for (;;) {
    const items = getItems();
    let index = items.findIndex(it => it.uri === uri);
    const it = index >= 0 ? items[index] : { uri, name: defaultName };
    const name = it.name || defaultName;
    const pinned = index >= 0 && isPinned(it);
    const open = readLive().has(uri);

    const actions = [
      { label: '$(arrow-left) Voltar para a lista', action: 'back' },
      pinned
        ? { label: '$(pinned) Desafixar', description: 'some do dock quando fechar', action: 'pin' }
        : { label: '$(pin) Fixar no dock', description: 'fica no dock mesmo fechada', action: 'pin' },
      { label: '$(edit) Renomear', description: name, action: 'rename' },
      { label: '$(symbol-color) Trocar ícone', description: it.icon || 'padrão', action: 'icon' }
    ];
    if (index >= 0) {
      actions.push(
        { label: '$(arrow-left) Mover para a esquerda', action: 'left' },
        { label: '$(arrow-right) Mover para a direita', action: 'right' }
      );
    }
    if (uri !== selfUri) {
      actions.push({ label: open ? '$(arrow-right) Ir para janela' : '$(folder-opened) Abrir janela', action: 'open' });
    }
    if (index >= 0) actions.push({ label: '$(trash) Esquecer nome e ícone', action: 'forget' });

    const pick = await vscode.window.showQuickPick(actions, { placeHolder: `${it.icon || ''} ${name}`.trim() });
    if (!pick) return false;
    if (pick.action === 'back') return true;
    if (pick.action === 'open') {
      openTarget(uri);
      return false;
    }

    if (index < 0) {
      items.push({ name: defaultName, uri, pinned: false });
      index = items.length - 1;
    }
    const target = items[index];

    switch (pick.action) {
      case 'pin':
        target.pinned = !pinned;
        break;
      case 'rename': {
        const next = await vscode.window.showInputBox({ prompt: 'Nome no dock', value: name });
        if (next === undefined) continue;
        target.name = next || defaultName;
        break;
      }
      case 'icon': {
        const icon = await pickIcon(target.icon);
        if (icon === undefined) continue;
        target.icon = icon;
        break;
      }
      case 'left':
      case 'right': {
        const to = pick.action === 'left' ? index - 1 : index + 1;
        if (to < 0 || to >= items.length) continue;
        [items[index], items[to]] = [items[to], items[index]];
        break;
      }
      case 'forget':
        items.splice(index, 1);
        break;
    }
    await saveItems(items);
  }
}

function windowPick(uri, name, it, defaultIcon, open, key) {
  const pinned = it && isPinned(it);
  return {
    label: `${(it && it.icon) || defaultIcon} ${(it && it.name) || name}`,
    description: [
      uri === selfUri ? 'esta janela' : '',
      pinned ? '$(pinned) fixada' : open ? 'não fixada' : '',
      key ? shortcutLabel(key) : ''
    ].filter(Boolean).join(' · '),
    detail: uriLabel(uri),
    action: 'edit',
    uri,
    name
  };
}

async function manage() {
  for (;;) {
    const items = getItems();
    const live = readLive();
    const defaultIcon = cfg().get('defaultIcon') || '$(window)';
    const byUri = new Map(items.map(it => [it.uri, it]));
    const slots = new Map(buildView().map(e => [e.uri, e.key]));
    const picks = [];

    const openUris = [...live.keys()].sort((a, b) => (a === selfUri ? -1 : b === selfUri ? 1 : 0));
    picks.push({ label: 'Abertas', kind: vscode.QuickPickItemKind.Separator });
    for (const uri of openUris) {
      picks.push(windowPick(uri, live.get(uri).name || nameFromUri(uri), byUri.get(uri), defaultIcon, true, slots.get(uri)));
    }

    const closedPinned = items.filter(it => isPinned(it) && !live.has(it.uri));
    if (closedPinned.length) {
      picks.push({ label: 'Fixadas fechadas', kind: vscode.QuickPickItemKind.Separator });
      for (const it of closedPinned) picks.push(windowPick(it.uri, nameFromUri(it.uri), it, defaultIcon, false, slots.get(it.uri)));
    }

    picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    picks.push({ label: '$(folder-opened) Fixar outra pasta/workspace…', action: 'pinFolder' });
    picks.push({ label: '$(eye) Mostrar/ocultar nomes', action: 'toggleNames' });
    picks.push({ label: '$(settings-gear) Configurações', action: 'settings' });

    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Escolha uma janela para fixar, renomear, trocar o ícone ou mover',
      matchOnDetail: true
    });
    if (!pick) return;
    switch (pick.action) {
      case 'edit':
        if (await editWindow(pick.uri, pick.name)) continue;
        return;
      case 'pinFolder': return pinFolder();
      case 'toggleNames': return cfg().update('showNames', !cfg().get('showNames'), vscode.ConfigurationTarget.Global);
      case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', 'windowDock');
    }
  }
}

// ---------- lifecycle ----------

function activate(context) {
  liveDir = path.join(context.globalStorageUri.fsPath, 'live');
  fs.mkdirSync(liveDir, { recursive: true });
  updateSelf();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('windowDock.open', openTarget);
  reg('windowDock.quickSwitch', quickSwitch);
  reg('windowDock.manage', manage);
  reg('windowDock.pinCurrent', pinCurrent);
  for (let n = 1; n <= 9; n++) reg(`windowDock.slot${n}`, () => openSlot(n));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('windowDock')) scheduleRender();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateSelf();
      scheduleRender();
    })
  );

  try {
    const watcher = fs.watch(liveDir, scheduleRender);
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // polling below still keeps things in sync
  }

  const hb = setInterval(heartbeat, HEARTBEAT_MS);
  const poll = setInterval(render, POLL_MS);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(hb);
      clearInterval(poll);
      clearTimeout(renderTimer);
      statusItems.forEach(s => s.dispose());
    }
  });

  render();
}

function deactivate() {
  removeSelf();
}

module.exports = { activate, deactivate };

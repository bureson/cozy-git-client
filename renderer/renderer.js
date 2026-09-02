const relTime = (iso) => {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
};

// Electron wraps handler rejections as "Error invoking remote method 'x': Error: <msg>"
const stripIpcPrefix = (message) =>
  (message || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();

const errorLine = (error) =>
  stripIpcPrefix(error.message).split('\n').filter(Boolean).pop() || 'git command failed';

const AUTHOR_COLORS = [
  '#45c7ae', '#8f86ff', '#e5b567', '#e0708a', '#6aa9ff',
  '#6ec98f', '#d183d1', '#6fcbdc', '#e88e6a', '#a3b0d8'
];

// assign colors in order of first appearance — distinct until the palette runs out,
// unlike hashing, which can collide even between two authors
const assignedColors = new Map();
const authorColor = (name) => {
  const key = name || '?';
  if (!assignedColors.has(key)) {
    assignedColors.set(key, AUTHOR_COLORS[assignedColors.size % AUTHOR_COLORS.length]);
  }
  return assignedColors.get(key);
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const splitPath = (filePath) => {
  const slash = filePath.lastIndexOf('/');
  return slash === -1
    ? { name: filePath, dir: '' }
    : { name: filePath.slice(slash + 1), dir: filePath.slice(0, slash) };
};

const renderSideSection = (sectionId, listId, items) => {
  document.getElementById(sectionId).hidden = items.length === 0;
  const list = document.getElementById(listId);
  list.replaceChildren();
  items.forEach((name) => {
    const row = el('div', 'branch-row muted');
    row.append(el('span', null, name));
    row.title = name;
    list.append(row);
  });
};

const deleteBranch = async (name, force) => {
  try {
    await window.aurora.deleteBranch(name, force);
    toast(`Deleted ${name} ✓`);
  } catch (error) {
    const message = stripIpcPrefix(error.message);
    if (!force && /not fully merged/i.test(message)) {
      errorDialog(`${name} isn’t fully merged`,
        `${message}\n\nForce-deleting loses its unmerged commits (recoverable only via the reflog).`,
        { label: 'Force delete', run: () => deleteBranch(name, true) });
    } else {
      errorDialog('Could not delete branch', message);
    }
  }
  await refresh();
};

// branches with path prefixes (feature/login, origin/feature/x) group into
// collapsible folders keyed by everything before the last slash
let collapsedFolders;
try { collapsedFolders = new Set(JSON.parse(localStorage.getItem('aurora-branch-folders') || '[]')); }
catch { collapsedFolders = new Set(); }
const saveCollapsedFolders = () => {
  try { localStorage.setItem('aurora-branch-folders', JSON.stringify([...collapsedFolders])); }
  catch { /* storage unavailable — collapse still works for this session */ }
};

const renderGroupedBranches = (list, names, buildRow, keyPrefix) => {
  const groups = new Map();
  names.forEach((name) => {
    const cut = name.lastIndexOf('/');
    const folder = cut === -1 ? '' : name.slice(0, cut);
    const leaf = cut === -1 ? name : name.slice(cut + 1);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push({ name, leaf });
  });
  [...groups.keys()].filter(Boolean).sort().forEach((folder) => {
    const key = `${keyPrefix}:${folder}`;
    const items = groups.get(folder);
    const row = el('div', 'branch-row folder clickable');
    row.append(el('span', 'collapse-chevron', '›'), el('span', 'branch-name', folder));
    row.title = `${items.length} branch${items.length === 1 ? '' : 'es'}`;
    const container = el('div', 'folder-items');
    items.forEach(({ name, leaf }) => container.append(buildRow(name, leaf)));
    const apply = () => {
      const isCollapsed = collapsedFolders.has(key);
      container.style.display = isCollapsed ? 'none' : '';
      row.classList.toggle('collapsed', isCollapsed);
    };
    apply();
    row.addEventListener('click', () => {
      if (!collapsedFolders.delete(key)) collapsedFolders.add(key);
      apply();
      saveCollapsedFolders();
    });
    list.append(row, container);
  });
  (groups.get('') || []).forEach(({ name, leaf }) => list.append(buildRow(name, leaf)));
};

const renderSidebar = ({ branch, remoteBranches = [], tags = [], stashes = [] }) => {
  const list = document.getElementById('branch-list');
  list.replaceChildren();
  const buildLocalRow = (name, leaf) => {
    const row = el('div', name === branch.current ? 'branch-row current' : 'branch-row clickable');
    row.append(el('span', 'branch-name', leaf));
    if (name === branch.current) {
      row.append(el('span', 'spacer'), el('span', 'head-dot'));
    } else {
      row.title = `Switch to ${name}`;
      row.append(el('span', 'spacer'));
      const del = el('button', 'row-btn drop');
      del.title = 'Delete this branch';
      del.innerHTML = '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        errorDialog(`Delete branch ${name}?`,
          'Only the branch pointer is removed — commits reachable from other branches stay untouched.',
          { label: 'Delete branch', run: () => deleteBranch(name, false) });
      });
      row.append(del);
      row.addEventListener('click', () => remoteAct(`Checkout ${name}`, () => window.aurora.checkout(name)));
    }
    return row;
  };
  renderGroupedBranches(list, branch.all, buildLocalRow, 'local');
  renderRemoteBranches(remoteBranches, branch.current);
  renderTags(tags);
  renderStashes(stashes);
};

const renderTags = (tags) => {
  document.getElementById('tag-section').hidden = tags.length === 0;
  const list = document.getElementById('tag-list');
  list.replaceChildren();
  tags.forEach((name) => {
    const row = el('div', 'branch-row muted stash-row');
    row.title = name;
    const pushBtn = el('button', 'stash-btn');
    pushBtn.title = `Push ${name} to origin`;
    pushBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    pushBtn.addEventListener('click', () =>
      remoteAct(`Push tag ${name}`, () => window.aurora.pushTag(name), pushBtn));
    const delBtn = el('button', 'stash-btn drop');
    delBtn.title = 'Delete this tag';
    delBtn.innerHTML = DROP_ICON;
    delBtn.addEventListener('click', () => {
      errorDialog(`Delete tag ${name}?`,
        'This removes the local tag. If it was already pushed, the tag on origin stays until removed there.',
        { label: 'Delete tag', run: () => remoteAct(`Delete tag ${name}`, () => window.aurora.deleteTag(name)) });
    });
    row.append(el('span', 'stash-msg', name), pushBtn, delBtn);
    list.append(row);
  });
};

const renderRemoteBranches = (remoteBranches, currentBranch) => {
  document.getElementById('remote-section').hidden = remoteBranches.length === 0;
  const list = document.getElementById('remote-list');
  list.replaceChildren();
  const buildRemoteRow = (name, leaf) => {
    const localName = name.replace(/^[^/]+\//, '');
    const isCurrent = localName === currentBranch;
    const row = el('div', isCurrent ? 'branch-row muted' : 'branch-row muted clickable');
    row.append(el('span', 'branch-name', leaf));
    row.title = isCurrent ? name : `Checkout ${localName}`;
    if (!isCurrent) {
      row.addEventListener('click', () => remoteAct(`Checkout ${localName}`, () => window.aurora.checkout(localName)));
    }
    return row;
  };
  renderGroupedBranches(list, remoteBranches, buildRemoteRow, 'remote');
};

const POP_ICON = '<svg viewBox="0 0 24 24"><path d="M12 16V5"/><path d="M8 9l4-4 4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
const DROP_ICON = '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

const stashButtons = (index, message) => {
  const popBtn = el('button', 'stash-btn');
  popBtn.title = 'Restore these changes (pop)';
  popBtn.innerHTML = POP_ICON;
  popBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    remoteAct('Stash pop', () => window.aurora.stashPop(index), popBtn);
  });
  const dropBtn = el('button', 'stash-btn drop');
  dropBtn.title = 'Delete this stash';
  dropBtn.innerHTML = DROP_ICON;
  dropBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    errorDialog('Drop this stash?', `“${message}” will be deleted for good — its changes can’t be restored afterwards.`,
      { label: 'Drop stash', run: () => remoteAct('Stash drop', () => window.aurora.stashDrop(index)) });
  });
  return [popBtn, dropBtn];
};

// Stash and working-file diffs take over the center pane (the commit graph
// hides while one is open). What's on display is tracked so refresh can keep
// the content live or close the view when its subject goes away.
let centerDiff = null;

// the row whose diff fills the center pane carries .open in the changes lists
const markViewedRow = () => {
  document.querySelectorAll('.file-row.open').forEach((row) => row.classList.remove('open'));
  if (centerDiff?.kind !== 'file') return;
  const container = document.getElementById(centerDiff.staged ? 'staged-list' : 'unstaged-list');
  container.querySelectorAll('.file-row').forEach((row) => {
    if (row.dataset.path === centerDiff.path) row.classList.add('open');
  });
};

const closeDiffView = () => {
  centerDiff = null;
  document.getElementById('diff-view').hidden = true;
  document.getElementById('commit-list').hidden = false;
  markViewedRow();
};

const showDiffView = (title, chipText, chipClass, diffText) => {
  document.getElementById('diff-view-title').textContent = title;
  const chip = document.getElementById('diff-view-chip');
  chip.textContent = chipText;
  chip.className = chipClass;
  document.getElementById('diff-view-body').replaceChildren(renderDiff(diffText || '(nothing to show)'));
  document.getElementById('diff-view').hidden = false;
  document.getElementById('commit-list').hidden = true;
};

const openStashView = async (index, message) => {
  if (centerDiff?.kind === 'stash' && centerDiff.index === index) {
    closeDiffView();
    return;
  }
  try {
    const diff = await window.aurora.stashDiff(index);
    centerDiff = { kind: 'stash', index, message };
    showDiffView(message, 'stash', 'chip amber', diff);
    markViewedRow();
  } catch (error) {
    toast(errorLine(error), true);
  }
};

const openFileView = async (path, staged, untracked) => {
  if (centerDiff?.kind === 'file' && centerDiff.path === path && centerDiff.staged === staged) {
    closeDiffView();
    return;
  }
  try {
    const diff = await window.aurora.workingDiff(path, staged, untracked);
    centerDiff = { kind: 'file', path, staged, untracked };
    showDiffView(path, staged ? 'staged' : 'unstaged', staged ? 'chip' : 'chip violet', diff);
    markViewedRow();
  } catch (error) {
    toast(errorLine(error), true);
  }
};

// A viewed working diff follows the repo: refresh its content, or close the
// view once the file has left its list (staged away, discarded, committed)
const syncFileView = (unstaged, staged) => {
  if (centerDiff?.kind !== 'file') return;
  const entry = (centerDiff.staged ? staged : unstaged).find((file) => file.path === centerDiff.path);
  if (!entry) {
    closeDiffView();
    return;
  }
  centerDiff.untracked = entry.code === 'U';
  const viewed = centerDiff;
  window.aurora.workingDiff(viewed.path, viewed.staged, viewed.untracked)
    .then((diff) => {
      if (centerDiff !== viewed) return;
      document.getElementById('diff-view-body').replaceChildren(renderDiff(diff || '(nothing to show)'));
    })
    .catch(() => {});
};

const wireDiffView = () => {
  document.getElementById('diff-view-back').addEventListener('click', closeDiffView);
  // registered before wireErrorModal's Esc handler, so a visible modal wins
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || centerDiff === null) return;
    if (!document.getElementById('error-modal').hidden) return;
    closeDiffView();
  });
};

const renderStashes = (stashes) => {
  document.getElementById('stash-section').hidden = stashes.length === 0;
  const list = document.getElementById('stash-list');
  list.replaceChildren();
  stashes.forEach((stash, index) => {
    const row = el('div', 'branch-row muted stash-row');
    row.title = `${stash.message} — click to view the diff`;
    row.append(el('span', 'stash-msg', stash.message), ...stashButtons(index, stash.message));
    row.addEventListener('click', () => openStashView(index, stash.message));
    list.append(row);
  });
};

const refChips = (refs) => refs
  .split(',')
  .map((ref) => ref.replace('HEAD ->', '').trim())
  .filter((ref) => ref && ref !== 'HEAD')
  .map((ref) => el('span', ref.startsWith('origin/') ? 'chip ghost' : 'chip', ref));

// shared changed-span of two line bodies (common prefix/suffix trimmed off)
const changedRange = (a, b) => {
  const max = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < max && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  if (pre + suf >= Math.max(a.length, b.length)) return null;
  return { pre, suf };
};

// ---- tiny per-line syntax tokenizer for diff code lines. Comments read dim,
// strings/keywords/numbers each get their own color. Lines tokenize one at a
// time with a small carried state (open block comment / template literal),
// reset at every hunk — a hunk can start mid-construct, and guessing wrong
// would mis-paint the whole rest of the file.

const JS_KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends '
  + 'finally for from function if import in instanceof let new of return static super switch this throw try typeof '
  + 'var void while with yield async await').split(' '));
const TS_KEYWORDS = new Set([...JS_KEYWORDS,
  'interface', 'type', 'enum', 'implements', 'declare', 'readonly', 'namespace',
  'abstract', 'public', 'private', 'protected', 'keyof', 'satisfies', 'as', 'is', 'override']);
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const NO_WORDS = new Set();

// css: no // line comments — they'd eat the tail of url(https://…)
const DIFF_LANGS = {
  js: { keywords: JS_KEYWORDS, literals: JS_LITERALS, lineComment: true, backtick: true },
  ts: { keywords: TS_KEYWORDS, literals: JS_LITERALS, lineComment: true, backtick: true },
  json: { keywords: NO_WORDS, literals: JS_LITERALS, lineComment: true, backtick: false },
  css: { keywords: NO_WORDS, literals: NO_WORDS, lineComment: false, backtick: false }
};

const diffLang = (filePath) => {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return DIFF_LANGS.js;
  if (['ts', 'tsx'].includes(ext)) return DIFF_LANGS.ts;
  if (ext === 'json') return DIFF_LANGS.json;
  if (['css', 'scss', 'less'].includes(ext)) return DIFF_LANGS.css;
  return null;
};

// token classes: c comment, s string, k keyword, l literal, n number, f call
const tokenizeLine = (text, lang, state) => {
  const tokens = [];
  const push = (cls, str) => { if (str) tokens.push({ cls, text: str }); };
  let i = 0;
  if (state.comment) {
    const end = text.indexOf('*/');
    if (end === -1) { push('c', text); return tokens; }
    push('c', text.slice(0, end + 2));
    i = end + 2;
    state.comment = false;
  } else if (state.template) {
    let j = 0;
    while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) { push('s', text); return tokens; }
    push('s', text.slice(0, j + 1));
    i = j + 1;
    state.template = false;
  }
  while (i < text.length) {
    const ch = text[i];
    if (lang.lineComment && ch === '/' && text[i + 1] === '/') { push('c', text.slice(i)); break; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) { push('c', text.slice(i)); state.comment = true; break; }
      push('c', text.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === '`' && lang.backtick)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) { // unterminated: only templates legally span lines
        push('s', text.slice(i));
        if (ch === '`') state.template = true;
        break;
      }
      push('s', text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/\d/.test(ch)) {
      const num = /^(0[xXbBoO][\da-fA-F]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)n?/.exec(text.slice(i))[0];
      push('n', num);
      i += num.length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (word) {
      const cls = lang.keywords.has(word[0]) ? 'k'
        : lang.literals.has(word[0]) ? 'l'
        : /^\s*\(/.test(text.slice(i + word[0].length)) ? 'f' : null;
      push(cls, word[0]);
      i += word[0].length;
      continue;
    }
    // plain run: batch everything up to the next char that could start a token
    let j = i + 1;
    while (j < text.length && !/[\w$'"`/]/.test(text[j])) j += 1;
    push(null, text.slice(i, j));
    i = j;
  }
  return tokens;
};

// lay tokens into the row, wrapping the changed-range slice in the .em span
const appendTokens = (node, tokens, range, bodyLength) => {
  const piece = (cls, str) => cls ? el('span', `tok-${cls}`, str) : document.createTextNode(str);
  if (!range) {
    tokens.forEach(({ cls, text }) => node.append(piece(cls, text)));
    return;
  }
  const from = range.pre;
  const to = bodyLength - range.suf;
  let pos = 0;
  let em = null; // open .em wrapper — tokens inside the range share one
  tokens.forEach(({ cls, text }) => {
    const start = pos;
    pos += text.length;
    [[start, Math.min(pos, from), false],
      [Math.max(start, from), Math.min(pos, to), true],
      [Math.max(start, to), pos, false]].forEach(([a, b, inEm]) => {
      if (b <= a) return;
      const part = piece(cls, text.slice(a - start, b - start));
      if (!inEm) {
        node.append(part);
        em = null;
        return;
      }
      if (!em) {
        em = el('span', 'em');
        node.append(em);
      }
      em.append(part);
    });
  });
};

const renderDiff = (diffText) => {
  const block = el('div', 'diff-block mono');
  const lines = diffText.replace(/\n$/, '').split('\n');
  const kinds = lines.map((line) => {
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|\\)/.test(line)) return 'meta';
    if (line.startsWith('@@')) return 'hunk';
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return '';
  });
  // pair each run of removed lines with the added run right after it
  const ranges = new Array(lines.length).fill(null);
  for (let i = 0; i < lines.length; i += 1) {
    if (kinds[i] !== 'del') continue;
    const delStart = i;
    while (kinds[i] === 'del') i += 1;
    const addStart = i;
    while (kinds[i] === 'add') i += 1;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let p = 0; p < pairs; p += 1) {
      const range = changedRange(lines[delStart + p].slice(1), lines[addStart + p].slice(1));
      ranges[delStart + p] = range;
      ranges[addStart + p] = range;
    }
    i -= 1;
  }
  // multi-file patches (stashes) get a header bar per file so the boundaries
  // read at a glance; single-file diffs already have their path elsewhere
  const isFileStart = (line) => line.startsWith('diff --git ');
  const multiFile = lines.filter(isFileStart).length > 1;
  // each file gets its own section so its sticky header bar is pushed away by
  // the next file's bar instead of lingering over it
  let target = block;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  // syntax highlighting keys off the file's extension; del lines tokenize with
  // the old side's carried state, add lines with the new side's
  let lang = null;
  let oldState = {};
  let newState = {};
  lines.forEach((line, index) => {
    if (isFileStart(line)) {
      lang = diffLang(line.slice(line.indexOf(' b/') + 3));
      inHunk = false;
    }
    if (multiFile && isFileStart(line)) {
      const head = el('div', 'diff-file-head');
      head.append(el('span', 'diff-file-path', line.slice(line.indexOf(' b/') + 3)));
      const intro = lines.slice(index + 1, index + 4).join('\n');
      if (/^new file mode/m.test(intro)) head.append(el('span', 'diff-file-badge add', 'new'));
      else if (/^deleted file mode/m.test(intro)) head.append(el('span', 'diff-file-badge del', 'deleted'));
      target = el('div', 'diff-file');
      target.append(head); // the bar replaces the raw `diff --git` line
      block.append(target);
      return;
    }
    const kind = kinds[index];
    if (kind === 'hunk') {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/.exec(line);
      if (header) {
        oldNo = Number(header[1]);
        newNo = Number(header[2]);
        inHunk = true;
        oldState = {};
        newState = {};
      }
    }
    const node = el('div', `diff-line${kind ? ` ${kind}` : ''}`);
    // old/new line-number gutter; blank for meta/hunk rows and outside hunks
    let lnOld = '';
    let lnNew = '';
    if (inHunk && kind === 'add') lnNew = String(newNo++);
    else if (inHunk && kind === 'del') lnOld = String(oldNo++);
    else if (inHunk && kind === '') {
      lnOld = String(oldNo++);
      lnNew = String(newNo++);
    }
    node.append(el('span', 'ln', lnOld), el('span', 'ln', lnNew));
    const range = ranges[index];
    if (lang && inHunk && (kind === '' || kind === 'add' || kind === 'del')) {
      const body = line.slice(1);
      const tokens = tokenizeLine(body, lang, kind === 'del' ? oldState : newState);
      if (kind === '') oldState = { ...newState }; // context advances both sides
      node.classList.add('hl');
      node.append(el('span', 'marker', line[0] || ' '));
      appendTokens(node, tokens, range, body.length);
    } else if (!range) {
      node.append(line || ' ');
    } else {
      const body = line.slice(1);
      node.append(
        line[0] + body.slice(0, range.pre),
        el('span', 'em', body.slice(range.pre, body.length - range.suf)),
        body.slice(body.length - range.suf)
      );
    }
    target.append(node);
  });
  return block;
};

const renderCommitDetail = async (hash) => {
  const detail = el('div', 'commit-detail');
  const { author, email, date, body, files } = await window.aurora.commitDetail(hash);
  detail.append(el('div', 'detail-msg', body));
  const byline = el('div', 'detail-byline');
  byline.append(
    el('span', 'detail-author', author),
    el('span', 'detail-email', `<${email}>`),
    el('span', 'detail-date', new Date(date).toLocaleString())
  );
  detail.append(byline);
  const fileList = el('div', 'detail-files');
  files.forEach((file) => {
    const row = el('div', 'detail-file');
    row.append(el('span', 'detail-path mono', file.path), el('span', 'spacer'));
    if (file.added === '-') {
      row.append(el('span', 'stat mono', 'binary'));
      fileList.append(row);
      return;
    }
    row.append(
      el('span', 'stat add mono', `+${file.added}`),
      el('span', 'stat del mono', `−${file.removed}`),
      el('span', 'chevron', '›')
    );
    row.classList.add('diffable');
    row.title = 'Click to view diff';
    row.addEventListener('click', async () => {
      const openDiff = row.nextElementSibling;
      if (openDiff && openDiff.classList.contains('diff-block')) {
        openDiff.remove();
        row.classList.remove('open');
        return;
      }
      row.after(renderDiff(await window.aurora.fileDiff(hash, file.path)));
      row.classList.add('open');
    });
    fileList.append(row);
  });
  detail.append(fileList);
  // tags point at a specific commit — offer tagging right here, not just HEAD
  const actions = el('div', 'detail-actions');
  const tagBtn = el('button', 'tool-btn', 'Tag this commit…');
  const tagInput = el('input', 'detail-tag-input mono');
  tagInput.placeholder = `tag name for ${hash.slice(0, 7)}, Enter to create`;
  tagInput.spellcheck = false;
  tagInput.hidden = true;
  tagBtn.addEventListener('click', () => {
    tagInput.hidden = !tagInput.hidden;
    if (!tagInput.hidden) tagInput.focus();
  });
  tagInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') tagInput.hidden = true;
    if (event.key !== 'Enter' || !tagInput.value.trim()) return;
    const name = tagInput.value.trim();
    tagInput.value = '';
    remoteAct(`Tag ${name}`, () => window.aurora.createTag(name, hash));
  });
  tagInput.addEventListener('click', (event) => event.stopPropagation());
  actions.append(tagBtn, tagInput);
  detail.append(actions);
  return detail;
};

// ---- commit graph: lane layout over the DAG, drawn as one SVG that tracks
// the real row positions (so open detail panels never desync the lines) ----

const GRAPH_COLORS = ['#45c7ae', '#8f86ff', '#6aa9ff', '#e0708a', '#6ec98f', '#d183d1', '#e88e6a', '#a3b0d8'];
const GRAPH_X0 = 26;
const GRAPH_SPACING = 22;

// classic gitk-style walk: each lane carries the parent hash it expects next
const layoutGraph = (commits) => {
  const laneOf = new Map();
  const colorOf = new Map();
  const edges = []; // {from: child hash, to: parent hash, lane: travel lane, color}
  const lanes = []; // {expecting, fromHash, color} | null
  let colorCount = 0;
  const newColor = () => GRAPH_COLORS[colorCount++ % GRAPH_COLORS.length];
  const freeLane = () => {
    const idx = lanes.findIndex((rec) => !rec);
    return idx === -1 ? lanes.length : idx;
  };
  commits.forEach((commit) => {
    const hits = [];
    lanes.forEach((rec, i) => { if (rec && rec.expecting === commit.hash) hits.push(i); });
    let lane, color;
    if (hits.length > 0) {
      lane = hits[0];
      color = lanes[lane].color;
      hits.forEach((i) => edges.push({ from: lanes[i].fromHash, to: commit.hash, lane: i, color: lanes[i].color }));
      hits.slice(1).forEach((i) => { lanes[i] = null; });
    } else {
      lane = freeLane();
      color = newColor();
    }
    laneOf.set(commit.hash, lane);
    colorOf.set(commit.hash, color);
    const [first, ...rest] = commit.parents || [];
    lanes[lane] = first ? { expecting: first, fromHash: commit.hash, color } : null;
    rest.forEach((parent) => {
      const existing = lanes.findIndex((rec) => rec && rec.expecting === parent);
      if (existing !== -1) {
        edges.push({ from: commit.hash, to: parent, lane: existing, color: lanes[existing].color });
        return;
      }
      const idx = freeLane();
      lanes[idx] = { expecting: parent, fromHash: commit.hash, color: newColor() };
    });
  });
  const maxLane = Math.max(0, ...laneOf.values(), ...edges.map((edge) => edge.lane));
  return { laneOf, colorOf, edges, maxLane };
};

let graphState = null;

const drawGraph = () => {
  const svg = document.getElementById('graph-svg');
  if (!graphState) { svg.replaceChildren(); return; }
  const { layout, recolor, offHead, headHash } = graphState;
  const rowsWrap = document.getElementById('commit-rows');
  const X = (lane) => GRAPH_X0 + lane * GRAPH_SPACING;
  const Y = (rowEl) => rowEl.offsetTop + rowEl.offsetHeight / 2;
  const els = new Map();
  let ghostEl = null;
  const stashEls = [];
  rowsWrap.querySelectorAll('.commit-row').forEach((rowEl) => {
    if (rowEl.dataset.hash) els.set(rowEl.dataset.hash, rowEl);
    else if (rowEl.dataset.kind === 'wip') ghostEl = rowEl;
    else if (rowEl.dataset.kind === 'stash') stashEls.push(rowEl);
  });
  const parts = [];
  layout.edges.forEach(({ from, to, lane, color }) => {
    const elC = els.get(from);
    const elP = els.get(to);
    if (!elC || !elP) return; // parent beyond the log window
    const xC = X(layout.laneOf.get(from));
    const xV = X(lane);
    const xP = X(layout.laneOf.get(to));
    const yC = Y(elC);
    const yP = Y(elP);
    const seg = Math.min(18, Math.max(8, (yP - yC) / 2 - 2));
    let d = `M ${xC} ${yC}`;
    let y = yC;
    if (xV !== xC) {
      y = Math.min(yC + seg * 2, yP);
      d += ` C ${xC} ${yC + seg * 1.6}, ${xV} ${yC + seg * 0.4}, ${xV} ${y}`;
    }
    if (xP === xV) {
      d += ` L ${xV} ${yP}`;
    } else {
      d += ` L ${xV} ${yP - seg * 2} C ${xV} ${yP - seg * 0.4}, ${xP} ${yP - seg * 1.6}, ${xP} ${yP}`;
    }
    const offDash = offHead.has(from) ? ' stroke-dasharray="3 4" opacity="0.8"' : '';
    parts.push(`<path d="${d}" stroke="${recolor(color)}" stroke-width="2" fill="none"${offDash}/>`);
  });
  const headEl = els.get(headHash);
  const headLaneX = headEl ? X(layout.laneOf.get(headHash)) : X(0);
  if (ghostEl) {
    const y = Y(ghostEl);
    if (headEl) {
      parts.push(`<path d="M ${headLaneX} ${y + 8} L ${headLaneX} ${Y(headEl) - 8}" stroke="#45c7ae" stroke-width="2" fill="none" stroke-dasharray="3 4" opacity="0.75"/>`);
    }
    parts.push(`<circle cx="${headLaneX}" cy="${y}" r="5" fill="#171b28" stroke="#45c7ae" stroke-width="2" stroke-dasharray="2.5 2.5"/>`);
  }
  stashEls.forEach((rowEl) => {
    parts.push(`<circle cx="${headLaneX}" cy="${Y(rowEl)}" r="5" fill="#171b28" stroke="#e5b567" stroke-width="2" stroke-dasharray="2.5 2.5"/>`);
  });
  els.forEach((rowEl, hash) => {
    const x = X(layout.laneOf.get(hash));
    const y = Y(rowEl);
    const color = recolor(layout.colorOf.get(hash));
    const isHead = hash === headHash;
    const dash = offHead.has(hash) ? ' stroke-dasharray="2.5 2.5"' : '';
    parts.push(`<circle cx="${x}" cy="${y}" r="5" fill="${isHead ? color : '#171b28'}" stroke="${color}" stroke-width="2"${dash}/>`);
  });
  svg.setAttribute('width', graphState.width);
  svg.setAttribute('height', Math.max(rowsWrap.offsetHeight, 1));
  svg.innerHTML = parts.join('');
};

// the WIP ghost row previews the summary being typed in the commit box, so the
// upcoming commit reads like a real one before it exists
let wipChangedCount = 0;
const wipText = () => {
  const summary = document.getElementById('commit-summary').value.trim();
  const files = `${wipChangedCount} file${wipChangedCount === 1 ? '' : 's'} changed`;
  return summary ? `${summary} — ${files}` : `${files} — not committed yet`;
};

// "all": every branch interleaved; "current": only HEAD's history plus incoming
let viewMode = 'all';
try { if (localStorage.getItem('aurora-view-mode') === 'current') viewMode = 'current'; }
catch { /* storage unavailable */ }
let lastCommitArgs = null;

const renderCommits = (log, incomingHashes, stashes, changedCount) => {
  lastCommitArgs = [log, incomingHashes, stashes, changedCount];
  const list = document.getElementById('commit-rows');
  list.replaceChildren();

  const isHeadRef = (refs) => (refs || '').split(',')
    .some((ref) => ref.trim() === 'HEAD' || ref.trim().startsWith('HEAD ->'));
  const headHash = (log.find((commit) => isHeadRef(commit.refs)) || {}).hash || null;
  // reachability from HEAD drives both the "current" filter and dashed rendering —
  // a linear DAG can stack unmerged tips on HEAD's own lane, where solid reads as "mine"
  const byHash = new Map(log.map((commit) => [commit.hash, commit]));
  const reachable = new Set();
  if (headHash) {
    const stack = [headHash];
    while (stack.length > 0) {
      const hash = stack.pop();
      if (reachable.has(hash)) continue;
      reachable.add(hash);
      const commit = byHash.get(hash);
      if (commit) stack.push(...commit.parents);
    }
  }
  const incomingSet = new Set(incomingHashes);
  const shown = viewMode === 'current' && headHash
    ? log.filter((commit) => reachable.has(commit.hash) || incomingSet.has(commit.hash))
    : log;

  const layout = layoutGraph(shown);
  // the mockup keeps HEAD's branch teal — swap the palette so it always is
  const headColor = headHash ? layout.colorOf.get(headHash) : GRAPH_COLORS[0];
  const recolor = (color) => color === headColor ? GRAPH_COLORS[0]
    : color === GRAPH_COLORS[0] ? headColor : color;
  const width = GRAPH_X0 * 2 + layout.maxLane * GRAPH_SPACING;
  list.style.setProperty('--graph-w', `${width}px`);
  graphState = {
    layout, recolor, headHash, width,
    incomingSet,
    offHead: new Set(headHash ? shown.filter((commit) => !reachable.has(commit.hash)).map((commit) => commit.hash) : [])
  };

  // stashes float on top of the graph, disconnected from the timeline
  stashes.forEach((stash, index) => {
    const row = el('div', 'commit-row stash-commit');
    row.dataset.kind = 'stash';
    row.title = 'Click to view the diff';
    const main = el('div', 'commit-main');
    main.append(el('span', 'commit-msg', stash.message), el('span', 'chip amber', 'stash'));
    row.append(
      main,
      ...stashButtons(index, stash.message),
      el('span', 'commit-date', stash.date ? relTime(stash.date) : ''),
      el('span', 'commit-hash mono', `#${index}`)
    );
    row.addEventListener('click', () => openStashView(index, stash.message));
    list.append(row);
  });

  if (changedCount > 0) {
    // ghost commit: what the next commit would be, sitting above HEAD
    const row = el('div', 'commit-row ghost');
    row.dataset.kind = 'wip';
    const main = el('div', 'commit-main');
    wipChangedCount = changedCount;
    const msg = el('span', 'ghost-msg', wipText());
    msg.id = 'wip-msg';
    main.append(msg, el('span', 'chip blue', 'WIP'));
    row.append(
      main,
      el('span', 'commit-date', 'now'),
      el('span', 'commit-hash mono', '')
    );
    list.append(row);
  }

  shown.forEach((commit) => {
    const isIncoming = graphState.incomingSet.has(commit.hash);
    const row = el('div', isIncoming ? 'commit-row incoming' : 'commit-row');
    row.dataset.hash = commit.hash;
    const main = el('div', 'commit-main');
    main.append(el('span', 'commit-msg', commit.message));
    const pipeline = pipelineBySha[commit.hash];
    if (pipeline) {
      const dot = el('span', `ci-dot ${pipeline.status}`);
      let ci = dot;
      let title = `Pipeline ${pipeline.status}${pipeline.ref ? ` on ${pipeline.ref}` : ''}`;
      if (pipeline.progress) {
        const { done, total, job, stage } = pipeline.progress;
        ci = el('span', 'ci-chip');
        ci.append(dot, el('span', '', job ? `${job} · ${done}/${total}` : `${done}/${total} jobs`));
        title += ` — ${stage ? `${stage}: ` : ''}${job || 'between jobs'}, ${done} of ${total} jobs done`;
      }
      ci.title = `${title} — click to open in GitLab`;
      ci.addEventListener('click', (event) => {
        event.stopPropagation();
        if (pipeline.webUrl) window.aurora.openExternal(pipeline.webUrl);
      });
      main.append(ci);
    }
    const chips = [];
    if (isIncoming) chips.push(el('span', 'chip violet', '↓ incoming'));
    if (commit.refs) chips.push(...refChips(commit.refs));
    if (chips.length > 0) {
      // chips live in a capped group so a many-ref commit can't starve the
      // message of space; hover reveals whatever got truncated
      const refs = el('span', 'commit-refs');
      refs.title = chips.map((chip) => chip.textContent).join(', ');
      refs.append(...chips);
      main.append(refs);
    }
    // lanes speak branch, avatars speak author — color plus initials ("Ondrej
    // Bures" → OB) so same-first-letter authors still read apart at a glance
    const color = authorColor(commit.author_name);
    const initials = (commit.author_name || '?').split(/\s+/).filter(Boolean)
      .map((word) => word[0]).slice(0, 2).join('').toUpperCase() || '?';
    const avatar = el('div', initials.length > 1 ? 'avatar two' : 'avatar', initials);
    avatar.title = commit.author_name || 'unknown';
    avatar.style.color = color;
    avatar.style.background = `${color}22`;
    row.append(
      main,
      avatar,
      el('span', 'commit-author', commit.author_name || 'unknown'),
      el('span', 'commit-date', relTime(commit.date)),
      el('span', 'commit-hash mono', commit.hash.slice(0, 7))
    );
    const revealTagInput = (detail) => {
      const input = detail.querySelector('.detail-tag-input');
      if (input) {
        input.hidden = false;
        input.focus();
      }
    };
    const toggleDetail = async (focusTag) => {
      const open = list.querySelector('.commit-detail');
      // null === null: without the open check, the LAST row (null nextSibling)
      // would always look "already open" and never expand
      const wasThisOne = open !== null && row.nextElementSibling === open;
      if (wasThisOne) {
        if (focusTag) {
          revealTagInput(open);
          return;
        }
        open.remove();
        row.classList.remove('open');
        return;
      }
      if (open) open.remove();
      list.querySelectorAll('.commit-row.open').forEach((r) => r.classList.remove('open'));
      row.classList.add('open');
      let detail;
      try {
        detail = await renderCommitDetail(commit.hash);
      } catch (error) {
        detail = el('div', 'commit-detail');
        detail.append(el('div', 'empty', `Failed to load commit: ${error.message}`));
      }
      row.after(detail);
      if (focusTag) revealTagInput(detail);
      detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    row.addEventListener('click', () => toggleDetail(false));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showCtxMenu(event.clientX, event.clientY, [
        { label: 'Tag this commit…', hint: commit.hash.slice(0, 7), run: () => toggleDetail(true) },
        { label: 'Copy hash', run: () => navigator.clipboard.writeText(commit.hash).catch(() => {}) }
      ]);
    });
    list.append(row);
  });

  drawGraph();
};

const showError = (message) => {
  const box = document.getElementById('commit-error');
  box.textContent = message;
  box.style.display = message ? 'block' : 'none';
};

// Wraps a git action: run it, surface any error, then re-render from fresh state
const act = async (action) => {
  showError('');
  try {
    await action();
  } catch (error) {
    showError(errorLine(error));
  }
  await refresh();
};

// git status letter -> badge styling and a human label for the tooltip
const FILE_KINDS = {
  A: { kind: 'add', label: 'New file' },
  U: { kind: 'add', label: 'Untracked file' },
  M: { kind: 'mod', label: 'Modified' },
  T: { kind: 'mod', label: 'Type changed' },
  D: { kind: 'del', label: 'Deleted' },
  R: { kind: 'ren', label: 'Renamed' },
  C: { kind: 'ren', label: 'Copied' },
};
const fileKind = (code) => FILE_KINDS[code] || { kind: '', label: 'Changed' };

const renderFileList = (containerId, labelId, label, fileList, staged) => {
  document.getElementById(labelId).textContent = `${label} · ${fileList.length}`;
  const container = document.getElementById(containerId);
  container.replaceChildren();
  if (fileList.length === 0) {
    container.append(el('div', 'empty', staged ? 'Nothing staged yet' : 'No unstaged changes'));
    return;
  }
  const allBtn = el('button', 'all-btn', staged ? 'unstage all' : 'stage all');
  allBtn.addEventListener('click', () => {
    const paths = fileList.map((file) => file.path);
    act(() => staged ? window.aurora.unstage(paths) : window.aurora.stage(paths));
  });
  document.getElementById(labelId).parentElement.append(allBtn);
  fileList.forEach((file) => {
    const { kind, label: kindLabel } = fileKind(file.code);
    const row = el('div', `file-row${staged ? ' staged' : ''}${kind ? ` ${kind}` : ''}`);
    row.dataset.path = file.path;
    row.title = `${kindLabel} · click to view the diff`;
    const { name, dir } = splitPath(file.path);
    const meta = el('div', 'file-meta');
    meta.append(el('span', 'file-name', name));
    if (dir) meta.append(el('span', 'file-dir', dir));
    const actBtn = el('button', 'file-act');
    actBtn.title = staged ? 'Unstage this file' : 'Stage this file';
    actBtn.innerHTML = staged
      ? '<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>'
      : '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    actBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      act(() => staged ? window.aurora.unstage([file.path]) : window.aurora.stage([file.path]));
    });
    const badge = el('span', `badge${kind ? ` ${kind}` : ''}`, file.code);
    badge.title = kindLabel;
    row.append(badge, meta);
    if (!staged) {
      const untracked = file.code === 'U';
      const discardBtn = el('button', 'file-act discard');
      discardBtn.title = untracked ? 'Delete this untracked file' : 'Discard changes';
      discardBtn.innerHTML = untracked
        ? '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13h10l1-13"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 10h11a5 5 0 0 1 0 10h-6"/><path d="M8 6l-4 4 4 4"/></svg>';
      discardBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        errorDialog(untracked ? `Delete ${file.path}?` : `Discard changes to ${file.path}?`,
          untracked
            ? 'The file is untracked — deleting it removes it from disk and it cannot be restored.'
            : 'The file reverts to its staged (or last committed) version. Unstaged edits are lost for good.',
          { label: untracked ? 'Delete file' : 'Discard', run: () => act(() => window.aurora.discard(file.path, untracked)) });
      });
      row.append(discardBtn);
    }
    row.append(actBtn);
    row.addEventListener('click', () => openFileView(file.path, staged, file.code === 'U'));
    container.append(row);
  });
};

let stagedCount = 0;

const updateCommitButton = () => {
  const summary = document.getElementById('commit-summary').value.trim();
  const button = document.getElementById('commit-button');
  button.disabled = !summary || stagedCount === 0;
  button.title = stagedCount === 0 ? 'Stage some changes first'
    : !summary ? 'Write a summary first' : '';
};

let lastSnapshot = '';

// GitLab pipeline statuses by commit sha — best-effort: empty when the repo has
// no GitLab account/CI. The main process caches, so polling here is cheap.
let pipelineBySha = {};
let pipelineSnapshot = '';
const refreshPipelines = async () => {
  const list = await window.aurora.pipelines().catch(() => null);
  const next = {};
  // the API answers newest-first — keep the latest pipeline per commit
  (list || []).forEach((pipeline) => { if (!next[pipeline.sha]) next[pipeline.sha] = pipeline; });
  const snapshot = JSON.stringify(next);
  if (snapshot === pipelineSnapshot) return;
  pipelineSnapshot = snapshot;
  pipelineBySha = next;
  if (lastCommitArgs) renderCommits(...lastCommitArgs);
};

const refresh = async () => {
  refreshPipelines().catch(() => {});
  const data = await window.aurora.overview();
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const unstaged = data.status.files
    .filter((file) => file.working_dir !== ' ' && file.working_dir !== '')
    .map((file) => ({ path: file.path, code: file.working_dir === '?' ? 'U' : file.working_dir }))
    .sort(byPath);
  const staged = data.status.files
    .filter((file) => file.index !== ' ' && file.index !== '' && file.index !== '?')
    .map((file) => ({ path: file.path, code: file.index }))
    .sort(byPath);
  // skip re-rendering (and collapsing open panels) when nothing changed — but
  // still sync an open diff view: content edits don't move the status snapshot
  const snapshot = JSON.stringify(data);
  if (snapshot === lastSnapshot) {
    syncFileView(unstaged, staged);
    return;
  }
  lastSnapshot = snapshot;
  const { repoPath, log, status, branch } = data;
  document.getElementById('repo-name').textContent = repoPath.split(/[\\/]/).pop();
  document.getElementById('branch-chip').textContent = branch.current;
  document.getElementById('changes-sub').textContent = `on ${branch.current}`;
  const setCount = (id, count) => {
    const badge = document.getElementById(id);
    badge.textContent = count;
    badge.hidden = !(count > 0);
  };
  setCount('push-count', status.ahead);
  setCount('pull-count', status.behind);
  renderSidebar(data);
  renderCommits(log, data.incoming || [], data.stashes || [], status.files.length);
  // the viewed stash may have been popped/dropped (or shifted) — bail out then
  if (centerDiff?.kind === 'stash'
    && (data.stashes || [])[centerDiff.index]?.message !== centerDiff.message) closeDiffView();
  document.querySelectorAll('.all-btn').forEach((btn) => btn.remove());
  renderFileList('unstaged-list', 'unstaged-label', 'UNSTAGED', unstaged, false);
  renderFileList('staged-list', 'staged-label', 'STAGED', staged, true);
  syncFileView(unstaged, staged);
  markViewedRow();
  stagedCount = staged.length;
  updateCommitButton();
};

const wireCommitBox = () => {
  const summaryInput = document.getElementById('commit-summary');
  const descriptionInput = document.getElementById('commit-description');
  summaryInput.addEventListener('input', () => {
    updateCommitButton();
    const wip = document.getElementById('wip-msg');
    if (wip) wip.textContent = wipText();
  });
  document.getElementById('commit-button').addEventListener('click', () => {
    const summary = summaryInput.value.trim();
    const description = descriptionInput.value.trim();
    if (!summary) return;
    act(async () => {
      await window.aurora.commit(description ? `${summary}\n\n${description}` : summary);
      summaryInput.value = '';
      descriptionInput.value = '';
    });
  });
};

// lightweight right-click menu; items = [{label, hint?, run}]
const showCtxMenu = (x, y, items) => {
  const menu = document.getElementById('ctx-menu');
  menu.replaceChildren();
  items.forEach(({ label, hint, run }) => {
    const item = el('div', 'ctx-item', label);
    if (hint) item.append(el('span', 'ctx-hint', hint));
    item.addEventListener('click', () => {
      menu.hidden = true;
      run();
    });
    menu.append(item);
  });
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
};

const wireCtxMenu = () => {
  const menu = document.getElementById('ctx-menu');
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });
  document.addEventListener('contextmenu', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  }, true);
  window.addEventListener('blur', () => { menu.hidden = true; });
};

const toast = (message, isError) => {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('error', !!isError);
  node.style.opacity = message ? '1' : '0';
  clearTimeout(toast.timer);
  if (message && !isError) toast.timer = setTimeout(() => { node.style.opacity = '0'; }, 4000);
};

const openAccountsPanel = async () => {
  const menu = document.getElementById('accounts-menu');
  await buildAccountsMenu(menu);
  menu.hidden = false;
};

// Modal error popup; `action` optionally adds a primary button, e.g. "Add account…"
const errorDialog = (title, message, action) => {
  const scrim = document.getElementById('error-modal');
  document.getElementById('error-modal-title').textContent = title;
  document.getElementById('error-modal-message').textContent = message;
  const actions = document.getElementById('error-modal-actions');
  actions.replaceChildren();
  if (action) {
    const primary = el('button', 'modal-primary', action.label);
    primary.addEventListener('click', () => {
      scrim.hidden = true;
      action.run();
    });
    actions.append(primary);
  }
  const close = el('button', 'tool-btn', action ? 'Dismiss' : 'OK');
  close.addEventListener('click', () => { scrim.hidden = true; });
  actions.append(close);
  scrim.hidden = false;
  (actions.firstChild || close).focus();
};

const wireErrorModal = () => {
  const scrim = document.getElementById('error-modal');
  scrim.addEventListener('click', (event) => {
    // keep modal clicks away from the menus' outside-click closers, so an
    // action like "Add account…" can open a panel without it snapping shut
    event.stopPropagation();
    if (event.target === scrim) scrim.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !scrim.hidden) scrim.hidden = true;
  });
};

let remoteBusy = false;

const remoteAct = async (label, action, busyEl) => {
  if (remoteBusy) return; // one remote op at a time — they'd fight over the repo
  remoteBusy = true;
  const toolbarButtons = document.querySelectorAll('.center-toolbar .tool-btn');
  toolbarButtons.forEach((button) => { button.disabled = true; });
  if (busyEl) busyEl.classList.add('busy');
  toast(`${label}…`);
  try {
    await action();
    toast(`${label} ✓`);
  } catch (error) {
    toast('');
    // the popup has room — show git's whole explanation, not just the last line
    const message = stripIpcPrefix(error.message) || `${label} failed`;
    // auth failed and no account is set up for this host — lead straight to the fix
    if (/add an account/i.test(message)) {
      errorDialog(`${label} needs authentication`, message, { label: 'Add account…', run: openAccountsPanel });
    } else {
      errorDialog(`${label} failed`, message);
    }
  } finally {
    remoteBusy = false;
    toolbarButtons.forEach((button) => { button.disabled = false; });
    if (busyEl) busyEl.classList.remove('busy');
  }
  await refresh();
};

const wireViewToggle = () => {
  const buttons = [...document.querySelectorAll('#view-toggle .view-opt')];
  const apply = () => buttons.forEach((btn) => btn.classList.toggle('selected', btn.dataset.mode === viewMode));
  apply();
  buttons.forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.mode === viewMode) return;
    viewMode = btn.dataset.mode;
    try { localStorage.setItem('aurora-view-mode', viewMode); }
    catch { /* storage unavailable — the choice still applies this session */ }
    apply();
    if (lastCommitArgs) renderCommits(...lastCommitArgs);
  }));
};

const wireToolbar = () => {
  const wire = (id, label, action) => {
    const button = document.getElementById(id);
    button.addEventListener('click', () => remoteAct(label, action, button));
  };
  wire('btn-fetch', 'Fetch', window.aurora.fetch);
  wire('btn-pull', 'Pull', window.aurora.pull);
  wire('btn-push', 'Push', window.aurora.push);
  wire('btn-stash', 'Stash', window.aurora.stash);
  const wireNameInput = (buttonId, inputId, onSubmit) => {
    const input = document.getElementById(inputId);
    document.getElementById(buttonId).addEventListener('click', () => {
      input.classList.toggle('visible');
      if (input.classList.contains('visible')) input.focus();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') input.classList.remove('visible');
      if (event.key !== 'Enter' || !input.value.trim()) return;
      const name = input.value.trim();
      input.value = '';
      input.classList.remove('visible');
      onSubmit(name);
    });
  };
  wireNameInput('btn-branch', 'branch-name', (name) =>
    remoteAct(`Branch ${name}`, () => window.aurora.createBranch(name)));
};

const buildRepoMenu = async (menu) => {
  const { repos, current } = await window.aurora.listRepos();
  menu.replaceChildren();
  repos.forEach((repoDir) => {
    const row = el('div', repoDir === current ? 'repo-row current' : 'repo-row');
    const meta = el('div', 'repo-meta');
    meta.append(
      el('div', 'repo-row-name', repoDir.split(/[\\/]/).pop()),
      el('div', 'repo-row-path', repoDir)
    );
    const removeBtn = el('button', 'repo-remove', '×');
    removeBtn.title = 'Remove from this list (the repo itself is untouched)';
    removeBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.aurora.removeRepo(repoDir);
      await buildRepoMenu(menu);
      await boot();
    });
    row.append(meta, removeBtn);
    row.addEventListener('click', async () => {
      menu.hidden = true;
      try {
        await window.aurora.selectRepo(repoDir);
      } catch (error) {
        errorDialog('Could not switch repository', errorLine(error));
      }
      await boot();
    });
    menu.append(row);
  });
  const addRow = el('div', 'repo-row add');
  addRow.append(el('div', 'repo-row-name', '+ Add repository…'));
  addRow.addEventListener('click', async () => {
    menu.hidden = true;
    try {
      if (await window.aurora.addRepo()) await boot();
    } catch (error) {
      errorDialog('Could not add repository', errorLine(error));
    }
  });
  menu.append(addRow);
};

const FLAVOR_DEFAULTS = {
  github: {
    host: 'github.com',
    hint: 'Create a token at github.com → Settings → Developer settings → Personal access tokens. Classic tokens need the repo scope; fine-grained ones need Contents read/write.'
  },
  gitlab: {
    host: 'gitlab.com',
    hint: 'Create a token under Preferences → Access tokens with the read_repository and write_repository scopes. For self-hosted GitLab, change the host to your instance.'
  }
};

const buildAccountForm = (menu) => {
  const form = el('div', 'account-form');
  let flavor = 'github';
  const flavors = el('div', 'account-flavors');
  const hostInput = el('input');
  hostInput.placeholder = 'Host';
  hostInput.spellcheck = false;
  const userInput = el('input');
  userInput.placeholder = 'Username (optional)';
  userInput.spellcheck = false;
  const tokenInput = el('input');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'Personal access token';
  const hint = el('div', 'account-hint');
  const flavorButtons = new Map();
  const setFlavor = (name) => {
    flavor = name;
    hostInput.value = FLAVOR_DEFAULTS[name].host;
    hint.textContent = FLAVOR_DEFAULTS[name].hint;
    flavorButtons.forEach((btn, key) => btn.classList.toggle('selected', key === name));
    oauthBtn.textContent = name === 'github' ? 'Sign in with GitHub…' : 'Sign in with GitLab…';
  };
  ['github', 'gitlab'].forEach((name) => {
    const btn = el('button', 'flavor-btn', name === 'github' ? 'GitHub' : 'GitLab');
    btn.addEventListener('click', () => setFlavor(name));
    flavorButtons.set(name, btn);
    flavors.append(btn);
  });
  const oauthBtn = el('button', 'account-save');
  const divider = el('div', 'form-divider', 'or paste a token');
  oauthBtn.addEventListener('click', async () => {
    const label = flavor === 'github' ? 'GitHub' : 'GitLab';
    let start;
    try {
      start = await window.aurora.oauthStart(flavor);
    } catch (error) {
      errorDialog(`${label} sign-in unavailable`, stripIpcPrefix(error.message));
      return;
    }
    const code = el('div', 'oauth-code mono', start.userCode);
    code.title = 'Click to copy';
    code.addEventListener('click', () => navigator.clipboard.writeText(start.userCode).catch(() => {}));
    const cancel = el('button', 'tool-btn', 'Cancel');
    cancel.addEventListener('click', async () => {
      await window.aurora.oauthCancel();
      await buildAccountsMenu(menu);
    });
    form.replaceChildren(
      el('div', 'account-hint', start.codePrefilled
        ? `Your browser opened ${start.verificationUri} with this code pre-filled — just approve it:`
        : `Your browser opened ${start.verificationUri} — enter this code there:`),
      code,
      el('div', 'account-hint', 'Waiting for you to authorize in the browser…'),
      cancel
    );
    // keep the code on screen while the user is off in the browser — without this,
    // the first click back in the app closes the dropdown and takes the code with it
    menu.classList.add('pinned');
    try {
      const check = await window.aurora.oauthPoll({
        flavor: start.flavor, deviceCode: start.deviceCode, interval: start.interval, expiresIn: start.expiresIn
      });
      if (!check) return; // cancelled
      toast(check.verified ? `Signed in as ${check.name}` : 'Connected — token saved but not verified', !check.verified);
      await buildAccountsMenu(menu);
      // the user is likely still in the browser when this lands — leave a
      // persistent confirmation in the panel for when they switch back
      menu.prepend(el('div', 'account-hint success',
        check.verified ? `✓ Signed in as ${check.name} — you're all set` : '✓ Connected — token saved'));
    } catch (error) {
      errorDialog(`${label} sign-in failed`, stripIpcPrefix(error.message));
      await buildAccountsMenu(menu);
    }
  });
  const save = el('button', 'account-save', 'Save account');
  save.addEventListener('click', async () => {
    if (!tokenInput.value.trim() || !hostInput.value.trim()) {
      toast('A host and a token are needed', true);
      return;
    }
    save.disabled = true;
    save.textContent = 'Checking…';
    try {
      const check = await window.aurora.addAccount({
        flavor,
        host: hostInput.value,
        username: userInput.value,
        token: tokenInput.value
      });
      toast(check.verified ? `Signed in as ${check.name}` : `Saved, but ${check.reason} — the token is untested`, !check.verified);
      await buildAccountsMenu(menu);
    } catch (error) {
      errorDialog('Could not save account', errorLine(error));
      save.disabled = false;
      save.textContent = 'Save account';
    }
  });
  setFlavor('github');
  form.append(flavors, oauthBtn, divider, hostInput, userInput, tokenInput, hint, save);
  return form;
};

const buildAccountsMenu = async (menu) => {
  menu.classList.remove('pinned'); // any rebuild ends the sign-in code view
  const accounts = await window.aurora.listAccounts();
  menu.replaceChildren();
  if (accounts.length === 0) {
    menu.append(el('div', 'account-hint',
      'Fetch, pull and push over HTTPS need an account for private repositories. Tokens are stored encrypted on this computer.'));
  }
  accounts.forEach((account) => {
    const row = el('div', 'repo-row');
    const meta = el('div', 'repo-meta');
    meta.append(
      el('div', 'repo-row-name', account.host),
      el('div', 'repo-row-path', account.verifiedName
        ? `${account.username} · verified as ${account.verifiedName}`
        : account.username)
    );
    const removeBtn = el('button', 'repo-remove', '×');
    removeBtn.title = 'Remove this account and its token';
    removeBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await window.aurora.removeAccount(account.host);
      await buildAccountsMenu(menu);
    });
    row.append(meta, removeBtn);
    menu.append(row);
  });
  const addRow = el('div', 'repo-row add');
  addRow.append(el('div', 'repo-row-name', '+ Add account…'));
  addRow.addEventListener('click', (event) => {
    // the row is replaced before the outside-click handler checks containment
    event.stopPropagation();
    addRow.replaceWith(buildAccountForm(menu));
  });
  menu.append(addRow);
};

const wireDropdown = (buttonId, menuId, builder) => {
  const button = document.getElementById(buttonId);
  const menu = document.getElementById(menuId);
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    await builder(menu);
    menu.hidden = false;
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.classList.contains('pinned') && !menu.contains(event.target)) {
      menu.hidden = true;
    }
  });
};

const wireRepoMenu = () => wireDropdown('repo-btn', 'repo-menu', buildRepoMenu);
const wireAccountsMenu = () => wireDropdown('accounts-btn', 'accounts-menu', buildAccountsMenu);

const fatalIcon = () => {
  const icon = el('div', 'fatal-icon');
  icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  return icon;
};

// Full-pane state for when the overview itself can't load (git missing, broken repo)
const renderFatal = async (error) => {
  const box = el('div', 'fatal');
  const actions = el('div', 'fatal-actions');
  const gitCheck = await window.aurora.checkGit().catch(() => ({ ok: true }));
  if (!gitCheck.ok) {
    box.append(
      fatalIcon(),
      el('div', 'fatal-title', 'Git isn’t installed'),
      el('div', 'fatal-text',
        'Aurora runs the git command behind the scenes, but couldn’t find it on this computer. '
        + 'Install Git, then restart Aurora so it picks up the new PATH.')
    );
    const download = el('button', 'tool-btn', 'Get Git from git-scm.com');
    download.addEventListener('click', () => window.aurora.openExternal('https://git-scm.com/downloads'));
    actions.append(download);
  } else {
    box.append(
      fatalIcon(),
      el('div', 'fatal-title', 'Couldn’t read this repository'),
      el('div', 'fatal-text', 'Git ran into a problem while reading the repository:'),
      el('div', 'fatal-detail mono', stripIpcPrefix(error.message) || 'Unknown error')
    );
    const { current } = await window.aurora.listRepos().catch(() => ({ current: null }));
    if (current) box.append(el('div', 'fatal-path mono', current));
  }
  const retry = el('button', 'tool-btn', 'Try again');
  retry.addEventListener('click', boot);
  actions.append(retry);
  box.append(actions);
  graphState = null;
  drawGraph();
  document.getElementById('commit-rows').replaceChildren(box);
};

const boot = () => refresh().catch((error) => renderFatal(error).catch(() => {
  document.getElementById('commit-rows')
    .replaceChildren(el('div', 'empty', `Failed to read repo: ${error.message}`));
}));

// drag handle between the commit list and the changes panel; width survives restarts
const wireSplitter = () => {
  const splitter = document.getElementById('changes-splitter');
  const changes = document.querySelector('.changes');
  const MIN = 260;
  const maxWidth = () => Math.max(MIN, window.innerWidth - 500);
  try {
    const saved = Number(localStorage.getItem('aurora-changes-width'));
    if (saved >= MIN) changes.style.width = `${Math.min(saved, maxWidth())}px`;
  } catch { /* storage unavailable — default width */ }
  splitter.addEventListener('mousedown', (event) => {
    event.preventDefault();
    splitter.classList.add('dragging');
    const startX = event.clientX;
    const startWidth = changes.getBoundingClientRect().width;
    const onMove = (move) => {
      const width = Math.min(maxWidth(), Math.max(MIN, startWidth + (startX - move.clientX)));
      changes.style.width = `${width}px`;
    };
    const onUp = () => {
      splitter.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem('aurora-changes-width', String(Math.round(changes.getBoundingClientRect().width)));
      } catch { /* storage unavailable */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
};

// sidebar sections fold on header click; the collapsed set survives restarts.
// Collapsing hides the list only — section visibility (empty remote/tags/stash
// sections) stays with renderSideSection, so the two never fight.
const wireCollapsibleSections = () => {
  let collapsed;
  try { collapsed = new Set(JSON.parse(localStorage.getItem('aurora-collapsed') || '[]')); }
  catch { collapsed = new Set(); }
  const save = () => {
    try { localStorage.setItem('aurora-collapsed', JSON.stringify([...collapsed])); }
    catch { /* storage unavailable — collapse still works for this session */ }
  };
  document.querySelectorAll('.sidebar .section-title').forEach((title) => {
    const list = title.nextElementSibling;
    title.prepend(el('span', 'collapse-chevron', '›'));
    const apply = () => {
      const isCollapsed = collapsed.has(list.id);
      list.style.display = isCollapsed ? 'none' : '';
      title.classList.toggle('collapsed', isCollapsed);
    };
    apply();
    title.addEventListener('click', () => {
      if (!collapsed.delete(list.id)) collapsed.add(list.id);
      apply();
      save();
    });
  });
};

wireCommitBox();
wireDiffView();
wireToolbar();
wireViewToggle();
wireRepoMenu();
wireAccountsMenu();
wireErrorModal();
wireSplitter();
wireCollapsibleSections();
wireCtxMenu();
// keep the graph aligned when rows shift (detail panels opening, diffs
// unfolding). ResizeObserver alone misses short lists: min-height clamps the
// wrapper, so content changes don't resize it — watch the subtree as well.
new ResizeObserver(() => drawGraph()).observe(document.getElementById('commit-rows'));
new MutationObserver(() => drawGraph())
  .observe(document.getElementById('commit-rows'), { childList: true, subtree: true });
// keep the view live: poll for outside changes and refresh when the window regains focus
setInterval(() => refresh().catch(() => {}), 4000);
window.addEventListener('focus', () => refresh().catch(() => {}));
window.aurora.version()
  .then((version) => { document.getElementById('app-version').textContent = `v${version}`; })
  .catch(() => {});
boot();

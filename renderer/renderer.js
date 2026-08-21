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

const renderSidebar = ({ branch, remoteBranches = [], tags = [], stashes = [] }) => {
  const list = document.getElementById('branch-list');
  list.replaceChildren();
  branch.all.forEach((name) => {
    const row = el('div', name === branch.current ? 'branch-row current' : 'branch-row');
    row.append(el('span', null, name));
    if (name === branch.current) {
      row.append(el('span', 'spacer'), el('span', 'head-dot'));
    }
    list.append(row);
  });
  renderSideSection('remote-section', 'remote-list', remoteBranches);
  renderSideSection('tag-section', 'tag-list', tags);
  renderSideSection('stash-section', 'stash-list', stashes);
};

const refChips = (refs) => refs
  .split(',')
  .map((ref) => ref.replace('HEAD ->', '').trim())
  .filter((ref) => ref && ref !== 'HEAD')
  .map((ref) => el('span', ref.startsWith('origin/') ? 'chip ghost' : 'chip', ref));

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

const renderDiff = (diffText) => {
  const block = el('div', 'diff-block mono');
  diffText.replace(/\n$/, '').split('\n').forEach((line) => {
    let cls = 'diff-line';
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file)/.test(line)) cls += ' meta';
    else if (line.startsWith('@@')) cls += ' hunk';
    else if (line.startsWith('+')) cls += ' add';
    else if (line.startsWith('-')) cls += ' del';
    block.append(el('div', cls, line || ' '));
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
  return detail;
};

const renderCommits = (log, changedCount) => {
  const list = document.getElementById('commit-list');
  list.replaceChildren();
  if (changedCount > 0) {
    // ghost commit: what the next commit would be, sitting above HEAD
    const row = el('div', 'commit-row ghost');
    const lane = el('div', 'lane');
    lane.append(el('div', log.length > 0 ? 'line below dashed' : 'line none'), el('div', 'node ghost'));
    row.append(
      lane,
      el('span', 'ghost-msg', `${changedCount} file${changedCount === 1 ? '' : 's'} changed — not committed yet`),
      el('span', 'commit-date', 'now'),
      el('span', 'commit-hash mono', 'WIP')
    );
    list.append(row);
  }
  log.forEach((commit, index) => {
    const row = el('div', 'commit-row');
    const color = authorColor(commit.author_name);
    const lane = el('div', 'lane');
    // the timeline caps at its topmost node — the ghost when present, else the
    // newest commit; the ghost-to-HEAD segment is dashed on both rows' halves
    const node = el('div', index === 0 ? 'node head' : 'node');
    node.style.borderColor = color;
    if (index === 0) node.style.background = color;
    if (index === 0 && changedCount > 0) {
      lane.append(el('div', 'line half-top dashed'), el('div', 'line below'));
    } else {
      lane.append(el('div', index === 0 ? 'line below' : 'line'));
    }
    lane.append(node);
    const main = el('div', 'commit-main');
    main.append(el('span', 'commit-msg', commit.message));
    if (commit.refs) main.append(...refChips(commit.refs));
    const avatar = el('div', 'avatar', (commit.author_name || '?')[0].toUpperCase());
    avatar.style.color = color;
    avatar.style.background = `${color}22`;
    row.append(
      lane,
      main,
      avatar,
      el('span', 'commit-author', commit.author_name || 'unknown'),
      el('span', 'commit-date', relTime(commit.date)),
      el('span', 'commit-hash mono', commit.hash.slice(0, 7))
    );
    row.addEventListener('click', async () => {
      const open = list.querySelector('.commit-detail');
      const wasThisOne = row.nextElementSibling === open;
      if (open) open.remove();
      list.querySelectorAll('.commit-row.open').forEach((r) => r.classList.remove('open'));
      if (wasThisOne) return;
      row.classList.add('open');
      let detail;
      try {
        detail = await renderCommitDetail(commit.hash);
      } catch (error) {
        detail = el('div', 'commit-detail');
        detail.append(el('div', 'empty', `Failed to load commit: ${error.message}`));
      }
      row.after(detail);
      detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    list.append(row);
  });
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
    showError(error.message.split('\n').pop() || 'git command failed');
  }
  await refresh();
};

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
    const row = el('div', staged ? 'file-row staged' : 'file-row');
    row.title = staged ? 'Click to unstage' : 'Click to stage';
    const { name, dir } = splitPath(file.path);
    const meta = el('div', 'file-meta');
    meta.append(el('span', 'file-name', name));
    if (dir) meta.append(el('span', 'file-dir', dir));
    row.append(
      el('span', staged ? 'badge staged' : 'badge', file.code),
      meta,
      el('span', 'action', staged ? '−' : '+')
    );
    row.addEventListener('click', () => {
      act(() => staged ? window.aurora.unstage([file.path]) : window.aurora.stage([file.path]));
    });
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

const refresh = async () => {
  const data = await window.aurora.overview();
  // skip re-rendering (and collapsing open panels) when nothing changed
  const snapshot = JSON.stringify(data);
  if (snapshot === lastSnapshot) return;
  lastSnapshot = snapshot;
  const { repoPath, log, status, branch } = data;
  document.getElementById('repo-name').textContent = repoPath.split(/[\\/]/).pop();
  document.getElementById('branch-chip').textContent = branch.current;
  document.getElementById('changes-sub').textContent = `on ${branch.current}`;
  document.querySelector('#btn-push .lbl').textContent = status.ahead > 0 ? `Push ↑${status.ahead}` : 'Push';
  document.querySelector('#btn-pull .lbl').textContent = status.behind > 0 ? `Pull ↓${status.behind}` : 'Pull';
  renderSidebar(data);
  renderCommits(log, status.files.length);
  document.querySelectorAll('.all-btn').forEach((btn) => btn.remove());
  const unstaged = status.files
    .filter((file) => file.working_dir !== ' ' && file.working_dir !== '')
    .map((file) => ({ path: file.path, code: file.working_dir === '?' ? 'U' : file.working_dir }));
  const staged = status.files
    .filter((file) => file.index !== ' ' && file.index !== '' && file.index !== '?')
    .map((file) => ({ path: file.path, code: file.index }));
  renderFileList('unstaged-list', 'unstaged-label', 'UNSTAGED', unstaged, false);
  renderFileList('staged-list', 'staged-label', 'STAGED', staged, true);
  stagedCount = staged.length;
  updateCommitButton();
};

const wireCommitBox = () => {
  const summaryInput = document.getElementById('commit-summary');
  const descriptionInput = document.getElementById('commit-description');
  summaryInput.addEventListener('input', updateCommitButton);
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

const toast = (message, isError) => {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('error', !!isError);
  node.style.opacity = message ? '1' : '0';
  clearTimeout(toast.timer);
  if (message && !isError) toast.timer = setTimeout(() => { node.style.opacity = '0'; }, 4000);
};

const remoteAct = async (label, action) => {
  toast(`${label}…`);
  try {
    await action();
    toast(`${label} ✓`);
  } catch (error) {
    toast((error.message || '').split('\n').filter(Boolean).pop() || `${label} failed`, true);
  }
  await refresh();
};

const wireToolbar = () => {
  document.getElementById('btn-fetch').addEventListener('click', () => remoteAct('Fetch', window.aurora.fetch));
  document.getElementById('btn-pull').addEventListener('click', () => remoteAct('Pull', window.aurora.pull));
  document.getElementById('btn-push').addEventListener('click', () => remoteAct('Push', window.aurora.push));
  document.getElementById('btn-stash').addEventListener('click', () => remoteAct('Stash', window.aurora.stash));
  const nameInput = document.getElementById('branch-name');
  document.getElementById('btn-branch').addEventListener('click', () => {
    nameInput.classList.toggle('visible');
    if (nameInput.classList.contains('visible')) nameInput.focus();
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') nameInput.classList.remove('visible');
    if (event.key !== 'Enter' || !nameInput.value.trim()) return;
    const name = nameInput.value.trim();
    nameInput.value = '';
    nameInput.classList.remove('visible');
    remoteAct(`Branch ${name}`, () => window.aurora.createBranch(name));
  });
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
        toast(error.message.split('\n').filter(Boolean).pop(), true);
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
      toast(error.message.split('\n').filter(Boolean).pop(), true);
    }
  });
  menu.append(addRow);
};

const wireRepoMenu = () => {
  const button = document.getElementById('repo-btn');
  const menu = document.getElementById('repo-menu');
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    await buildRepoMenu(menu);
    menu.hidden = false;
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });
};

// Electron wraps handler rejections as "Error invoking remote method 'x': Error: <msg>"
const stripIpcPrefix = (message) =>
  (message || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();

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
  document.getElementById('commit-list').replaceChildren(box);
};

const boot = () => refresh().catch((error) => renderFatal(error).catch(() => {
  document.getElementById('commit-list')
    .replaceChildren(el('div', 'empty', `Failed to read repo: ${error.message}`));
}));

wireCommitBox();
wireToolbar();
wireRepoMenu();
// keep the view live: poll for outside changes and refresh when the window regains focus
setInterval(() => refresh().catch(() => {}), 4000);
window.addEventListener('focus', () => refresh().catch(() => {}));
boot();

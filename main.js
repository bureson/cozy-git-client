const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const simpleGit = require('simple-git');

// test isolation: drivers point userData at a scratch dir so they never touch the real config
if (process.env.AURORA_USER_DATA) app.setPath('userData', process.env.AURORA_USER_DATA);

const DEFAULT_REPO = 'C:/Users/Ondrej/Documents/triggerz/triggerz';
const configFile = () => path.join(app.getPath('userData'), 'repos.json');

const isGitRepo = (dir) => {
  try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
};

const loadConfig = () => {
  try {
    const stored = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (Array.isArray(stored.repos)) return stored;
  } catch { /* first run or unreadable — reseed below */ }
  return null;
};

const saveConfig = () => {
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch { /* config is a convenience — never take the app down over it */ }
};

let repoPath;
let git;
const setRepo = (dir) => {
  repoPath = dir;
  git = simpleGit(dir);
};

// seeded with the two repos Ondrej maintains; grows via the in-app "Add repository"
const config = loadConfig()
  || { repos: [DEFAULT_REPO, __dirname].filter(isGitRepo), current: null };

// `electron . <repoPath>` / `Aurora.exe <repoPath>` — a CLI repo wins for this session
// but is NOT saved to the config. Launchers inject extra arguments (Playwright adds
// --flags, electronmon adds `--require <hook.js>` whose VALUE looks positional), so
// positional slots are unreliable: take the last positional, require it to be a real
// git repo other than the app itself.
const positional = process.argv.slice(1).filter((arg) => !arg.startsWith('-'));
const argCandidate = positional.length > 0 ? path.resolve(positional[positional.length - 1]) : null;
if (argCandidate && argCandidate !== __dirname && isGitRepo(argCandidate)) {
  setRepo(argCandidate);
} else if (config.current && isGitRepo(config.current)) {
  setRepo(config.current);
} else {
  // no valid repo is not fatal — the renderer shows a picker-friendly error state
  const fallback = config.repos.find(isGitRepo) || (isGitRepo(DEFAULT_REPO) ? DEFAULT_REPO : null);
  if (fallback) setRepo(fallback);
}

let win;

ipcMain.handle('repos:list', () => ({ repos: config.repos, current: repoPath || null }));

// re-checked on every call so "Try again" reflects a fix without restarting
ipcMain.handle('app:checkGit', () => new Promise((resolve) => {
  execFile('git', ['--version'], (error, stdout) => {
    resolve(error ? { ok: false } : { ok: true, version: String(stdout).trim() });
  });
}));

ipcMain.handle('app:openExternal', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) return shell.openExternal(url);
});

ipcMain.handle('repos:select', (_event, dir) => {
  if (!isGitRepo(dir)) throw new Error(`Not a git repository: ${dir}`);
  setRepo(dir);
  config.current = dir;
  saveConfig();
});

ipcMain.handle('repos:add', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a git repository',
    properties: ['openDirectory']
  });
  const chosen = result.filePaths[0];
  if (result.canceled || !chosen) return null;
  if (!isGitRepo(chosen)) throw new Error('That folder is not a git repository');
  if (!config.repos.includes(chosen)) config.repos.push(chosen);
  setRepo(chosen);
  config.current = chosen;
  saveConfig();
  return chosen;
});

ipcMain.handle('repos:remove', (_event, dir) => {
  config.repos = config.repos.filter((repo) => repo !== dir);
  if (config.current === dir) config.current = config.repos[0] || null;
  if (repoPath === dir && config.repos.length > 0) setRepo(config.repos[0]);
  saveConfig();
});

ipcMain.handle('git:overview', async () => {
  if (!git) throw new Error('No repository selected — use the repo menu to add one.');
  const [log, status, branch, remote, tags, stashes] = await Promise.all([
    git.log({ maxCount: 30 }).catch(() => ({ all: [] })), // repos with no commits yet
    git.status(),
    git.branchLocal(),
    git.branch(['-r']).catch(() => ({ all: [] })),
    git.tags().catch(() => ({ all: [] })),
    git.stashList().catch(() => ({ all: [] }))
  ]);
  // simple-git results carry methods, which structured clone rejects — return plain data
  return {
    repoPath,
    log: log.all.map(({ hash, date, message, refs, author_name }) => ({ hash, date, message, refs, author_name })),
    status: {
      ahead: status.ahead,
      behind: status.behind,
      tracking: status.tracking,
      files: status.files.map(({ path: filePath, index, working_dir }) => ({ path: filePath, index, working_dir }))
    },
    branch: { current: branch.current, all: branch.all },
    remoteBranches: remote.all.filter((name) => !name.includes('->')),
    tags: tags.all,
    stashes: (stashes.all || []).map((stash) => stash.message)
  };
});

ipcMain.handle('git:fetch', () => git.fetch());
ipcMain.handle('git:pull', () => git.pull());
ipcMain.handle('git:push', () => git.push());
ipcMain.handle('git:createBranch', (_event, name) => git.checkoutLocalBranch(name));
ipcMain.handle('git:stash', () => git.stash(['push', '-u']));

ipcMain.handle('git:commitDetail', async (_event, hash) => {
  // \x1f (unit separator) can't appear in author names or messages
  const meta = (await git.show([hash, '--no-patch', '--format=%an%x1f%ae%x1f%aI%x1f%B']))
    .split('\x1f');
  const numstat = await git.show([hash, '--numstat', '--format=']);
  const files = numstat.split('\n').filter(Boolean).map((line) => {
    const [added, removed, filePath] = line.split('\t');
    return { path: filePath, added, removed }; // "-" for binary files
  });
  return { author: meta[0], email: meta[1], date: meta[2], body: (meta[3] || '').trim(), files };
});

ipcMain.handle('git:fileDiff', (_event, hash, filePath) =>
  git.show([hash, '--format=', '--patch', '--', filePath]));

ipcMain.handle('git:stage', (_event, paths) => git.add(paths));
// `restore --staged` unstages both modified and newly-added files without touching the worktree
ipcMain.handle('git:unstage', (_event, paths) => git.raw(['restore', '--staged', '--', ...paths]));
ipcMain.handle('git:commit', (_event, message) => git.commit(message));

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#10131b',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile('renderer/index.html');
});

app.on('window-all-closed', () => app.quit());

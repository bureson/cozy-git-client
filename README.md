# Aurora

A cozy git client for Windows, built with Electron.

Aurora opens a repository and gives you the essentials in one calm, dark window: the commit history, your local branches, and a changes panel where you stage files with a click and commit with a summary and description.

![Aurora showing a repository with staged changes](docs/screenshot.png)

## Features

- **Commit history** — the last 30 commits with relative timestamps, author avatars, short hashes, and branch/remote ref chips.
- **Branches** — local branches in the sidebar, with the current branch highlighted.
- **Staging** — unstaged and staged changes side by side; click a file to stage or unstage it, or use the *stage all* / *unstage all* shortcuts.
- **Committing** — summary + optional description; the button stays disabled until there is a summary and at least one staged file. Git errors surface inline instead of failing silently.

## Getting started

Requirements: [Node.js](https://nodejs.org) (v22 or later) and git available on `PATH`.

```powershell
npm install
npm start                    # opens the default repository
npm start -- C:\path\to\repo # opens a specific repository
```

## Building an executable

```powershell
npm run pack   # quick unpacked build in dist\win-unpacked\
npm run dist   # portable Aurora <version>.exe + one-click installer in dist\
```

`npm run dist` produces two artifacts:

- **`Aurora <version>.exe`** — portable single-file build; run it from anywhere, optionally with a repository path as the first argument.
- **`Aurora Setup <version>.exe`** — one-click installer with a Start-menu entry and uninstaller.

The binaries are unsigned, so Windows SmartScreen shows a warning on first launch — choose *More info → Run anyway*.

## How it works

| File | Role |
|---|---|
| `main.js` | Electron main process; runs all git operations via [simple-git](https://github.com/steveukx/git-js) and exposes them over IPC (`git:overview`, `git:stage`, `git:unstage`, `git:commit`). |
| `preload.js` | Bridges the IPC handlers into the page as `window.aurora` via `contextBridge`. |
| `renderer/` | The UI — plain HTML/CSS/JS, no framework. Re-renders the whole view from fresh git state after every action. |

The renderer never touches the filesystem or git directly; everything goes through the typed `window.aurora` API.

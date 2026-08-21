const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aurora', {
  overview: () => ipcRenderer.invoke('git:overview'),
  commitDetail: (hash) => ipcRenderer.invoke('git:commitDetail', hash),
  fileDiff: (hash, filePath) => ipcRenderer.invoke('git:fileDiff', hash, filePath),
  stage: (paths) => ipcRenderer.invoke('git:stage', paths),
  unstage: (paths) => ipcRenderer.invoke('git:unstage', paths),
  commit: (message) => ipcRenderer.invoke('git:commit', message),
  fetch: () => ipcRenderer.invoke('git:fetch'),
  pull: () => ipcRenderer.invoke('git:pull'),
  push: () => ipcRenderer.invoke('git:push'),
  createBranch: (name) => ipcRenderer.invoke('git:createBranch', name),
  stash: () => ipcRenderer.invoke('git:stash'),
  checkGit: () => ipcRenderer.invoke('app:checkGit'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  selectRepo: (dir) => ipcRenderer.invoke('repos:select', dir),
  addRepo: () => ipcRenderer.invoke('repos:add'),
  removeRepo: (dir) => ipcRenderer.invoke('repos:remove', dir)
});

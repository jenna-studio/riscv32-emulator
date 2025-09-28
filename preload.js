const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
    pickAsm: () => ipcRenderer.invoke("pick-asm"),
    buildEmu: () => ipcRenderer.invoke("build-emu"),
    runEmu: (asmPath) => ipcRenderer.invoke("run-emu", asmPath),
    sendCmd: (line) => ipcRenderer.invoke("send-cmd", line),
    stopEmu: () => ipcRenderer.invoke("stop-emu"),
    readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke("save-file", filePath, content),
    newFile: (defaultName, content) => ipcRenderer.invoke("new-file", defaultName, content),
    onOutput: (cb) => {
        const handler = (_e, data) => cb(data);
        ipcRenderer.on("emu-output", handler);
        return () => ipcRenderer.removeListener("emu-output", handler);
    },
    pickFolder: () => ipcRenderer.invoke("pick-folder"),
    listSFiles: (dir) => ipcRenderer.invoke("list-s-files", dir),
    openPath: (p) => ipcRenderer.invoke("open-path", p),
});

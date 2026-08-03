import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import { probeMedia, generateThumbnailDataUrl, exportProject } from './ffmpegService'
import type { Project, AspectRatio } from '@shared/types'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  ipcMain.handle(IPC.selectMediaFiles, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '動画ファイル', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectExportPath, async (_e, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'MP4動画', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(
    IPC.exportProject,
    async (
      event,
      payload: {
        project: Project
        aspectRatio: AspectRatio
        resolutionHeight: 720 | 1080
        outputPath: string
      }
    ) => {
      await exportProject({
        project: payload.project,
        aspectRatio: payload.aspectRatio,
        resolutionHeight: payload.resolutionHeight,
        outputPath: payload.outputPath,
        onProgress: (percent, stage) => {
          event.sender.send(IPC.exportProgress, { percent, stage })
        }
      })
      return { success: true }
    }
  )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.videoeditor.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle(IPC.probeMedia, async (_e, filePath: string) => probeMedia(filePath))
  ipcMain.handle(IPC.generateThumbnail, async (_e, filePath: string, atSeconds: number) =>
    generateThumbnailDataUrl(filePath, atSeconds)
  )
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    await shell.openExternal(url)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

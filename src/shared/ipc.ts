export const IPC = {
  selectMediaFiles: 'media:selectFiles',
  selectAudioFiles: 'media:selectAudioFiles',
  probeMedia: 'media:probe',
  generateThumbnail: 'media:thumbnail',
  detectSilence: 'media:detectSilence',
  transcribe: 'media:transcribe',
  selectExportPath: 'export:selectPath',
  exportProject: 'export:run',
  exportProgress: 'export:progress',
  openExternal: 'shell:openExternal'
} as const

export const IPC = {
  selectMediaFiles: 'media:selectFiles',
  probeMedia: 'media:probe',
  generateThumbnail: 'media:thumbnail',
  selectExportPath: 'export:selectPath',
  exportProject: 'export:run',
  exportProgress: 'export:progress',
  openExternal: 'shell:openExternal'
} as const

export const IPC = {
  selectMediaFiles: 'media:selectFiles',
  selectAudioFiles: 'media:selectAudioFiles',
  probeMedia: 'media:probe',
  generateThumbnail: 'media:thumbnail',
  generateWaveform: 'media:waveform',
  detectSilence: 'media:detectSilence',
  transcribe: 'media:transcribe',
  voicevoxListSpeakers: 'voicevox:listSpeakers',
  voicevoxSynthesize: 'voicevox:synthesize',
  selectExportPath: 'export:selectPath',
  exportProject: 'export:run',
  exportProgress: 'export:progress',
  openExternal: 'shell:openExternal'
} as const

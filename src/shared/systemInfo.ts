/** 処理の記録に載せる PC の構成 */
export interface SystemInfo {
  os: string
  cpu: string
  cores: number
  memoryGb: number
  gpu: string[]
  app: string
}

import { readFcp7, type Fcp7Sequence, type XmlElement } from '@shared/import/fcp7'

/** Premiere の XML(FCP7)を読む。シーケンスが無い・XML として読めなければ理由つきで失敗する */
export async function loadEditXml(filePath: string): Promise<Fcp7Sequence> {
  const text = await window.api.readEditXml(filePath)
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length > 0)
    throw new Error('XML として読めませんでした(壊れているか、XML ではありません)')
  const seq = readFcp7(doc.documentElement as unknown as XmlElement)
  if (!seq)
    throw new Error(
      'シーケンスが見つかりませんでした(Final Cut Pro XML で書き出したものを選んでください)'
    )
  return seq
}

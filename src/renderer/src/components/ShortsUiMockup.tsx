function HeartGlyph(): React.JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
      <path d="M12 21s-7.5-4.6-10-9.1C0.3 8.7 1.8 5 5.4 4.2c2-0.4 4 0.5 6.6 3 2.6-2.5 4.6-3.4 6.6-3 3.6 0.8 5.1 4.5 3.4 7.7C19.5 16.4 12 21 12 21z" />
    </svg>
  )
}

function CommentGlyph(): React.JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="white">
      <path
        d="M4 4h16v11H8l-4 4V4z"
        fillOpacity="0"
        stroke="white"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ShareGlyph(): React.JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
      <path
        d="M4 12l8-8v5c6 0 8 3 8 9-2-3-4-4-8-4v5z"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MusicNoteGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
      <path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
    </svg>
  )
}

export function ShortsUiMockup(): React.JSX.Element {
  return (
    <div className="shorts-ui-mockup">
      <div className="shorts-ui-badge">Shorts UI プレビュー(参考イメージ)</div>
      <div className="shorts-ui-rail">
        <div className="shorts-ui-avatar" />
        <div className="shorts-ui-rail-item">
          <HeartGlyph />
          <span>12.3万</span>
        </div>
        <div className="shorts-ui-rail-item">
          <CommentGlyph />
          <span>856</span>
        </div>
        <div className="shorts-ui-rail-item">
          <ShareGlyph />
          <span>共有</span>
        </div>
        <div className="shorts-ui-rail-item">
          <div className="shorts-ui-disc" />
        </div>
      </div>
      <div className="shorts-ui-bottom">
        <div className="shorts-ui-channel">
          <span className="shorts-ui-avatar-small" />
          @channel_name
          <span className="shorts-ui-follow">登録</span>
        </div>
        <div className="shorts-ui-desc">動画の説明文がここに入ります…</div>
        <div className="shorts-ui-music">
          <MusicNoteGlyph />
          オリジナル楽曲
        </div>
      </div>
      <div className="shorts-ui-progress" />
    </div>
  )
}

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function base(props: IconProps): IconProps {
  return {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props
  }
}

export function PlayIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function PauseIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ScissorsIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  )
}

export function TrashIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export function UploadIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

export function DownloadIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

export function SparklesIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 3l1.6 4.8L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.2L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
    </svg>
  )
}

export function TypeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  )
}

export function YoutubeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M22.5 6.2a2.9 2.9 0 0 0-2-2C18.9 3.7 12 3.7 12 3.7s-6.9 0-8.5.5a2.9 2.9 0 0 0-2 2A30 30 0 0 0 1 12a30 30 0 0 0 .5 5.8 2.9 2.9 0 0 0 2 2c1.6.5 8.5.5 8.5.5s6.9 0 8.5-.5a2.9 2.9 0 0 0 2-2A30 30 0 0 0 23 12a30 30 0 0 0-.5-5.8z" />
      <polygon points="9.8 15.5 15.8 12 9.8 8.5 9.8 15.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ExternalLinkIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

export function LinkIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

export function ClapperboardIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
      <path d="m6.2 5.3 3.1 3.9" />
      <path d="m12.4 3.4 3.1 4" />
      <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

export function KeyIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  )
}

export function MusicIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

export function Volume2Icon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </svg>
  )
}

export function VolumeXIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

export function GaugeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      <path d="M12 3a9 9 0 0 0-8.5 12" />
      <path d="M12 3a9 9 0 0 1 8.5 12" />
      <path d="m13.5 10.5 3-4" />
    </svg>
  )
}

export function LayersIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  )
}

export function MicIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

export function WandIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="m15 4 1.5 1.5" />
      <path d="M3 21 16.5 7.5" />
      <path d="m18 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
      <path d="m6 15 .8 1.6L8.4 17l-1.6.8L6 19.4l-.8-1.6L3.6 17l1.6-.8z" />
    </svg>
  )
}

export function UndoIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7" />
    </svg>
  )
}

export function RedoIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M21 7v6h-6" />
      <path d="M21 13a9 9 0 1 1-3-7" />
    </svg>
  )
}

export function CopyIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function ClipboardPasteIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="M9 14h6" />
      <path d="M9 18h6" />
    </svg>
  )
}

export function ZoomInIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  )
}

export function ZoomOutIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  )
}

export function FolderIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

export function PlayCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SaveIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  )
}

export function FolderOpenIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H5" />
      <path d="m3 7 1.5 11a2 2 0 0 0 2 1.8h11a2 2 0 0 0 2-1.8L21 10H5.5A2 2 0 0 0 3.5 12" />
    </svg>
  )
}

export function FilePlusIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  )
}

export function AlertTriangleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="m10.29 3.86-8.18 14.14A1.5 1.5 0 0 0 3.4 20.3h17.2a1.5 1.5 0 0 0 1.29-2.3L13.71 3.86a1.5 1.5 0 0 0-2.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

export function TargetIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ImageIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  )
}

export function DuckingIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 10v4a2 2 0 0 0 2 2h2l4 3V5L8 8H6a2 2 0 0 0-2 2z" />
      <path d="M20 9v6" />
      <path d="M17 11v2" />
    </svg>
  )
}

export function FillerWordIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 4h16v11H8l-4 4V4z" />
      <path d="M2 2l20 20" />
    </svg>
  )
}

export function MegaphoneIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 11v2a2 2 0 0 0 2 2h1l2 6h2l-1-6h2l9 4V5l-9 4H6a2 2 0 0 0-2 2z" />
      <path d="M14 9v6" />
    </svg>
  )
}

export function StarIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.3l-5.9 3.2 1.2-6.5-4.8-4.6 6.6-.9z" />
    </svg>
  )
}

export function ActivityIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}

export function ShuffleIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 6h3.5a4 4 0 0 1 3.2 1.6l6.6 8.8a4 4 0 0 0 3.2 1.6H21" />
      <path d="M17 4l4 4-4 4" />
      <path d="M3 18h3.5a4 4 0 0 0 3.2-1.6l1-1.3" />
      <path d="M14 7.3L15.7 5.4A4 4 0 0 1 18.7 4H21" />
      <path d="M17 12l4 4-4 4" />
    </svg>
  )
}

export function MagnetIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M6 15V6a4 4 0 0 1 8 0v9" />
      <path d="M18 15a6 6 0 0 1-12 0v-3h4v3a2 2 0 0 0 4 0v-3h4z" />
    </svg>
  )
}

export function MaximizeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

export function ThumbsUpIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M7 10v11" />
      <path d="M18.5 10H21a1 1 0 0 1 1 1.2l-1.4 7A2 2 0 0 1 18.6 20H10a2 2 0 0 1-2-2v-8.6a2 2 0 0 1 .4-1.2L12 3a1.5 1.5 0 0 1 3 1v6z" />
    </svg>
  )
}

export function ThumbsDownIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M17 14V3" />
      <path d="M5.5 14H3a1 1 0 0 1-1-1.2l1.4-7A2 2 0 0 1 5.4 4H14a2 2 0 0 1 2 2v8.6a2 2 0 0 1-.4 1.2L12 21a1.5 1.5 0 0 1-3-1v-6z" />
    </svg>
  )
}

export function EyeIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function EyeOffIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M17.9 17.9A11 11 0 0 1 12 20c-7 0-11-8-11-8a19.4 19.4 0 0 1 5-5.9" />
      <path d="M9.9 5.2A10.6 10.6 0 0 1 12 5c7 0 11 8 11 8a19.6 19.6 0 0 1-2.6 3.9" />
      <path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

export function SkipBackIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <line x1="5" y1="4" x2="5" y2="20" stroke="currentColor" />
      <polygon points="19 5 8 12 19 19 19 5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function SkipForwardIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <line x1="19" y1="4" x2="19" y2="20" stroke="currentColor" />
      <polygon points="5 5 16 12 5 19 5 5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function StepBackIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <line x1="6" y1="5" x2="6" y2="19" stroke="currentColor" />
      <polygon points="19 6 9 12 19 18 19 6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function StepForwardIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <line x1="18" y1="5" x2="18" y2="19" stroke="currentColor" />
      <polygon points="5 6 15 12 5 18 5 6" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function TagIcon(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.2" />
    </svg>
  )
}

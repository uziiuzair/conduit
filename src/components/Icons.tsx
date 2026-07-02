// Minimal inline-SVG icon set standing in for the SF Symbols the Swift app uses.
// All stroke-based, inherit `currentColor`.

type P = { size?: number; className?: string };

const svg = (size: number, className: string | undefined, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ flexShrink: 0 }}
  >
    {children}
  </svg>
);

export const FolderIcon = ({ size = 12, className }: P) =>
  svg(size, className, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" stroke="none" />);

export const FolderPlusIcon = ({ size = 12, className }: P) =>
  svg(size, className, (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </>
  ));

export const TerminalIcon = ({ size = 12, className }: P) =>
  svg(size, className, (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ));

export const PlusIcon = ({ size = 12, className }: P) =>
  svg(size, className, <path d="M12 5v14M5 12h14" />);

export const EllipsisIcon = ({ size = 14, className }: P) =>
  svg(size, className, (
    <>
      <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ));

export const RefreshIcon = ({ size = 13, className }: P) =>
  svg(size, className, (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </>
  ));

export const CodeIcon = ({ size = 12, className }: P) =>
  svg(size, className, <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />);

export const FileIcon = ({ size = 13, className }: P) =>
  svg(size, className, (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ));

export const ChevronRightIcon = ({ size = 12, className }: P) =>
  svg(size, className, <path d="M9 6l6 6-6 6" />);

export const CloseIcon = ({ size = 12, className }: P) =>
  svg(size, className, <path d="M6 6l12 12M18 6l-12 12" />);

export const ClockIcon = ({ size = 12, className }: P) =>
  svg(size, className, (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4l2.5 2" />
    </>
  ));

// Todo / status circles
export const CircleIcon = ({ size = 13, className }: P) =>
  svg(size, className, <circle cx="12" cy="12" r="8" />);

export const CircleDashedIcon = ({ size = 13, className }: P) =>
  svg(size, className, <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />);

export const CircleFilledIcon = ({ size = 13, className }: P) =>
  svg(size, className, (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ));

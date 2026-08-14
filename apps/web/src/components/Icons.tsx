import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function IconBase(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.2-4.2" />
    </IconBase>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 20.5c-5.2-3.2-8-6.2-8-9.8A4.7 4.7 0 0 1 8.8 6c1.4 0 2.8.6 3.7 1.7A4.9 4.9 0 0 1 16.2 6 4.7 4.7 0 0 1 21 10.7c0 3.6-2.8 6.6-8 9.8Z" />
    </IconBase>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </IconBase>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 7 8 5-8 5Z" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 7v10" />
      <path d="M15 7v10" />
    </IconBase>
  );
}

export function PreviousIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 7v10" />
      <path d="m18 7-8 5 8 5Z" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function NextIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 7v10" />
      <path d="m6 7 8 5-8 5Z" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function ShuffleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h3l10 10h3" />
      <path d="m18 17 2 0-1.5 2" />
      <path d="M4 17h3l3-3" />
      <path d="M14 7h3l3 3" />
      <path d="m18 7 2 0-1.5-2" />
    </IconBase>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 10h4l5-4v12l-5-4H4z" />
      <path d="M17 9a4 4 0 0 1 0 6" />
    </IconBase>
  );
}

export function VolumeOffIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 10h4l5-4v12l-5-4H4z" />
      <path d="m17 9 4 6" />
      <path d="m21 9-4 6" />
    </IconBase>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </IconBase>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </IconBase>
  );
}

export function SpinnerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
    </IconBase>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 20h16" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5Z" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  );
}

export function RetryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 7v5h-5" />
      <path d="M18.5 16a8 8 0 1 1 .7-8L20 12" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12 4 4 10-10" />
    </IconBase>
  );
}

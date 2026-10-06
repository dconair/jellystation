import type { CategoryIconName } from "../data/types";

// Schlichte, einfarbige Linien-Icons im Stil der XMB (24×24-Raster).
const paths: Record<CategoryIconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
    </>
  ),
  movies: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
    </>
  ),
  series: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="1.5" />
      <path d="M9 21h6M12 18v3M8 3l4 3 4-3" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  photos: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <circle cx="9" cy="10" r="2" />
      <path d="m3.5 18 5.5-5 4 3.5 3-2.5 4.5 4" />
    </>
  ),
  livetv: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="1.5" />
      <path d="m8 3 4 4 4-4" />
      <circle cx="12" cy="13.5" r="2" />
    </>
  ),
  games: (
    <>
      <path d="M7 8h10a4 4 0 0 1 4 4.2l-.6 4.2a2.2 2.2 0 0 1-3.9 1.1L14.8 15H9.2l-1.7 2.5a2.2 2.2 0 0 1-3.9-1.1L3 12.2A4 4 0 0 1 7 8z" />
      <path d="M8 10.5v3M6.5 12h3" />
      <circle cx="15.5" cy="11" r="0.7" />
      <circle cx="17.5" cy="13" r="0.7" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
};

export function CategoryIcon({ name }: { name: CategoryIconName }) {
  return (
    <svg
      className="xmb-icon-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

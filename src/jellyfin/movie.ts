import type { ArtSource } from "../data/types";
import type { JfContext } from "./context";
import { JfError, statusError } from "./errors";
import { artHeaders, jfRaw } from "./http";

type HttpArt = Extract<ArtSource, { kind: "http" }>;

/** Eine wählbare Ton- oder Untertitelspur (Stream-Index auf dem Server, Anzeigename des Servers). */
export interface MovieTrack {
  index: number;
  label: string;
  isDefault: boolean;
}

/** Eine Fassung des Films (z. B. 4K und 1080p liegen als zwei Dateien vor). */
export interface MovieVersion {
  id: string;
  name: string;
  audio: MovieTrack[];
  subtitles: MovieTrack[];
}

/** Alles, was die Detailseite eines Films über den Titel hinaus zeigt. */
export interface MovieInfo {
  id: string;
  name: string;
  overview: string;
  tagline?: string;
  year?: number;
  runTimeTicks?: number;
  genres: string[];
  /** Altersfreigabe, z. B. "FSK-12" oder "PG-13". */
  officialRating?: string;
  /** Nutzerwertung 0–10. */
  communityRating?: number;
  directors: string[];
  cast: string[];
  studios: string[];
  /** Titellogo (transparentes PNG), falls vorhanden. */
  logo?: HttpArt;
  /** Hintergrundbild im Querformat, falls vorhanden. */
  backdrop?: HttpArt;
  versions: MovieVersion[];
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

function parseVersion(raw: Record<string, unknown>, fallbackName: string): MovieVersion | null {
  const id = text(raw.Id);
  if (!id) return null;
  const audio: MovieTrack[] = [];
  const subtitles: MovieTrack[] = [];
  for (const s of list(raw.MediaStreams)) {
    const index = finite(s.Index);
    if (index === undefined) continue;
    const type = text(s.Type);
    const label = text(s.DisplayTitle) || text(s.Title) || text(s.Language) || `Spur ${index}`;
    const track: MovieTrack = { index, label, isDefault: s.IsDefault === true };
    if (type === "Audio") audio.push(track);
    else if (type === "Subtitle") subtitles.push(track);
  }
  return { id, name: text(raw.Name) || fallbackName, audio, subtitles };
}

/** Liest die Server-Antwort zu einem Film; ohne Id gibt es null. */
export function parseMovieInfo(raw: unknown, ctx: Pick<JfContext, "base" | "apiKey">): MovieInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const dto = raw as Record<string, unknown>;
  const id = text(dto.Id);
  if (!id) return null;
  const headers = artHeaders(ctx.apiKey);
  const imageUrl = (kind: string, query: string) => `${ctx.base}/Items/${encodeURIComponent(id)}/Images/${kind}?${query}`;

  const tags = (dto.ImageTags ?? {}) as Record<string, unknown>;
  const backdrops = strings(dto.BackdropImageTags);
  const people = list(dto.People);
  const versions = list(dto.MediaSources)
    .map((s, i) => parseVersion(s, `Fassung ${i + 1}`))
    .filter((v): v is MovieVersion => v !== null);

  const info: MovieInfo = {
    id,
    name: text(dto.Name),
    overview: text(dto.Overview),
    genres: strings(dto.Genres),
    directors: people
      .filter((p) => text(p.Type) === "Director")
      .map((p) => text(p.Name))
      .filter(Boolean),
    cast: people
      .filter((p) => text(p.Type) === "Actor")
      .map((p) => text(p.Name))
      .filter(Boolean)
      .slice(0, 6),
    studios: list(dto.Studios)
      .map((s) => text(s.Name))
      .filter(Boolean),
    versions,
  };
  const tagline = strings(dto.Taglines)[0];
  if (tagline) info.tagline = tagline;
  const year = finite(dto.ProductionYear);
  if (year !== undefined && year > 0) info.year = year;
  const run = finite(dto.RunTimeTicks);
  if (run !== undefined && run > 0) info.runTimeTicks = run;
  const rating = text(dto.OfficialRating);
  if (rating) info.officialRating = rating;
  const community = finite(dto.CommunityRating);
  if (community !== undefined && community > 0) info.communityRating = community;
  if (text(tags.Logo)) info.logo = { kind: "http", url: imageUrl("Logo", "maxWidth=900&quality=90"), headers };
  if (backdrops.length) info.backdrop = { kind: "http", url: imageUrl("Backdrop", "maxWidth=1920&quality=85"), headers };
  return info;
}

/**
 * Details eines Films (`GET /Items/{id}?userId=…`, bei Servern bis 10.8 `/Users/{userId}/Items/{id}`): Logo,
 * Hintergrundbild, Besetzung und die Ton-/Untertitelspuren jeder Fassung.
 */
export async function getMovieInfo(ctx: JfContext, id: string, opts: { signal?: AbortSignal } = {}): Promise<MovieInfo> {
  const { signal } = opts;
  let res = await jfRaw(ctx, `/Items/${encodeURIComponent(id)}`, { signal, query: { userId: ctx.userId } });
  if (res.status === 404 || res.status === 405) {
    const legacy = await jfRaw(ctx, `/Users/${encodeURIComponent(ctx.userId)}/Items/${encodeURIComponent(id)}`, { signal });
    if (legacy.ok) res = legacy;
  }
  if (!res.ok) throw statusError(res.status, { 404: "Film auf dem Server nicht gefunden" });
  let info: MovieInfo | null;
  try {
    info = parseMovieInfo(JSON.parse(res.text), ctx);
  } catch {
    throw new JfError("Antwort des Servers ist kein gültiges JSON", "protocol");
  }
  if (!info) throw new JfError("Unerwartete Antwort des Servers", "protocol");
  return info;
}

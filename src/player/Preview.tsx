import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { PreviewSource } from "./previews";

/*
 * Das Bild in der Zeitleisten-Blase. Reine Anzeige per CSS-Hintergrund (Ausschnitt eines Kachelbilds oder ein
 * einzelnes Bild); Welches Bild, entscheidet die Quelle (frameAt). Das Kästchen hat von Anfang an seine endgültige
 * Größe, damit die Blase nicht springt, wenn das erste Bild eintrifft. Wer diese Komponente zeigt, rendert bei jedem
 * Hinweis der Quelle (subscribe) neu – das tut Osd.tsx.
 */

/** Größte Fläche des Bilds in rem. */
const MAX_W = 18;
const MAX_H = 10.2;

/** Größe des Bilds in rem: breit genug für 16:9, bei schmaleren Formaten begrenzt die Höhe. */
export function previewSize(aspect: number): { w: number; h: number } {
  const a = Math.min(3, Math.max(0.6, Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9));
  const w = Math.min(MAX_W, MAX_H * a);
  return { w, h: w / a };
}

export function PreviewPicture({ source, sec }: { source: PreviewSource; sec: number }) {
  useEffect(() => {
    source.want(sec);
  }, [source, sec]);
  useEffect(() => () => source.idle(), [source]);

  const frame = source.frameAt(sec);
  const { w, h } = previewSize(source.aspect);
  const box: CSSProperties = { width: `${w}rem`, height: `${h}rem` };
  const img: CSSProperties | undefined = frame
    ? {
        backgroundImage: `url("${frame.url}")`,
        backgroundSize: `${frame.cols * 100}% ${frame.rows * 100}%`,
        backgroundPosition: `${frame.cols > 1 ? (frame.col / (frame.cols - 1)) * 100 : 0}% ${frame.rows > 1 ? (frame.row / (frame.rows - 1)) * 100 : 0}%`,
      }
    : undefined;
  return (
    <span className={`player-preview${frame ? "" : " is-empty"}`} style={box} aria-hidden="true" data-testid="preview" data-kind={source.kind}>
      {img && <i className="player-preview__img" style={img} data-exact={frame?.exact ? "1" : "0"} data-frame={`${frame?.url}#${frame?.col},${frame?.row}`} />}
    </span>
  );
}

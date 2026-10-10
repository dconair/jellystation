/**
 * Kleine Aktionen des Emulator-Dialogs ohne Oberfläche: Webseite öffnen, App im Dateidialog wählen, prüfen,
 * ob eine gewählte App zum Emulator passt.
 */
import { isTauri } from "../platform";
import type { InspectResult } from "./backend";
import type { EmulatorDef } from "./catalog";

/** Letzter Teil eines Pfads ("/Applications/RPCS3.app/" → "RPCS3.app"). */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** Öffnet eine Webseite im Standardbrowser (in Tauri über das Shell-Plugin, sonst als neuer Tab). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Lässt den Nutzer ein Programm wählen. Unter macOS ist eine .app für den Dateidialog eine Datei (ein Paket), deshalb
 * der Datei- und nicht der Ordnerdialog mit Filter „app“ – ein reiner Ordnerdialog würde .app-Pakete ausgrauen.
 * Gibt den Pfad ohne abschließenden Slash zurück, bei Abbruch null.
 */
export async function pickAppBundle(defaultPath = "/Applications"): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: false,
    multiple: false,
    defaultPath,
    title: "Emulator-App wählen",
    filters: [{ name: "Programme", extensions: ["app"] }],
  });
  return typeof picked === "string" && picked !== "" ? picked.replace(/\/+$/, "") || "/" : null;
}

/**
 * Passt die gewählte App zum Emulator? Entweder der Name entspricht dem Suchmuster des Katalogs oder die
 * Bundle-ID ist bekannt. Nur ein Hinweis – umbenannte Apps sollen sich trotzdem wählen lassen (mit Rückfrage).
 */
export function looksLikeEmulator(def: EmulatorDef, path: string, info: Pick<InspectResult, "bundleId">): boolean {
  try {
    if (new RegExp(def.appPattern, "i").test(baseName(path))) return true;
  } catch {
    // Ungültiges Muster im Katalog: nicht an der Auswahl scheitern.
    return true;
  }
  const id = info.bundleId?.toLowerCase();
  return !!id && def.bundleIds.some((b) => b.toLowerCase() === id);
}

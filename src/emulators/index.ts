/*
 * Emulatoren: Katalog, Erkennung und Dialog.
 *
 *   catalog.ts          Welche Emulatoren es gibt (Systeme, Startargumente, Homebrew, Download-Seite)
 *   detect.ts           Suchen/Prüfen (gewählter Pfad, emulator_find, Homebrew) mit Zwischenspeicher
 *   useEmulators.ts     Hook um detect.ts: { statuses, loading, refresh, brew }
 *   status.ts           EmulatorStatus, Statustexte, summarizeEmulators()
 *   EmulatorsDialog.tsx Dialog „Emulatoren“ (Liste, Aktionen, Homebrew-Installation, Startprotokoll)
 *   brew.ts, actions.ts, backend.ts   Homebrew-Lauf, kleine Aktionen, Rust-Befehle
 */
export { EMULATORS, emulatorForSystem, getEmulator, isAppBundle, normalizeSystem, supportedFolderNames } from "./catalog";
export type { EmulatorDef, LaunchArgs } from "./catalog";
export { detectEmulators, detectOne } from "./detect";
export type { BrewInfo, DetectResult } from "./detect";
export { EmulatorsDialog } from "./EmulatorsDialog";
export type { EmulatorsDialogProps } from "./EmulatorsDialog";
export { describeStatus, summarizeEmulators } from "./status";
export type { EmulatorSource, EmulatorStatus } from "./status";
export { useEmulators } from "./useEmulators";
export type { EmulatorsState } from "./useEmulators";

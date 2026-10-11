/**
 * Regeln der Diagnose – rein und ohne React: Welche Dateiendungen ein Emulator öffnet, wo seine Protokolle liegen,
 * woran man typische Fehler in seiner Ausgabe erkennt und wie ein Prozessende zu deuten ist.
 *
 * Wichtig: Die Meldungen der Emulatoren ändern sich von Version zu Version. Die Muster unten sind deshalb bewusst
 * weit gefasst und die Texte vorsichtig formuliert („vermutlich“); ein Treffer ist ein Hinweis, kein Urteil.
 * Fehlt ein Muster oder ist eines zu weit, genügt es, hier die Liste anzupassen.
 */
import type { EmulatorDef } from "../emulators/catalog";
import type { FileProbe } from "./backend";
import type { DiagnoseContext, DiagnoseGame, Finding, FixAction } from "./types";

/* ------------------------------------------------------------------ Dateiendungen */

/** Endungen, die der Emulator laut Dokumentation direkt öffnet (klein geschrieben, ohne Punkt). */
export const GAME_EXTENSIONS: Record<string, readonly string[]> = {
  rpcs3: ["iso", "bin", "self", "elf", "sfb", "pkg"],
  duckstation: ["cue", "bin", "img", "iso", "chd", "pbp", "ecm", "mds", "exe", "psexe", "psf", "m3u"],
  pcsx2: ["iso", "bin", "img", "mdf", "nrg", "chd", "cso", "zso", "gz", "dump", "elf", "m3u"],
  ppsspp: ["iso", "cso", "zso", "pbp", "elf", "prx", "chd", "bin"],
  dolphin: ["iso", "gcm", "gcz", "ciso", "wbfs", "rvz", "wia", "tgc", "dol", "elf", "wad", "m3u"],
};

/** Archive öffnet kein Emulator: Sie müssen vorher entpackt werden. */
export const ARCHIVE_EXTENSIONS = ["zip", "7z", "rar", "tar", "gz", "xz", "bz2"] as const;

export const extOf = (path: string): string => {
  const m = /\.([^./\\]+)\/?$/.exec(path);
  return m ? m[1].toLowerCase() : "";
};

export const baseOf = (path: string): string => path.replace(/\/+$/, "").split(/[\\/]/).pop() ?? path;

/** Archiv-Kennung am Dateianfang (ZIP, 7-Zip, RAR). */
export const looksLikeArchive = (headHex: string): boolean =>
  headHex.startsWith("504b0304") || headHex.startsWith("377abcaf271c") || headHex.startsWith("526172211a07");

/* ------------------------------------------------------------------ Protokolle der Emulatoren */

/**
 * Wo ein Emulator sein eigenes Protokoll ablegt (macOS; das zuletzt geänderte gewinnt). Die Pfade stammen aus der
 * Dokumentation der Emulatoren und sind auf einem echten Mac noch nicht abgeglichen. Fehlt eine Datei, wird sie
 * übersprungen – die Diagnose arbeitet dann nur mit der Ausgabe des Prozesses.
 */
export const EMULATOR_LOGS: Record<string, readonly string[]> = {
  rpcs3: [
    "~/Library/Application Support/rpcs3/RPCS3.log",
    "~/Library/Application Support/rpcs3/log/RPCS3.log",
    "~/.config/rpcs3/RPCS3.log",
  ],
  duckstation: [
    "~/Library/Application Support/DuckStation/duckstation.log",
    "~/Library/Application Support/DuckStation/logs/duckstation.log",
    "~/Library/Application Support/DuckStation/log.txt",
  ],
  pcsx2: [
    "~/Library/Application Support/PCSX2/logs/emulog.txt",
    "~/Documents/PCSX2/logs/emulog.txt",
  ],
  ppsspp: [
    "~/Library/Application Support/PPSSPP/PSP/SYSTEM/ppsspplog.txt",
    "~/Library/Application Support/PPSSPP/ppsspp.log",
  ],
  dolphin: [
    "~/Library/Application Support/Dolphin/Logs/dolphin.log",
  ],
};

/* ------------------------------------------------------------------ Muster in der Ausgabe */

interface RuleContext {
  def: EmulatorDef | null;
  /** Pfad der Emulator-App, falls bekannt (für „Quarantäne aufheben“). */
  appPath: string | null;
}

interface OutputRule {
  id: string;
  test: RegExp;
  /** Nur für diese Emulatoren (IDs aus dem Katalog); ohne Angabe für alle. */
  emulators?: readonly string[];
  level: "error" | "warn";
  title: string;
  detail: (c: RuleContext) => string;
  fix?: (c: RuleContext) => FixAction | undefined;
}

const name = (c: RuleContext) => c.def?.name ?? "Der Emulator";

const openFiles = (label: string) => (c: RuleContext): FixAction | undefined =>
  c.def ? { fix: { kind: "open-files", emulatorId: c.def.id }, label, auto: false } : undefined;

export const OUTPUT_RULES: readonly OutputRule[] = [
  {
    id: "bios",
    test: /(no|missing|could ?n[o']t find|cannot find|can'?t find|not found|requires?|need)[^\n]{0,50}\bbios\b|\bbios\b[^\n]{0,50}(not found|missing|not set|could ?n[o']t|invalid|required|error|failed)/i,
    emulators: ["duckstation", "pcsx2"],
    level: "error",
    title: "BIOS fehlt oder wird nicht gefunden",
    detail: (c) =>
      `${name(c)} meldet, dass kein brauchbares BIOS da ist. Lege dein eigenes BIOS in den BIOS-Ordner der App und übernimm es dort in den Emulator (BIOS & Firmware).`,
    fix: openFiles("BIOS & Firmware"),
  },
  {
    id: "firmware",
    test: /firmware[^\n]{0,60}(not|missing|install|found)|(not|missing|no)[^\n]{0,40}firmware|liblv2|dev_flash[^\n]{0,60}(not|missing|empty|fail)/i,
    emulators: ["rpcs3"],
    level: "error",
    title: "PS3-Firmware nicht installiert",
    detail: () =>
      "RPCS3 braucht einmalig die offizielle PS3-Firmware (PS3UPDAT.PUP von Sony). Spiele starten erst, wenn sie in RPCS3 eingespielt ist: Datei → Firmware installieren.",
    fix: openFiles("BIOS & Firmware"),
  },
  {
    id: "license",
    test: /\.(rap|rif|edat)\b|\brap file\b|npdrm[^\n]{0,40}(fail|missing|not)|license[^\n]{0,40}(missing|not found)/i,
    emulators: ["rpcs3"],
    level: "error",
    title: "Lizenzdatei (RAP/RIF) fehlt",
    detail: () =>
      "Dieses digitale PS3-Spiel braucht eine Lizenzdatei (.rap bzw. .rif), die zu deinem Konto gehört. Lege sie in RPCS3 im Ordner „dev_hdd0/home/00000001/exdata“ ab, die App legt sie nicht an.",
  },
  {
    id: "bad-image",
    test: /(unsupported|unknown|invalid|unrecogni[sz]ed|not a valid|corrupt|bad|malformed)[^\n]{0,40}(format|file|image|iso|disc|header|game)|could not recogni[sz]e file|failed to (read|parse|mount)[^\n]{0,30}(iso|image|disc)/i,
    level: "error",
    title: "Spieldatei wird nicht erkannt oder ist beschädigt",
    detail: (c) =>
      `${name(c)} kann die Datei nicht als Spiel lesen. Meist ist der Download unvollständig, das Abbild beschädigt oder das Format passt nicht. Lade das Abbild neu oder wandle es in ein Format um, das ${c.def ? c.def.name : "der Emulator"} kennt.`,
  },
  {
    id: "cannot-open",
    test: /(failed|unable|cannot|can'?t|could ?n[o']t|error)[^\n]{0,15}\bopen(ing)?\b|no such file or directory|file (was )?not found|does not exist/i,
    level: "error",
    title: "Datei lässt sich nicht öffnen",
    detail: () =>
      "Der Emulator findet eine benötigte Datei nicht oder darf sie nicht lesen. Prüfe, ob das Spiel noch am selben Ort liegt (verschoben, umbenannt, externe Festplatte getrennt?) und ob der Name keine ungewöhnlichen Zeichen enthält.",
  },
  {
    id: "permission",
    test: /permission denied|operation not permitted|access (is )?denied|not permitted/i,
    level: "error",
    title: "Zugriff verweigert",
    detail: (c) =>
      `macOS erlaubt ${name(c)} den Zugriff auf eine Datei oder einen Ordner nicht. Öffne Systemeinstellungen → Datenschutz & Sicherheit → Dateien und Ordner (oder Festplattenvollzugriff) und erlaube ${name(c)} den Ordner, in dem das Spiel liegt.`,
  },
  {
    id: "quarantine",
    test: /is damaged|can'?t be opened because|code signature|cannot be verified|not verified|gatekeeper|quarantine/i,
    level: "error",
    title: "macOS blockiert den Emulator (Sicherheitsprüfung)",
    detail: (c) =>
      `Die Sicherheitsprüfung von macOS hält ${name(c)} an, weil die App aus dem Internet stammt und nicht signiert ist. Mit einem Klick hebt JellyStation diese Markierung auf.`,
    fix: (c) => (c.appPath ? { fix: { kind: "clear-quarantine", path: c.appPath }, label: "Quarantäne aufheben", auto: true } : undefined),
  },
  {
    id: "arch",
    test: /bad cpu type|incompatible architecture|wrong architecture|cpu type in executable/i,
    level: "error",
    title: "Falsche Prozessor-Version des Emulators",
    detail: () =>
      "Die installierte Version passt nicht zum Prozessor dieses Macs (Intel- statt Apple-Silicon-Version oder umgekehrt). Lade die passende Version von der Webseite des Emulators.",
  },
  {
    id: "dyld",
    test: /dyld[^\n]{0,60}(library not loaded|symbol not found)|library not loaded|image not found/i,
    level: "error",
    title: "Dem Emulator fehlt eine Programmbibliothek",
    detail: (c) =>
      `${name(c)} ist unvollständig installiert oder passt nicht zu diesem macOS. Installiere ihn neu bzw. lade die aktuelle Version.`,
    fix: (c) => (c.def ? { fix: { kind: "open-emulators", emulatorId: c.def.id }, label: "Emulatoren öffnen", auto: false } : undefined),
  },
  {
    id: "memory",
    test: /out of memory|bad_alloc|cannot allocate memory|failed to allocate/i,
    level: "error",
    title: "Zu wenig Arbeitsspeicher",
    detail: () =>
      "Dem Emulator ist der Arbeitsspeicher ausgegangen. Schließe andere große Programme und starte neu; bei PS3-Spielen helfen niedrigere Auflösung und weniger Zusatzoptionen in RPCS3.",
  },
  {
    id: "disk-full",
    test: /no space left on device|disk (is )?full/i,
    level: "error",
    title: "Datenträger voll",
    detail: () => "Auf dem Datenträger ist kein Platz mehr frei (der Emulator schreibt z. B. Shader-Zwischenspeicher). Schaffe Platz und starte neu.",
  },
  {
    id: "already-running",
    test: /another instance|already running|single[- ]instance/i,
    level: "warn",
    title: "Der Emulator läuft vielleicht schon im Hintergrund",
    detail: (c) => `Eine zweite Instanz von ${name(c)} startet nicht. Beende den Emulator im Dock bzw. mit ⌘Q und versuche es erneut.`,
  },
  {
    id: "graphics",
    test: /(vulkan|moltenvk|metal|opengl|gpu|graphics|renderer|shader|swapchain)[^\n]{0,60}(fail|error|unable|cannot|not supported|unsupported|lost|crash)|(fail|error|unable|cannot)[^\n]{0,60}(vulkan|moltenvk|metal|opengl|gpu|renderer|swapchain)/i,
    level: "warn",
    title: "Problem mit der Grafik",
    detail: (c) =>
      `${name(c)} meldet einen Fehler bei der Grafikausgabe. Stelle in den Einstellungen des Emulators einen anderen Renderer ein (Metal, Vulkan oder OpenGL) und aktualisiere ihn, falls eine neuere Version vorliegt.`,
  },
];

/** Alle Regeln, die auf die Zeilen passen: pro Regel höchstens ein Befund mit den ersten Trefferzeilen als Auszug. */
export function analyzeOutput(lines: readonly string[], ctx: RuleContext, idPrefix: string): Finding[] {
  const out: Finding[] = [];
  for (const rule of OUTPUT_RULES) {
    if (rule.emulators && (!ctx.def || !rule.emulators.includes(ctx.def.id))) continue;
    const hits = lines.filter((l) => rule.test.test(l));
    if (hits.length === 0) continue;
    out.push({
      id: `${idPrefix}-${rule.id}`,
      level: rule.level,
      title: rule.title,
      detail: rule.detail(ctx),
      emulatorId: ctx.def?.id,
      fix: rule.fix?.(ctx),
      extra: ["Aus der Ausgabe:", ...hits.slice(0, 3)],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ Prozessende */

/** Kleine Signalnamen für Shell-Codes über 128 (z. B. 139 = 128 + 11). */
const SIGNALS: Record<number, string> = { 4: "SIGILL", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 11: "SIGSEGV", 15: "SIGTERM" };

export const QUICK_MS = 4000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} s`;

/** Deutet Exit-Code und Dauer. Gibt nur Befunde zurück, die der Code allein hergibt; Ursachen aus der Ausgabe kommen separat. */
export function explainExit(ctx: DiagnoseContext, def: EmulatorDef | null): Finding[] {
  const who = def?.name ?? "Das Programm";
  const exit = ctx.exit;
  const emulatorId = def?.id;
  if (ctx.launchError) {
    return [
      {
        id: "exit-launch",
        level: "error",
        title: "Der Start wurde abgelehnt",
        detail: `„${ctx.title}“ ließ sich nicht starten: ${ctx.launchError}`,
        emulatorId,
        fix: def ? { fix: { kind: "open-emulators", emulatorId: def.id }, label: "Emulatoren öffnen", auto: false } : undefined,
        extra: ctx.commandLine ? ["Befehl:", ctx.commandLine] : undefined,
      },
    ];
  }
  if (!exit) return [];
  const extra: string[] = [];
  if (ctx.commandLine) extra.push("Befehl:", ctx.commandLine);
  const fromShell = exit.code !== null && exit.code > 128 ? SIGNALS[exit.code - 128] : undefined;
  const signal = exit.signal ?? fromShell ?? null;
  const how = signal ? `durch das Signal ${signal}` : exit.code === null ? "ohne Exit-Code" : `mit Code ${exit.code}`;
  const quick = exit.durationMs < QUICK_MS;
  const base = quick ? `${who} hat „${ctx.title}“ schon nach ${seconds(exit.durationMs)} ${how} beendet.` : `${who} lief ${seconds(exit.durationMs)} und endete dann ${how}.`;

  let detail = base;
  if (exit.hint) detail += ` ${exit.hint}`;
  else if (exit.code === 126) detail += " Der Emulator ist nicht ausführbar – prüfe die Rechte oder wähle die App neu aus.";
  else if (exit.code === 127) detail += " Das Programm wurde nicht gefunden – vielleicht wurde die App verschoben oder gelöscht.";
  else if (exit.code === 0 && !signal && quick) {
    detail += " Das passiert oft, wenn die Spieldatei nicht geöffnet werden konnte. Die Prüfung unten zeigt, ob etwas an der Datei oder am Emulator auffällt.";
  } else if (signal && ["SIGSEGV", "SIGBUS", "SIGABRT", "SIGILL", "SIGTRAP", "SIGFPE"].includes(signal)) {
    detail += " Das ist ein Absturz des Emulators. Häufige Gründe: fehlende Firmware/BIOS, ein beschädigtes Abbild oder die Grafikeinstellungen.";
  } else if (exit.code !== null && exit.code !== 0) {
    detail += " Der Code allein nennt die Ursache nicht; die Ausgabe des Emulators steht darunter.";
  }
  const out = [...exit.stderrTail];
  if (out.length === 0) out.push(...exit.stdoutTail);
  if (out.length > 0) extra.push("", "Letzte Ausgabe des Emulators:", ...out.slice(-12));
  return [
    {
      id: "exit",
      level: "error",
      title: quick ? "Das Spiel wurde sofort beendet" : "Das Spiel wurde unerwartet beendet",
      detail,
      emulatorId,
      extra: extra.length ? extra : undefined,
    },
  ];
}

/* ------------------------------------------------------------------ Spieldateien */

export type GameIssueCode = "missing" | "unreadable" | "empty" | "cue-refs" | "archive" | "odd-ext" | "folder-shape";

export interface GameIssue {
  code: GameIssueCode;
  /** Zusatz zum Text, z. B. die fehlenden Dateien. */
  note?: string;
}

/** Was an einer Spieldatei auffällt (leer = alles in Ordnung). `def` darf fehlen (nicht zugeordnetes Spiel). */
export function gameIssues(path: string, def: EmulatorDef | null, p: FileProbe): GameIssue[] {
  if (!p.exists) return [{ code: "missing" }];
  if (!p.readable) return [{ code: "unreadable", note: p.error ?? undefined }];
  const out: GameIssue[] = [];
  const ext = extOf(path);
  if (p.isFile) {
    if (p.size === 0) out.push({ code: "empty" });
    const missingRefs = p.refs.filter((r) => !r.exists).map((r) => r.name);
    if (missingRefs.length > 0) out.push({ code: "cue-refs", note: missingRefs.slice(0, 5).join(", ") + (missingRefs.length > 5 ? " …" : "") });
    const supported = def ? GAME_EXTENSIONS[def.id] : undefined;
    const isArchive = (ARCHIVE_EXTENSIONS as readonly string[]).includes(ext) || (!!supported && !supported.includes(ext) && looksLikeArchive(p.headHex));
    if (isArchive) out.push({ code: "archive" });
    else if (supported && ext && !supported.includes(ext)) out.push({ code: "odd-ext", note: `.${ext}` });
  } else if (p.isDir && def) {
    const names = new Set(p.names.map((n) => n.toLowerCase()));
    if (def.id === "rpcs3" && !names.has("ps3_game") && !names.has("usrdir") && !names.has("param.sfo")) out.push({ code: "folder-shape" });
    if (def.id === "ppsspp" && !names.has("psp_game") && !names.has("eboot.pbp")) out.push({ code: "folder-shape" });
  }
  return out;
}

interface IssueText {
  level: "error" | "warn";
  one: string;
  many: string;
  detail: (def: EmulatorDef | null, note?: string) => string;
}

const ISSUE_TEXT: Record<GameIssueCode, IssueText> = {
  missing: {
    level: "error",
    one: "Spieldatei nicht gefunden",
    many: "Spieldateien nicht gefunden",
    detail: () =>
      "Die Datei oder der Ordner liegt nicht mehr dort, wo die Bibliothek ihn gespeichert hat. Wurde das Spiel verschoben oder umbenannt, oder ist die externe Festplatte nicht angeschlossen? Lies die Bibliothek danach neu ein (Einstellungen → Spiele-Ordner).",
  },
  unreadable: {
    level: "error",
    one: "Spieldatei nicht lesbar",
    many: "Spieldateien nicht lesbar",
    detail: (_d, note) =>
      `Die Datei existiert, lässt sich aber nicht lesen${note ? ` (${note})` : ""}. Prüfe die Zugriffsrechte (Finder → Informationen) bzw. Systemeinstellungen → Datenschutz & Sicherheit → Dateien und Ordner.`,
  },
  empty: {
    level: "error",
    one: "Spieldatei ist leer (0 Byte)",
    many: "Spieldateien sind leer (0 Byte)",
    detail: () => "Die Datei enthält keine Daten – vermutlich wurde der Download oder das Kopieren abgebrochen. Lade oder kopiere sie erneut.",
  },
  "cue-refs": {
    level: "error",
    one: "Zum Abbild fehlen Dateien",
    many: "Zu Abbildern fehlen Dateien",
    detail: (_d, note) =>
      `Die .cue-/.m3u-Liste verweist auf Dateien, die nicht daneben liegen${note ? `: ${note}` : ""}. Lege alle Teile (z. B. die .bin-Spuren oder Discs) mit den genauen Namen in denselben Ordner.`,
  },
  archive: {
    level: "error",
    one: "Spiel liegt noch gepackt vor",
    many: "Spiele liegen noch gepackt vor",
    detail: (def) =>
      `Das Spiel steckt in einem Archiv (zip, 7z, rar …). ${def ? def.name : "Kein Emulator"} öffnet so etwas nicht. Entpacke es und lege das Spielabbild in den Spiele-Ordner – JellyStation entpackt nichts selbst.`,
  },
  "odd-ext": {
    level: "warn",
    one: "Ungewöhnliche Dateiendung",
    many: "Ungewöhnliche Dateiendungen",
    detail: (def, note) =>
      `${def ? def.name : "Der Emulator"} kennt die Endung ${note ?? ""} laut Dokumentation nicht. Starten Spiele damit nicht, wandle sie in ein unterstütztes Format um (z. B. ISO oder CHD) oder prüfe, ob das Spiel dem richtigen System zugeordnet ist.`,
  },
  "folder-shape": {
    level: "warn",
    one: "Spieleordner sieht unvollständig aus",
    many: "Spieleordner sehen unvollständig aus",
    detail: (def) =>
      def?.id === "ppsspp"
        ? "Im Ordner fehlen PSP_GAME bzw. EBOOT.PBP. Entpackte PSP-Spiele brauchen genau diese Struktur."
        : "Im Ordner fehlen PS3_GAME bzw. USRDIR. Ein entpacktes PS3-Spiel braucht genau diese Struktur; lege die Dateien ohne zusätzlichen Zwischenordner ab.",
  },
};

/** Befund zu einem einzelnen Spiel (der Anlass der Diagnose). */
export function findingForGame(game: DiagnoseGame, def: EmulatorDef | null, issue: GameIssue): Finding {
  const t = ISSUE_TEXT[issue.code];
  return {
    id: `game-${issue.code}`,
    level: t.level,
    title: `${t.one}: ${game.title}`,
    detail: t.detail(def, issue.note),
    emulatorId: def?.id,
    extra: ["Pfad:", game.path],
  };
}

/** Sammelbefund über viele Spiele mit demselben Problem. */
export function findingForGames(code: GameIssueCode, items: readonly { game: DiagnoseGame; def: EmulatorDef | null; note?: string }[]): Finding {
  const t = ISSUE_TEXT[code];
  const first = items[0];
  const shown = items.slice(0, 8).map((i) => `${i.game.title}${i.note ? ` – ${i.note}` : ""}`);
  if (items.length > shown.length) shown.push(`… und ${items.length - shown.length} weitere`);
  return {
    id: `games-${code}`,
    level: t.level,
    title: items.length === 1 ? `${t.one}: ${first.game.title}` : `${items.length} ${t.many}`,
    detail: t.detail(items.length === 1 ? first.def : null, items.length === 1 ? first.note : undefined),
    extra: shown,
  };
}

/* ------------------------------------------------------------------ BIOS-Dateien */

const ZEROS = /^(00)+$/;
const ONES = /^(ff)+$/;

/**
 * Prüft den Anfang einer BIOS-/Firmware-Datei: Eine PS3-Update-Datei beginnt mit „SCEUF“, ein BIOS besteht nicht nur
 * aus Nullen oder Einsen. Liefert einen Text, wenn die Datei offensichtlich nicht taugt, sonst null. (Eine Prüfung
 * gegen bekannte Hashwerte gibt es nicht: JellyStation bringt keine Listen von BIOS-Dateien mit.)
 */
export function biosHeadProblem(fileName: string, headHex: string, size: number): string | null {
  if (size === 0) return "Die Datei ist leer (0 Byte).";
  if (/\.pup$/i.test(fileName)) {
    return headHex.startsWith("5343455546") ? null : "Die Datei beginnt nicht mit der Kennung einer PS3-Update-Datei („SCEUF“) – vermutlich beschädigt oder keine PS3UPDAT.PUP.";
  }
  if (headHex.length >= 16 && (ZEROS.test(headHex) || ONES.test(headHex))) return "Die Datei enthält am Anfang nur gleichförmige Daten – vermutlich ein fehlerhaftes Abbild.";
  return null;
}

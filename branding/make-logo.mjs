// Erzeugt das JellyStation-Logo als SVG: glänzende 3D-Qualle mit PlayStation-Symbolen in Teal und Orange.
//   node branding/make-logo.mjs tile > branding/icon.svg             (App-Icon mit Kachel; auch nach public/icon.svg kopieren)
//   node branding/make-logo.mjs bare > public/branding/jellyfish.svg (ohne Kachel, für die Start-Animation)
// PNG daraus: node branding/render.mjs branding/icon.svg branding/icon-1024.png 1024
// App-Icons: npx tauri icon branding/icon-1024.png -o <Ordner> und die Dateien nach src-tauri/icons kopieren.
const mode = process.argv[2] ?? "tile"; // tile | bare

const DOME = "M-216 8 C-228 -152 -122 -252 0 -252 C132 -252 228 -152 216 8 C212 62 168 88 0 88 C-168 88 -212 62 -216 8 Z";
const RIM = "M-172 66 C-122 100 -60 108 0 108 C60 108 122 100 172 66 C178 104 142 132 92 142 C40 150 -40 150 -92 142 C-142 132 -178 104 -172 66 Z";
const TENT = [
  "M-108 134 C-118 200 -168 250 -176 326 C-180 366 -198 394 -210 430",
  "M-44 146 C-52 212 -92 270 -112 340 C-122 372 -118 400 -130 420",
  "M40 148 C46 212 24 280 34 346 C38 380 22 410 30 442",
  "M110 136 C122 200 166 236 150 310 C142 350 164 380 152 412",
];
// vier PlayStation-Symbole als Raute wie an den Controller-Tasten
const SYM = `
  <path d="M-27 -156 L0 -202 L27 -156 Z" transform="translate(0 26)"/>
  <circle cx="90" cy="-80" r="25"/>
  <path d="M-22 -14 l44 44 M22 -14 l-44 44" transform="translate(0 -8)"/>
  <rect x="-113" y="-103" width="46" height="46" rx="4"/>`;
const symG = (extra = "") => `<g fill="none" stroke-linecap="round" stroke-linejoin="round" ${extra}>${SYM}</g>`;
const tents = TENT.map((d) => `<path d="${d}"/>`).join("");

const C = { teal: "#19e6d2", tealHi: "#3ff2e0", core: "#e3fffb", or: "#ff8a1f", orHi: "#ffb347", orCore: "#fff1d6" };

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#0b3a52"/><stop offset="0.5" stop-color="#06213a"/><stop offset="1" stop-color="#020a18"/></linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.4" r="0.5"><stop offset="0" stop-color="#19e6d2" stop-opacity="0.32"/><stop offset="0.6" stop-color="#19e6d2" stop-opacity="0.07"/><stop offset="1" stop-color="#19e6d2" stop-opacity="0"/></radialGradient>
    <linearGradient id="wave1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#27f0da" stop-opacity="0.26"/><stop offset="1" stop-color="#0a5a6a" stop-opacity="0.03"/></linearGradient>
    <linearGradient id="wave2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a3d" stop-opacity="0.16"/><stop offset="1" stop-color="#0a3a6a" stop-opacity="0.02"/></linearGradient>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <clipPath id="domeClip"><path d="${DOME}"/></clipPath>

    <!-- Kuppel als Kugel: Licht von links oben, dunkler Kern unten rechts -->
    <radialGradient id="body" cx="0.36" cy="0.3" r="0.82">
      <stop offset="0" stop-color="#9ffcf2"/>
      <stop offset="0.3" stop-color="#2fe8d8"/>
      <stop offset="0.66" stop-color="#14b8bf"/>
      <stop offset="1" stop-color="#0a8aa6"/>
    </radialGradient>
    <!-- Randwulst: oben im Schatten der Kuppel, unten vom Licht erfasst -->
    <linearGradient id="skirt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f8fa8"/>
      <stop offset="0.55" stop-color="#25d3d0"/>
      <stop offset="1" stop-color="#7ff8ea"/>
    </linearGradient>
    <linearGradient id="tent" gradientUnits="userSpaceOnUse" x1="0" y1="140" x2="0" y2="440">
      <stop offset="0" stop-color="#2cf0dc"/><stop offset="0.55" stop-color="#7ad9c0"/><stop offset="1" stop-color="${C.orHi}"/>
    </linearGradient>
    <linearGradient id="tentShade" gradientUnits="userSpaceOnUse" x1="0" y1="140" x2="0" y2="440">
      <stop offset="0" stop-color="#0f9fb0"/><stop offset="0.6" stop-color="#3da593"/><stop offset="1" stop-color="#e8801a"/>
    </linearGradient>
    <radialGradient id="floor" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <filter id="glowBig" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="17"/></filter>
    <filter id="glowSmall" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="blur14" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>`;

// Neon-Schichten: Schein außen, Farbe, heller Kern
const neon = (inner, col, hi, core, w, glow = 1) => `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="${col}" stroke-width="${w * 2.4}" opacity="${0.8 * glow}" filter="url(#glowBig)">${inner}</g>
      <g stroke="${hi}" stroke-width="${w * 1.2}" filter="url(#glowSmall)">${inner}</g>
      <g stroke="${hi}" stroke-width="${w}">${inner}</g>
      <g stroke="${core}" stroke-width="${w * 0.36}">${inner}</g>
    </g>`;

const jelly = `
    <!-- Tentakel als runde Röhren: orangener Schein, dunkle Unterseite, Farbverlauf, helle Lichtkante -->
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="${C.or}" stroke-width="72" opacity="0.42" filter="url(#glowBig)">${tents}</g>
      <g stroke="url(#tentShade)" stroke-width="38">${tents}</g>
      <g stroke="url(#tent)" stroke-width="32" transform="translate(-2 0)">${tents}</g>
      <g stroke="#ffffff" stroke-opacity="0.6" stroke-width="7" transform="translate(-9 -2)">${tents}</g>
    </g>
    <!-- Randwulst unter der Kuppel -->
    <path d="${RIM}" fill="url(#skirt)"/>
    <path d="M-160 84 C-110 116 -56 126 0 126 C56 126 110 116 160 84" fill="none" stroke="#e3fffb" stroke-opacity="0.55" stroke-width="5" stroke-linecap="round" filter="url(#soft)"/>
    <path d="${RIM}" fill="none" stroke="${C.tealHi}" stroke-width="4" stroke-opacity="0.75"/>
    <!-- Kuppel -->
    <path d="${DOME}" fill="url(#body)"/>
    <g clip-path="url(#domeClip)">
      <!-- Tiefe: dunkler Kern unten rechts, Streulicht im Glas, Lichtkante am Rand -->
      <ellipse cx="86" cy="52" rx="190" ry="120" fill="#0a6a8a" opacity="0.32" filter="url(#blur14)"/>
      <ellipse cx="-20" cy="70" rx="150" ry="26" fill="#9ffcf0" opacity="0.4" filter="url(#blur6)"/>
      <path d="${DOME}" fill="none" stroke="#9ffcf0" stroke-width="30" opacity="0.5" filter="url(#blur6)"/>
      <path d="M-216 8 C-212 62 -168 88 0 88 C168 88 212 62 216 8" fill="none" stroke="#c9fff8" stroke-width="12" opacity="0.7" filter="url(#blur6)"/>
      <!-- großer weicher Glanz links oben -->
      <ellipse cx="-96" cy="-150" rx="96" ry="52" fill="#fff" opacity="0.5" filter="url(#blur14)" transform="rotate(-24 -96 -150)"/>
    </g>
    ${neon(`<path d="${DOME}"/>`, C.teal, C.tealHi, C.core, 8, 0.8)}
    <!-- scharfe Glanzlichter -->
    <path d="M-176 -74 C-170 -148 -112 -204 -46 -220" fill="none" stroke="#fff" stroke-opacity="0.9" stroke-width="13" stroke-linecap="round" filter="url(#soft)"/>
    <circle cx="-96" cy="-142" r="14" fill="#fff" filter="url(#soft)"/>
    <circle cx="-72" cy="-176" r="5" fill="#fff" opacity="0.8"/>
    <!-- Symbole: eingraviert (Schatten) und orange leuchtend -->
    <g transform="translate(4 6)" opacity="0.5" stroke="#04384f" stroke-width="13" filter="url(#soft)">${symG()}</g>
    ${neon(symG(), C.or, C.orHi, C.orCore, 12)}
  `;

// Neigung wie im Referenzbild: Kuppel kippt nach rechts oben, die Tentakel ziehen nach links unten
const tilt = 16;
let svg;
if (mode === "tile") {
  svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>JellyStation – Neon-Qualle mit PlayStation-Symbolen in Teal und Orange</title>${defs}
  <g clip-path="url(#tile)">
    <rect x="100" y="100" width="824" height="824" fill="url(#bg)"/>
    <rect x="100" y="100" width="824" height="824" fill="url(#halo)"/>
    <path d="M60 640 C220 560 360 720 540 640 S820 560 990 660 L990 980 L60 980 Z" fill="url(#wave2)"/>
    <path d="M60 740 C240 670 380 810 560 740 S830 680 990 760 L990 980 L60 980 Z" fill="url(#wave1)"/>
    <g fill="none" stroke-linecap="round">
      <path d="M60 640 C220 560 360 720 540 640 S820 560 990 660" stroke="#ffb066" stroke-opacity="0.4" stroke-width="3" filter="url(#soft)"/>
      <path d="M60 740 C240 670 380 810 560 740 S830 680 990 760" stroke="#6ff5e6" stroke-opacity="0.45" stroke-width="3" filter="url(#soft)"/>
    </g>
    <rect x="100" y="100" width="824" height="824" fill="none" stroke="#9fefff" stroke-opacity="0.18" stroke-width="3" rx="185"/>
  </g>
  <g transform="translate(560 410) rotate(${tilt}) scale(0.9)">${jelly}</g>
</svg>
`;
} else {
  svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-400 -300 800 800" width="800" height="800">
  <title>JellyStation – Qualle mit PlayStation-Symbolen (ohne Kachel), für die Start-Animation</title>${defs}
  <g transform="translate(30 0) rotate(${tilt})">${jelly}</g>
</svg>
`;
}
process.stdout.write(svg);

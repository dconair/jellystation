// Erzeugt das JellyStation-Logo als SVG (Entwurf 1: Glas-Qualle; "2" = reine Neon-Röhre).
//   node branding/make-logo.mjs 1 tile > branding/icon.svg            (App-Icon mit Kachel; auch nach public/icon.svg kopieren)
//   node branding/make-logo.mjs 1 bare > public/branding/jellyfish.svg (ohne Kachel, für die Start-Animation)
// PNG daraus: node branding/render.mjs branding/icon.svg branding/icon-1024.png 1024
// App-Icons: npx tauri icon branding/icon-1024.png -o <Ordner> und die Dateien nach src-tauri/icons kopieren.
import fs from "node:fs";
const variant = process.argv[2], mode = process.argv[3]; // Entwurf 1|2, Modus tile|bare

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
  <path d="M-27 -128 L0 -174 L27 -128 Z"/>
  <circle cx="74" cy="-84" r="27"/>
  <path d="M-24 -44 l48 48 M24 -44 l-48 48"/>
  <rect x="-102" y="-112" width="54" height="54" rx="4"/>`;
// Symbole sitzen leicht höher/mittiger: Korrektur über Transform
const symG = (extra="") => `<g fill="none" stroke-linecap="round" stroke-linejoin="round" ${extra}>${SYM}</g>`;

const C = variant === "1"
  ? { teal:"#19e6d2", tealHi:"#3ff2e0", core:"#e3fffb", or:"#ff8a1f", orHi:"#ffb347", orCore:"#fff1d6" }
  : { teal:"#19e6d2", tealHi:"#3ff2e0", core:"#e3fffb", or:"#ff7a12", orHi:"#ffa63d", orCore:"#fff1d6" };

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#0b3a52"/><stop offset="0.5" stop-color="#06213a"/><stop offset="1" stop-color="#020a18"/></linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.4" r="0.5"><stop offset="0" stop-color="#19e6d2" stop-opacity="0.32"/><stop offset="0.6" stop-color="#19e6d2" stop-opacity="0.07"/><stop offset="1" stop-color="#19e6d2" stop-opacity="0"/></radialGradient>
    <linearGradient id="wave1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#27f0da" stop-opacity="0.26"/><stop offset="1" stop-color="#0a5a6a" stop-opacity="0.03"/></linearGradient>
    <linearGradient id="wave2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a3d" stop-opacity="0.16"/><stop offset="1" stop-color="#0a3a6a" stop-opacity="0.02"/></linearGradient>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
    <radialGradient id="glass" cx="0.36" cy="0.28" r="0.85">
      <stop offset="0" stop-color="#9ffcf2" stop-opacity="0.85"/>
      <stop offset="0.45" stop-color="#19e6d2" stop-opacity="0.50"/>
      <stop offset="1" stop-color="#0a7f9a" stop-opacity="0.62"/>
    </radialGradient>
    <linearGradient id="glassRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#19e6d2" stop-opacity="0.55"/><stop offset="1" stop-color="#0a7f9a" stop-opacity="0.30"/></linearGradient>
    <linearGradient id="fillSoft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#19e6d2" stop-opacity="0.34"/><stop offset="1" stop-color="#19e6d2" stop-opacity="0.08"/></linearGradient>
    <linearGradient id="tent" gradientUnits="userSpaceOnUse" x1="0" y1="140" x2="0" y2="400"><stop offset="0" stop-color="#2cf0dc"/><stop offset="0.55" stop-color="#7ad9c0"/><stop offset="1" stop-color="${C.orHi}"/></linearGradient>
    <filter id="glowBig" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="17"/></filter>
    <filter id="glowSmall" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="blur6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <clipPath id="domeClip"><path d="${DOME}"/></clipPath>
  </defs>`;

// Neon-Schichten: Schein außen, Farbe, heller Kern
const neon = (inner, col, hi, core, w, glow = 1) => `
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="${col}" stroke-width="${w*2.4}" opacity="${0.8*glow}" filter="url(#glowBig)">${inner}</g>
      <g stroke="${hi}" stroke-width="${w*1.2}" filter="url(#glowSmall)">${inner}</g>
      <g stroke="${hi}" stroke-width="${w}">${inner}</g>
      <g stroke="${core}" stroke-width="${w*0.36}">${inner}</g>
    </g>`;

let jelly;
if (variant === "1") {
  // Glas-Qualle wie im Referenzbild: glänzende Kuppel, orange Neon-Symbole, Tentakel von Teal nach Orange
  jelly = `
    <!-- Tentakel -->
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="${C.or}" stroke-width="72" opacity="0.38" filter="url(#glowBig)">${TENT.map(d=>`<path d="${d}"/>`).join("")}</g>
      <g stroke="url(#tent)" stroke-width="36">${TENT.map(d=>`<path d="${d}"/>`).join("")}</g>
      <g stroke="#e3fffb" stroke-opacity="0.55" stroke-width="8" transform="translate(-7 0)">${TENT.map(d=>`<path d="${d}"/>`).join("")}</g>
    </g>
    <!-- Randwulst und Kuppel -->
    <path d="${RIM}" fill="url(#glassRim)"/>
    <path d="${RIM}" fill="none" stroke="${C.tealHi}" stroke-width="4" stroke-opacity="0.8"/>
    <path d="${DOME}" fill="url(#glass)"/>
    <g clip-path="url(#domeClip)">
      <ellipse cx="40" cy="60" rx="210" ry="90" fill="#0a6a8a" opacity="0.28" filter="url(#blur6)"/>
    </g>
    ${neon(`<path d="${DOME}"/>`, C.teal, C.tealHi, C.core, 11, 0.9)}
    <!-- Glanz -->
    <path d="M-174 -70 C-168 -150 -112 -204 -44 -218" fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="12" stroke-linecap="round" filter="url(#soft)"/>
    <circle cx="-92" cy="-136" r="13" fill="#fff" filter="url(#soft)"/>
    <!-- Symbole -->
    ${neon(symG(), C.or, C.orHi, C.orCore, 12)}
  `;
} else {
  // Neon-Röhren-Qualle: Teal-Umriss, Orange-Tentakel, ausgefüllte Orange-Symbole
  jelly = `
    <path d="${RIM}" fill="url(#fillSoft)"/>
    <path d="${DOME}" fill="url(#fillSoft)"/>
    <path d="M-174 -70 C-168 -150 -112 -204 -44 -218" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="8" stroke-linecap="round" filter="url(#soft)"/>
    ${neon(`<path d="${DOME}"/><path d="${RIM}"/>`, C.teal, C.tealHi, C.core, 12, 0.85)}
    ${neon(TENT.map(d=>`<path d="${d}"/>`).join(""), C.or, C.orHi, C.orCore, 15)}
    
    ${neon(symG(), C.or, C.orHi, C.orCore, 13)}
    <!-- kleine Funken -->
    <g fill="${C.tealHi}"><circle cx="-190" cy="-170" r="5"/><circle cx="205" cy="-190" r="4"/><circle cx="230" cy="190" r="6" opacity="0.7"/></g>
  `;
}

const tilt = -7;
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
  <g fill="none" stroke="#19e6d2" stroke-linecap="round" opacity="0.7">
    <circle cx="230" cy="330" r="10" stroke-width="4"/><circle cx="190" cy="480" r="6" stroke-width="3"/><circle cx="800" cy="860" r="8" stroke-width="4"/><circle cx="820" cy="250" r="7" stroke-width="3" stroke="#ff8a1f"/>
  </g>
  <g transform="translate(512 428) rotate(${tilt}) scale(0.92)">${jelly}</g>
</svg>
`;
} else {
  svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-400 -300 800 800" width="800" height="800">
  <title>JellyStation – Qualle mit PlayStation-Symbolen (ohne Kachel), für die Start-Animation</title>${defs}
  <g transform="rotate(${tilt})">${jelly}</g>
</svg>
`;
}
process.stdout.write(svg);

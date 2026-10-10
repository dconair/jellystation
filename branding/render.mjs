import { chromium } from "/opt/node-tools/node_modules/playwright/index.mjs";
import fs from "node:fs";
const [svg, out, size] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: +size, height: +size } });
await page.setContent(`<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${fs.readFileSync(svg).toString("base64")}" width="${size}" height="${size}"></body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: out, omitBackground: true });
await b.close();

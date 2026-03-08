#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE_URL = "https://www.bentkey.com";
const OUTPUT_DIR = path.resolve(process.cwd(), "output");

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const env = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

function getCredentials() {
  const dotEnv = parseDotEnv(path.resolve(process.cwd(), ".env"));
  const email = process.env.BENTKEY_EMAIL || dotEnv.BENTKEY_EMAIL;
  const password = process.env.BENTKEY_PASSWORD || dotEnv.BENTKEY_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Missing credentials. Set BENTKEY_EMAIL and BENTKEY_PASSWORD in .env or environment variables."
    );
  }

  return { email, password };
}

function buildOutputPrefix(scrapedUrl) {
  const url = new URL(scrapedUrl);
  const host = url.hostname.replace(/[^a-z0-9]+/gi, "_");
  const pathname = url.pathname.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  const page = pathname || "root";
  return `${host}_${page}_shows`.toLowerCase();
}

async function clickIfPresent(page, selectorOrRole) {
  try {
    if (selectorOrRole.type === "role") {
      const locator = page.getByRole(selectorOrRole.role, {
        name: selectorOrRole.name,
      });
      if (await locator.first().isVisible({ timeout: 1500 })) {
        await locator.first().click({ timeout: 3000 });
        return true;
      }
      return false;
    }

    const locator = page.locator(selectorOrRole.selector);
    if (await locator.first().isVisible({ timeout: 1500 })) {
      await locator.first().click({ timeout: 3000 });
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function login(page, email, password) {
  await page.goto(`${BASE_URL}/login/`, { waitUntil: "domcontentloaded" });

  await clickIfPresent(page, {
    type: "role",
    role: "button",
    name: /essential only/i,
  });
  await clickIfPresent(page, {
    type: "role",
    role: "button",
    name: /allow all/i,
  });

  const emailInput = page.locator('input[type="email"], #email-signup-input').first();
  await emailInput.fill(email);
  await page.getByRole("button", { name: /continue/i }).click();

  const passwordInput = page
    .locator('input[type="password"], #password-signup-input')
    .first();
  await passwordInput.waitFor({ state: "visible", timeout: 15000 });
  await passwordInput.fill(password);
  const loginButton = page.locator("#login");
  if (await loginButton.first().isVisible().catch(() => false)) {
    await loginButton.first().click();
  } else {
    await page.getByRole("button", { name: "Log In", exact: true }).last().click();
  }

  const loginPathRegex = /\/login\/?$/;
  const urlChanged = page
    .waitForURL((url) => {
      return url.hostname === "www.bentkey.com" && !loginPathRegex.test(url.pathname);
    }, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const avatarVisible = page
    .getByRole("button", { name: /signed in avatar/i })
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .then(() => true)
    .catch(() => false);

  const [urlOk, avatarOk] = await Promise.all([urlChanged, avatarVisible]);
  const loginSucceeded = urlOk || avatarOk;
  if (!loginSucceeded) {
    throw new Error(`Login did not complete. Current URL: ${page.url()}`);
  }
}

async function scrapeShows(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  const shows = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="?modal=show"]')];
    const map = new Map();

    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const toAbsoluteUrl = (value) => {
      if (!value) return "";
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith("//")) return `${window.location.protocol}${value}`;
      if (value.startsWith("/")) return `${window.location.origin}${value}`;
      return "";
    };

    for (const link of links) {
      const hrefAttr = link.getAttribute("href") || "";
      const href = new URL(hrefAttr, window.location.origin);
      const modalId = href.searchParams.get("modal");
      if (!modalId || !modalId.startsWith("show")) continue;

      const imageNode = link.querySelector("img");
      const imgAlt = clean(imageNode?.getAttribute("alt"));
      const ariaLabel = clean(link.getAttribute("aria-label"));
      const text = clean(link.textContent);
      const title = imgAlt || ariaLabel || text || modalId;
      const imageUrl =
        toAbsoluteUrl(imageNode?.currentSrc) ||
        toAbsoluteUrl(imageNode?.getAttribute("src")) ||
        toAbsoluteUrl(imageNode?.getAttribute("data-src")) ||
        toAbsoluteUrl(link.getAttribute("data-background-image"));
      const url = `${window.location.origin}/?modal=${modalId}`;
      const existing = map.get(modalId);

      if (!existing || title.length > existing.title.length) {
        map.set(modalId, { modalId, title, url, imageUrl });
      }
    }

    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
  });

  if (!shows.length) {
    throw new Error("No shows discovered on the Bentkey home page.");
  }

  return shows;
}

function saveOutput(shows, scrapedUrl) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPrefix = buildOutputPrefix(scrapedUrl);
  const scrapedAt = new Date().toISOString();

  const showsPath = path.join(OUTPUT_DIR, `${outputPrefix}.json`);
  fs.writeFileSync(
    showsPath,
    `${JSON.stringify(
      {
        scrapedFrom: scrapedUrl,
        scrapedAt,
        itemType: "show",
        itemCount: shows.length,
        items: shows,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const txtPath = path.join(OUTPUT_DIR, `${outputPrefix}_urls.txt`);
  const lines = shows.map((show) => `${show.title} ${show.url}`.trim());
  fs.writeFileSync(txtPath, `${lines.join("\n")}\n`, "utf8");

  return { showsPath, txtPath };
}

async function main() {
  const { email, password } = getCredentials();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log("Logging in...");
    await login(page, email, password);
    console.log("Login successful.");

    console.log("Scraping available shows from home page...");
    const shows = await scrapeShows(page);
    console.log(`Found ${shows.length} unique shows.`);

    const files = saveOutput(shows, `${BASE_URL}/`);
    console.log("\nSaved files:");
    console.log(`- ${files.showsPath}`);
    console.log(`- ${files.txtPath}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`\nScrape failed: ${error.message}`);
  process.exitCode = 1;
});

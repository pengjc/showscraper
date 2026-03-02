#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
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

  const emailInput = page.locator("#email-signup-input");
  await emailInput.fill(email);
  await page.getByRole("button", { name: /continue/i }).click();

  const passwordInput = page.locator("#password-signup-input");
  await passwordInput.fill(password);
  await page.getByRole("button", { name: "Log In", exact: true }).click();

  await page.waitForURL((url) => {
    return url.hostname === "www.bentkey.com" && url.pathname === "/";
  });
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

async function promptShow(shows) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("\nAvailable shows:");
    for (let i = 0; i < shows.length; i += 1) {
      const show = shows[i];
      console.log(`${String(i + 1).padStart(2, " ")}. ${show.title} (${show.modalId})`);
    }

    while (true) {
      const answer = await rl.question("\nChoose show number to scrape episodes: ");
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= shows.length) {
        return shows[n - 1];
      }
      console.log(`Invalid selection "${answer}". Enter a number from 1-${shows.length}.`);
    }
  } finally {
    rl.close();
  }
}

async function scrapeEpisodes(page, show) {
  await page.goto(show.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#show-modal-content-container", { timeout: 20000 });
  await page.waitForTimeout(1200);

  const episodes = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        "#show-modal-content-container episode-element[data-episode-details]"
      ),
    ];

    const toAbsoluteUrl = (value) => {
      if (!value || typeof value !== "string") return "";
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith("//")) return `${window.location.protocol}${value}`;
      if (value.startsWith("/")) return `${window.location.origin}${value}`;
      return "";
    };

    const collectStringUrls = (value, out, seen) => {
      if (!value) return;
      if (typeof value === "string") {
        const normalized = toAbsoluteUrl(value.trim());
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectStringUrls(item, out, seen);
        return;
      }
      if (typeof value === "object") {
        for (const nested of Object.values(value)) {
          collectStringUrls(nested, out, seen);
        }
      }
    };

    const out = [];
    for (const node of nodes) {
      const raw = node.getAttribute("data-episode-details");
      if (!raw) continue;

      let episode;
      try {
        episode = JSON.parse(raw);
      } catch (_) {
        continue;
      }

      const videoId = episode?.videos?.main?.id;
      if (!videoId) continue;
      const img = node.querySelector("img");
      const metadataImageCandidates = [];
      const seen = new Set();
      collectStringUrls(episode?.images, metadataImageCandidates, seen);
      collectStringUrls(episode?.videos?.main?.images, metadataImageCandidates, seen);
      collectStringUrls(episode?.videos?.main?.thumbnails, metadataImageCandidates, seen);
      collectStringUrls(episode?.videos?.main?.poster, metadataImageCandidates, seen);
      const imageUrl =
        toAbsoluteUrl(img?.currentSrc) ||
        toAbsoluteUrl(img?.getAttribute("src")) ||
        toAbsoluteUrl(img?.getAttribute("data-src")) ||
        metadataImageCandidates[0] ||
        "";

      out.push({
        season: episode?.showData?.seasonNumber || null,
        number: episode?.number || null,
        title: episode?.strings?.title || "",
        imageUrl,
        videoId,
        url: `${window.location.origin}/play/${videoId}/`,
      });
    }

    return out;
  });

  if (!episodes.length) {
    throw new Error(
      `No episodes found for ${show.modalId}. The show may not expose episode data in this modal.`
    );
  }

  episodes.sort((a, b) => {
    const seasonA = a.season || 0;
    const seasonB = b.season || 0;
    if (seasonA !== seasonB) return seasonA - seasonB;
    return (a.number || 0) - (b.number || 0);
  });

  return episodes;
}

function saveOutput(shows, selectedShow, episodes) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const showsPath = path.join(OUTPUT_DIR, "all_shows.json");
  fs.writeFileSync(showsPath, `${JSON.stringify(shows, null, 2)}\n`, "utf8");

  const jsonPath = path.join(OUTPUT_DIR, `${selectedShow.modalId}_episodes.json`);
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        show: selectedShow,
        episodeCount: episodes.length,
        episodes,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const txtPath = path.join(OUTPUT_DIR, `${selectedShow.modalId}_episode_urls.txt`);
  const lines = episodes.map((ep) => {
    const season = ep.season == null ? "S?" : `S${ep.season}`;
    const num = ep.number == null ? "E?" : `E${ep.number}`;
    return `${season}${num} ${ep.title} ${ep.url}`.trim();
  });
  fs.writeFileSync(txtPath, `${lines.join("\n")}\n`, "utf8");

  return { showsPath, jsonPath, txtPath };
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

    const selectedShow = await promptShow(shows);
    console.log(`Scraping episodes for: ${selectedShow.title} (${selectedShow.modalId})`);

    const episodes = await scrapeEpisodes(page, selectedShow);
    console.log(`Found ${episodes.length} episodes.`);

    const files = saveOutput(shows, selectedShow, episodes);
    console.log("\nSaved files:");
    console.log(`- ${files.showsPath}`);
    console.log(`- ${files.jsonPath}`);
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

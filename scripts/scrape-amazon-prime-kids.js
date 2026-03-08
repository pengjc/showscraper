#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const TARGET_URL = "https://www.amazon.com/gp/video/kids";
const OUTPUT_DIR = path.resolve(process.cwd(), "output");

function parseArgs(argv) {
  const args = {
    headed: false,
    maxScrolls: 8,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--headed") {
      args.headed = true;
    } else if (arg === "--max-scrolls") {
      const value = Number.parseInt(argv[i + 1], 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--max-scrolls must be a non-negative integer.");
      }
      args.maxScrolls = value;
      i += 1;
    }
  }

  return args;
}

function buildOutputPrefix(scrapedUrl) {
  const url = new URL(scrapedUrl);
  const host = url.hostname.replace(/[^a-z0-9]+/gi, "_");
  const pathname = url.pathname.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  const page = pathname || "root";
  return `${host}_${page}_shows`.toLowerCase();
}

async function autoScroll(page, maxScrolls) {
  for (let i = 0; i < maxScrolls; i += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 1.6));
    });
    await page.waitForTimeout(700);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

async function scrapeShows(page, maxScrolls) {
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

  await page.waitForSelector('main a[href*="/gp/video/detail/"]', {
    timeout: 30000,
  });

  await autoScroll(page, maxScrolls);

  const shows = await page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const toAbsoluteUrl = (url) => {
      if (!url || typeof url !== "string") return "";
      try {
        return new URL(url, window.location.origin).toString();
      } catch (_) {
        return "";
      }
    };

    const parseDetailId = (url) => {
      try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\/gp\/video\/detail\/([^/]+)/i);
        return match ? match[1] : "";
      } catch (_) {
        return "";
      }
    };

    const findSectionName = (node) => {
      const section = node.closest('section, [role="region"], [data-testid]');
      if (!section) return "";

      const heading = section.querySelector("h1, h2, h3, h4");
      return clean(heading?.textContent || section.getAttribute("aria-label"));
    };

    const links = [...document.querySelectorAll('main a[href*="/gp/video/detail/"]')];
    const byId = new Map();

    for (const link of links) {
      const rawHref = link.getAttribute("href");
      const url = toAbsoluteUrl(rawHref);
      if (!url) continue;

      const detailId = parseDetailId(url);
      if (!detailId) continue;

      const article = link.closest("article") || link.parentElement;
      const headingNode = article?.querySelector("h1, h2, h3, h4");
      const imageNode = link.querySelector("img") || article?.querySelector("img");

      const title =
        clean(link.getAttribute("aria-label")) ||
        clean(imageNode?.getAttribute("alt")) ||
        clean(headingNode?.textContent) ||
        clean(link.textContent) ||
        detailId;

      const imageUrl =
        toAbsoluteUrl(imageNode?.currentSrc) ||
        toAbsoluteUrl(imageNode?.getAttribute("src")) ||
        "";

      const section = findSectionName(link);
      const existing = byId.get(detailId);

      const current = {
        detailId,
        title,
        url,
        imageUrl,
        section,
      };

      if (!existing) {
        byId.set(detailId, current);
        continue;
      }

      const existingScore = (existing.title ? existing.title.length : 0) + (existing.imageUrl ? 1 : 0);
      const currentScore = (current.title ? current.title.length : 0) + (current.imageUrl ? 1 : 0);
      if (currentScore > existingScore) {
        byId.set(detailId, current);
      }
    }

    return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
  });

  if (!shows.length) {
    throw new Error("No shows were found on the Amazon Prime Kids page.");
  }

  return shows;
}

function saveOutput(shows, scrapedUrl) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPrefix = buildOutputPrefix(scrapedUrl);
  const scrapedAt = new Date().toISOString();

  const jsonPath = path.join(OUTPUT_DIR, `${outputPrefix}.json`);
  fs.writeFileSync(
    jsonPath,
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

  return { jsonPath, txtPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Scraping Amazon Prime Kids from ${TARGET_URL} ...`);
    const shows = await scrapeShows(page, args.maxScrolls);
    console.log(`Found ${shows.length} unique shows.`);

    const files = saveOutput(shows, TARGET_URL);
    console.log("\nSaved files:");
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

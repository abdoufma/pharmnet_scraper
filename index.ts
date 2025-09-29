// const TEST_URL = "https://pharmnet-dz.com/m-5866-abasaglar-100ui-ml-3-64mg-ml-sol-inj-en-stylo-prerempli-kwikpen-b-05-stylos-preremlis-de-3-ml";
// const TEST_URL = "https://pharmnet-dz.com/m-2639-paralgan-1000mg-suppo-b-10";
// const TEST_URL = "https://pharmnet-dz.com/m-4416-ibuprane-200mg-comp-pelli-b-20";
const TEST_URL = "https://pharmnet-dz.com/m-1220-inagra-50mg-comp-pelli--b-02-et-b-10";

import puppeteer, { ElementHandle, Browser } from "puppeteer";

async function scrapePage(url: string, browser: Browser) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      if (["image"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
    await page.goto(url, {timeout : 60000});
    const pharmaceutical_metadata_selector = '.col-lg-7.col-md-7.col-sm-8.col-xs-12 a:has(img)';
    await page.waitForSelector(pharmaceutical_metadata_selector, { timeout: 60000 }).catch(() => {});
    const pharmaceutical_metadata = await page.$$(pharmaceutical_metadata_selector);
    if (pharmaceutical_metadata.length === 0) {
        await page.close();
        return null;
    }
    const pharmaceutical_metadata_texts = await Promise.all(
        pharmaceutical_metadata.map((el: ElementHandle<Element>) => el.evaluate((node: any) => node.textContent.trim()))
      );
    const [manufacturer, family, therapeutic_class, molecule] = pharmaceutical_metadata_texts;
    const medicine_metadata_selector = '.col-lg-7.col-md-7.col-sm-8.col-xs-12 strong';
    await page.waitForSelector(medicine_metadata_selector, { timeout: 60000 });
    const medicine_metadata = await page.$$(medicine_metadata_selector);
    const medicine_metadata_texts = await Promise.all(
        medicine_metadata.map((el: ElementHandle<Element>) => el.evaluate((node: any) => node.nextSibling.textContent.trim()))
      );
    const [medicine_name, medicine_code, medicine_form, medicine_dosage, medicine_packaging] = medicine_metadata_texts;
    const extractExtraField = (el: ElementHandle<Element>) => {
        return el.evaluate((node: any) => {
            const valueNode = node.nextSibling;
            if (valueNode.nodeType === 3) {
                return valueNode.textContent.trim();
            } else {
                if (valueNode.tagName === 'i' || valueNode.tagName === 'I') {
                    return true;
                }
                return "UNKNOWN";
            }
        });
    }
    const extra_metadata_selector = '.col-lg-5.col-md-5.col-sm-4.col-xs-12 strong';
    await page.waitForSelector(extra_metadata_selector, { timeout: 60000 });
    const extra_metadata = await page.$$(extra_metadata_selector);
    const extra_metadata_texts = await Promise.all(extra_metadata.map(extractExtraField));
    const [type, list, country, in_market, reimbursable, msrp, ppa, record_number] = extra_metadata_texts;
    await page.close();
    return { url, manufacturer, family, therapeutic_class, molecule, medicine_name, medicine_code, medicine_form, medicine_dosage, medicine_packaging,
         type, list, country, in_market, reimbursable, msrp, ppa, record_number
    };
}

async function scrapeSite() {
    const startingURL = 'https://pharmnet-dz.com/alphabet.aspx?char=A';
    const medicinePageLinksSelector = 'td.hidden-sm.hidden-xs a';
    const nextPageSelector = '.btn.btn-danger + .btn';
    const resultsFile = "results.json";
    const visitedFile = "visited_urls.txt";
    let browser: Browser | null = null;
    let interrupted = false;
    // Load visited URLs if file exists
    let visited = new Set<string>();
    if (await Bun.file(visitedFile).exists()) {
        const visitedContent = await Bun.file(visitedFile).text();
        visitedContent.split("\n").forEach((line: string) => {
            if (line.trim()) visited.add(line.trim());
        });
    }
    // Prepare results file (newline-delimited JSON for easy appending)
    if (!(await Bun.file(resultsFile).exists())) {
        await Bun.write(resultsFile, "");
    }
    // Graceful shutdown handler
    async function handleInterrupt() {
        if (interrupted) return;
        interrupted = true;
        console.log("\nInterrupt received. Flushing progress and closing browser...");
        if (browser) {
            try { await browser.close(); } catch {}
        }
        // No in-memory progress to flush, as all writes are immediate
        process.exit(0);
    }
    process.on("SIGINT", handleInterrupt);
    process.on("SIGTERM", handleInterrupt);
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"], defaultViewport: { width: 1280, height: 800 } });
    let currentURL: string | null = startingURL;
    let pageNum = 1;
    while (currentURL && !interrupted) {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on("request", (req: any) => {
          if (["image"].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });
        await page.goto(currentURL, { timeout: 60000 });
        await page.waitForSelector(medicinePageLinksSelector, { timeout: 60000 });
        const linksRaw: (string | null)[] = await page.$$eval(medicinePageLinksSelector, (els: Element[]) => els.map(a => (a as HTMLAnchorElement).getAttribute('href')));
        const links: string[] = linksRaw.filter((l): l is string => !!l);
        for (const link of links) {
            if (link && !visited.has(link)) {
                try {
                    const absoluteLink = link.startsWith('http') ? link : new URL(link, currentURL).toString();
                    const data = await scrapePage(absoluteLink, browser);
                    if (data === null) {
                        console.log(`Skipped (no pharmaceutical metadata): ${absoluteLink}`);
                        continue;
                    }
                    // @ts-expect-error Bun type issue: string path is valid
                    await Bun.write(resultsFile, JSON.stringify(data) + "\n", { append: true });
                    // @ts-expect-error Bun type issue: string path is valid
                    await Bun.write(visitedFile, absoluteLink + "\n", { append: true });
                    visited.add(absoluteLink);
                    console.log(`Scraped: ${absoluteLink}`);
                } catch (err) {
                    console.error(`Failed to scrape ${link}:`, err);
                }
            } else if (link) {
                console.log(`Already visited: ${link}`);
            }
        }
        // Check for next page
        const nextPageExists = await page.$(nextPageSelector);
        if (nextPageExists) {
            const nextHref: string | null = await page.$eval(nextPageSelector, (el: Element) => (el as HTMLAnchorElement).getAttribute('href'));
            if (nextHref) {
                currentURL = nextHref.startsWith('http') ? nextHref : new URL(nextHref, currentURL).toString();
                pageNum++;
                await page.close();
            } else {
                await page.close();
                break;
            }
        } else {
            await page.close();
            break;
        }
    }
    if (browser) await browser.close();
    console.log("Scraping complete.");
}
// Uncomment to run the full site scraper
await scrapeSite();
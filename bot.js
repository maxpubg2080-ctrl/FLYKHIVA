const { chromium } = require("playwright");
const http = require("http");

const PORT = process.env.PORT || 10000;

const TICKETS_URL = "https://b2b.flykhiva.travel/tickets";
const LOGIN_URL = "https://b2b.flykhiva.travel/search_tour?samo_action=logon";

const LOGIN = process.env.FLYKHIVA_LOGIN;
const PASSWORD = process.env.FLYKHIVA_PASSWORD;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const FROM_VALUE = process.env.FROM_VALUE || "1178.16";
const TO_VALUE = process.env.TO_VALUE || "1853.14";

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 300);
const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS || 15);
const FAST_SCAN = String(process.env.FAST_SCAN || "true").toLowerCase() !== "false";

// Alert policy: at most 1 alert every 5 minutes and max 3 alerts in any 15-minute window.
const MIN_ALERT_GAP_MS = 5 * 60 * 1000;
const ALERT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ALERTS_PER_WINDOW = 3;

let browser = null;
let busy = false;
const alertHistory = [];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getTashkentNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const value = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    date: `${value.day}.${value.month}.${value.year}`,
    minutes: Number(value.hour) * 60 + Number(value.minute)
  };
}

function parseTimeMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isPastResult(dateText, times) {
  const now = getTashkentNow();
  if (dateText !== now.date) return false;

  const departure = parseTimeMinutes(times?.[0]);
  if (departure == null) return false;

  return departure < now.minutes;
}

function alertKey(result) {
  return [
    result.date || "",
    result.flight || "",
    result.times?.join("-") || "",
    result.price?.amount || "",
    result.price?.currency || ""
  ].join("|");
}

function pruneAlertHistory(now = Date.now()) {
  while (alertHistory.length && now - alertHistory[0].timestamp > ALERT_WINDOW_MS) {
    alertHistory.shift();
  }
}

function canSendAlert(key) {
  const now = Date.now();
  pruneAlertHistory(now);

  if (alertHistory.length >= MAX_ALERTS_PER_WINDOW) {
    log("ALERT LIMIT: 15 minutda 3 ta xabar allaqachon yuborilgan.");
    return false;
  }

  const last = alertHistory[alertHistory.length - 1];
  if (last && now - last.timestamp < MIN_ALERT_GAP_MS) {
    log("ALERT LIMIT: oxirgi xabardan 5 minut o'tmagan.");
    return false;
  }

  // Do not block duplicates by key. The requested policy is:
  // maximum 3 alerts in 15 minutes, with at least 5 minutes between them.
  // This allows the same still-available flight to be re-sent on later scans.
  return true;
}

function recordAlert(key) {
  pruneAlertHistory();
  alertHistory.push({ timestamp: Date.now(), key });
}

async function sendTelegram(message, key) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Telegram env variables topilmadi.");
  }

  if (!canSendAlert(key)) return false;

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram xato: ${JSON.stringify(data)}`);
  }

  recordAlert(key);
  return true;
}

async function login(page) {
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(1500);

  const loginInput = page
    .locator("input[name='login'], input#login, input[type='text']")
    .first();

  const passwordInput = page
    .locator("input[name='password'], input#password, input[type='password']")
    .first();

  if (!(await loginInput.count())) throw new Error("Login input topilmadi.");
  if (!(await passwordInput.count())) throw new Error("Password input topilmadi.");

  await loginInput.fill(LOGIN);
  await passwordInput.fill(PASSWORD);

  const signIn = page.getByRole("button", {
    name: /sign in|войти|вход/i
  });

  if (await signIn.count()) {
    await signIn.first().click();
  } else {
    await passwordInput.press("Enter");
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await sleep(2500);

  log("FlyKhiva LOGIN OK", { afterLoginUrl: page.url() });

  await page.goto(TICKETS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(2500);
  log("FlyKhiva TICKETS PAGE", { url: page.url() });
}

async function setHiddenSelectValue(page, name, value, leg, textPatterns, fallbackText) {
  const selects = page.locator(`select[name="${name}"]`);
  const count = await selects.count();

  log(`FlyKhiva ${leg}: ${count} ta ${name} select topildi`);
  if (!count) return { ok: false, reason: "SELECT_NOT_FOUND" };

  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);

    const info = await select.evaluate((el, data) => {
      const wanted = String(data.value);
      const patterns = data.patterns || [];
      const options = [...el.options];

      let option = options.find(o => String(o.value) === wanted);
      let matchedBy = option ? "value" : null;

      if (!option) {
        option = options.find(o => {
          const text = (o.textContent || "").trim().toLowerCase();
          return patterns.some(p => text.includes(String(p).toLowerCase()));
        });
        matchedBy = option ? "text" : null;
      }

      return {
        found: Boolean(option),
        matchedBy,
        value: option?.value || null,
        text: option?.textContent?.trim() || null,
        optionCount: options.length,
        selectedValue: el.value,
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      };
    }, { value, patterns: textPatterns });

    log(`FlyKhiva ${leg} SELECT ${i}:`, info);

    if (!info.found) continue;

    const applied = await select.evaluate((el, wantedValue) => {
      const value = String(wantedValue);
      const option = [...el.options].find(o => String(o.value) === value);
      if (!option) return { ok: false, reason: "OPTION_DISAPPEARED" };

      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));

      if (window.jQuery) {
        window.jQuery(el).val(value);
        window.jQuery(el).trigger("change");
        window.jQuery(el).trigger("chosen:updated");
      }

      return {
        ok: true,
        value: el.value,
        text: option.textContent.trim(),
        index: el.selectedIndex
      };
    }, info.value);

    if (!applied.ok) throw new Error(`${name} option apply bo'lmadi: ${applied.reason}`);

    await sleep(1200);

    const finalState = await select.evaluate(el => ({
      name: el.name,
      value: el.value,
      text: el.options[el.selectedIndex]?.textContent?.trim() || "",
      index: el.selectedIndex,
      optionCount: el.options.length
    }));

    log(`FlyKhiva ${leg} OK:`, {
      ...finalState,
      matchedBy: info.matchedBy
    });

    return { ok: true, ...finalState, matchedBy: info.matchedBy };
  }

  // If the automation session initially sees the wrong/default option set,
  // add the known-good option and activate it through the page's own events.
  const select = selects.first();
  const injected = await select.evaluate((el, data) => {
    const wanted = String(data.value);
    let option = [...el.options].find(o => String(o.value) === wanted);

    if (!option) {
      option = document.createElement("option");
      option.value = wanted;
      option.textContent = data.text;
      option.setAttribute("data-bot-injected", "true");
      el.appendChild(option);
    }

    el.value = wanted;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));

    if (window.jQuery) {
      window.jQuery(el).val(wanted);
      window.jQuery(el).trigger("change");
      window.jQuery(el).trigger("chosen:updated");
    }

    return {
      value: el.value,
      text: el.options[el.selectedIndex]?.textContent?.trim() || "",
      optionCount: el.options.length
    };
  }, { value, text: fallbackText });

  await sleep(1200);

  log(`FlyKhiva ${leg}: fallback option ishlatildi`, injected);

  return {
    ok: String(injected.value) === String(value),
    name,
    value: injected.value,
    text: injected.text,
    optionCount: injected.optionCount,
    matchedBy: "injected-value"
  };
}

async function setRoute(page) {
  const from = await setHiddenSelectValue(
    page,
    "TOWNFROMINC",
    FROM_VALUE,
    "FROM",
    ["sharm", "шарм", "ssh", "sharm-el-sheikh", "шарм-эль-шейх"],
    "Sharm (SSH)"
  );

  if (!from.ok) return false;

  await sleep(1000);

  const to = await setHiddenSelectValue(
    page,
    "TOWNTOINC",
    TO_VALUE,
    "TO",
    ["toshkent", "ташкент", "tashkent", "tas"],
    "Toshkent (TAS)"
  );

  if (!to.ok) return false;

  await sleep(800);
  log(`FlyKhiva ROUTE OK: Sharm -> Toshkent | ${from.value} -> ${to.value}`);
  return true;
}

async function setAdultsCount(page, count) {
  const wanted = String(count);

  const result = await page.evaluate(wanted => {
    const selects = [...document.querySelectorAll("select")];

    for (const el of selects) {
      const parentText = [
        el.parentElement?.innerText || "",
        el.closest("td,div,fieldset,form")?.innerText || ""
      ].join(" ").toLowerCase();

      const meta = [
        el.name || "",
        el.id || "",
        el.className || ""
      ].join(" ").toLowerCase();

      const isAdultSelect = /adult|взросл/.test(`${meta} ${parentText}`);
      if (!isAdultSelect) continue;

      const option = [...el.options].find(o =>
        String(o.value) === wanted ||
        o.textContent.trim() === wanted
      );

      if (!option) {
        return {
          ok: false,
          optionMissing: true,
          name: el.name || "",
          id: el.id || "",
          maxOptions: el.options.length,
          available: [...el.options].map(o => ({ value: o.value, text: o.textContent.trim() }))
        };
      }

      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));

      if (window.jQuery) {
        window.jQuery(el).val(option.value);
        window.jQuery(el).trigger("input");
        window.jQuery(el).trigger("change");
        window.jQuery(el).trigger("chosen:updated");
      }

      return {
        ok: String(el.value) === String(option.value),
        name: el.name || "",
        id: el.id || "",
        value: el.value,
        text: option.textContent.trim()
      };
    }

    return { ok: false, reason: "ADULT_SELECT_NOT_FOUND" };
  }, wanted);

  log(`FlyKhiva ADULTS SET ${count}:`, result);

  if (!result.ok) return false;

  await sleep(500);
  return true;
}

async function setDate(page, dateText) {
  const result = await page.evaluate(dateText => {
    const inputs = [...document.querySelectorAll("input")];

    const candidates = inputs.filter(el => {
      if (el.disabled) return false;

      const style = window.getComputedStyle(el);
      const visible = style.display !== "none" && style.visibility !== "hidden";

      const info = [
        el.name || "",
        el.id || "",
        el.placeholder || "",
        el.className || "",
        el.getAttribute("aria-label") || "",
        el.parentElement?.innerText || ""
      ].join(" ").toLowerCase();

      return visible && (
        /checkin|date|depart|when|дата|когда/.test(info) ||
        /дд\.мм\.гггг|dd\.mm\.yyyy/.test(info) ||
        /^\d{2}\.\d{2}\.\d{4}$/.test(String(el.value || ""))
      );
    });

    if (!candidates.length) return { ok: false, reason: "DATE_INPUT_NOT_FOUND" };

    const preferred = candidates.find(el => {
      const info = [el.name || "", el.id || "", el.placeholder || "", el.parentElement?.innerText || ""]
        .join(" ")
        .toLowerCase();
      return /checkin|когда/.test(info);
    }) || candidates[0];

    const input = preferred;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

    setter.call(input, dateText);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));

    if (window.jQuery) {
      window.jQuery(input).val(dateText);
      window.jQuery(input).trigger("input");
      window.jQuery(input).trigger("change");
      window.jQuery(input).trigger("blur");
    }

    return {
      ok: true,
      name: input.name,
      id: input.id,
      type: input.type,
      value: input.value,
      placeholder: input.placeholder || ""
    };
  }, dateText);

  log(`FlyKhiva DATE SET ${dateText}:`, result);

  if (!result.ok) throw new Error(`Sana input topilmadi: ${dateText}`);

  await sleep(700);

  const verified = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")];
    return inputs
      .filter(el => !el.disabled)
      .map(el => ({
        name: el.name,
        id: el.id,
        value: el.value,
        placeholder: el.placeholder
      }))
      .filter(x => x.value && /\d{2}\.\d{2}\.\d{4}/.test(x.value));
  });

  log("FlyKhiva DATE INPUTS:", verified);
}

async function clickSearch(page) {
  let clicked = false;

  const button = page.getByRole("button", { name: /искать|search/i }).first();
  if (await button.count()) {
    try {
      await button.click();
      clicked = true;
      log("FlyKhiva SEARCH: button");
    } catch (error) {
      log("button click xato:", error.message);
    }
  }

  if (!clicked) {
    const submit = page.locator("input[type='submit'].load, input[type='submit']").first();
    if (await submit.count()) {
      await submit.click();
      clicked = true;
      log("FlyKhiva SEARCH: submit");
    }
  }

  if (!clicked) throw new Error("Search tugmasi topilmadi.");

  await sleep(4500);
}

function parsePrice(text) {
  const match = text.match(/([\d\s.,]+)\s*(UZS|USD|EUR|KZT|RUB|AZN)\b/i);
  if (!match) return null;
  return {
    amount: match[1].trim(),
    currency: match[2].toUpperCase()
  };
}

function parseSeatInfo(text) {
  const lower = text.toLowerCase();

  if (lower.includes("нет мест")) {
    return { available: false, label: "YO'Q", count: null };
  }

  const exact = text.match(/(\d+)\s*(?:мест|места|место|seat|seats)\b/i);
  if (exact) {
    return { available: Number(exact[1]) > 0, label: `${exact[1]} ta`, count: Number(exact[1]) };
  }

  if (lower.includes("мест мало")) {
    return { available: true, label: "KAM (aniq son ko'rsatilmagan)", count: null };
  }

  if (lower.includes("есть места") || lower.includes("места есть")) {
    return { available: true, label: "BOR (aniq son ko'rsatilmagan)", count: null };
  }

  return { available: false, label: "NOANIQ", count: null };
}

function parseFlightCards(cards) {
  const results = [];

  for (const card of cards) {
    const text = (card.text || "").trim();
    if (!text) continue;

    const seat = parseSeatInfo(text);
    if (!seat.available) continue;

    const price = parsePrice(text);
    if (!price) continue;

    const date = text.match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0] || null;
    const flight = text.match(/\b[A-Z0-9]{2,3}-\d{3,5}\b/)?.[0] || null;
    const times = [...text.matchAll(/\b\d{2}:\d{2}\b/g)].map(m => m[0]);

    results.push({
      date,
      flight,
      times,
      price,
      seat,
      cardText: text
    });
  }

  return results;
}

async function readFlightResults(page) {
  const cards = await page
    .locator(".flight.flight-most-relevant")
    .evaluateAll(elements => elements.map(element => ({ text: element.innerText || "" })));

  log(`FlyKhiva flight cards: ${cards.length}`);
  return parseFlightCards(cards);
}

async function checkDate(page, date) {
  const dateText = formatDate(date);

  log("");
  log(`===== TEKSHIRILMOQDA: ${dateText} =====`);

  await page.goto(TICKETS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(1500);

  const routeReady = await setRoute(page);
  if (!routeReady) {
    log(`FlyKhiva ROUTE YO'Q: ${dateText}`);
    return [];
  }

  // First pass: exactly 1 adult. This is the ONLY price we use in the Telegram message.
  await setAdultsCount(page, 1);
  await setDate(page, dateText);
  await clickSearch(page);

  const results = await readFlightResults(page);
  const valid = [];

  for (const result of results) {
    // Critical safety check: never report a result for a different date.
    if (result.date && result.date !== dateText) {
      log(`DATE MISMATCH: so'ralgan ${dateText}, kartada ${result.date}. Xabar yuborilmaydi.`);
      continue;
    }

    // Never report a flight whose departure time is already past today.
    if (result.date && isPastResult(result.date, result.times)) {
      log(`PAST FLIGHT SKIPPED: ${result.date} ${result.times?.[0] || ""}`);
      continue;
    }

    valid.push(result);
  }

  if (!valid.length) {
    log(`JOY YO'Q: ${dateText}`);
    return [];
  }

  return valid;
}

async function findMatchingCard(page, baseResult) {
  const cards = await page
    .locator(".flight.flight-most-relevant")
    .evaluateAll(elements => elements.map(element => ({ text: element.innerText || "" })));

  const parsed = parseFlightCards(cards);

  const same = parsed.find(item => {
    if (baseResult.flight && item.flight) {
      return item.flight === baseResult.flight &&
        (!baseResult.date || !item.date || item.date === baseResult.date);
    }

    if (baseResult.times?.length && item.times?.length) {
      return item.times[0] === baseResult.times[0] &&
        (!baseResult.date || !item.date || item.date === baseResult.date);
    }

    return false;
  });

  return same || null;
}

async function searchSameFlightForAdults(page, count, baseResult) {
  const setOk = await setAdultsCount(page, count);
  if (!setOk) {
    log(`FlyKhiva ADULTS ${count}: select bu sonni qabul qilmadi.`);
    return null;
  }

  await clickSearch(page);
  const matched = await findMatchingCard(page, baseResult);

  if (!matched) {
    log(`FlyKhiva SEAT TEST: ${count} ta kattada aynan shu reys topilmadi.`);
    return null;
  }

  if (!matched.seat?.available) {
    log(`FlyKhiva SEAT TEST YO'Q: ${count} ta kattalar uchun joy yetarli emas.`);
    return null;
  }

  log(`FlyKhiva SEAT TEST OK: ${count} ta kattalar uchun shu reys mavjud.`);
  return matched;
}

async function determineSeatCount(page, baseResult) {
  // Fast mode: first test 10. If 10 works, report 10+ immediately.
  // Otherwise use a binary search because seat availability is monotonic:
  // if N adults can book the same flight, any smaller number should also work.
  if (FAST_SCAN) {
    const ten = await searchSameFlightForAdults(page, 10, baseResult);
    if (ten) return "10+";

    let low = 1;
    let high = 9;
    let best = 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const matched = await searchSameFlightForAdults(page, mid, baseResult);

      if (matched) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return `${best} ta`;
  }

  // Slow/compatibility mode: exact descending test 10 -> 2.
  for (let count = 10; count >= 2; count--) {
    const matched = await searchSameFlightForAdults(page, count, baseResult);
    if (matched) {
      if (count === 10) return "10+";
      return `${count} ta`;
    }
  }

  return "1 ta";
}

function buildMessage(result, searchedDate, totalSeatsLabel) {
  const timeText = result.times.length >= 2
    ? `${result.times[0]} → ${result.times[1]}`
    : result.times.join(" → ");

  // Price always comes from the 1-adult confirmation search.
  // Show the 1-adult price even when the confirmed seat count is 10+.
  const numericAmount = result.price.amount.replace(/[^\d]/g, "");
  const formattedAmount = Number(numericAmount).toLocaleString("en-US");
  const priceLine = `\n💰 Narx: ${formattedAmount} ${result.price.currency}`;

  return `🟢 HAQIQIY JOY BOR

🏢 Sistema: FlyKhiva
🛫 Yo'nalish: Sharm → Toshkent
📅 Sana: ${result.date || searchedDate}
✈️ Reys: ${result.flight || "Noma'lum"}
🕐 Vaqt: ${timeText || "Noma'lum"}
💺 Joy: 1DONA${priceLine}
💺 Joy SONI: ${totalSeatsLabel}`;
}

function getTashkentStartDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const value = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return new Date(Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day)
  ));
}

async function monitor() {
  if (busy) {
    log("Oldingi tekshiruv hali tugamagan.");
    return;
  }

  busy = true;
  let context = null;

  try {
    if (!LOGIN) throw new Error("FLYKHIVA_LOGIN env mavjud emas.");
    if (!PASSWORD) throw new Error("FLYKHIVA_PASSWORD env mavjud emas.");

    if (!browser) browser = await chromium.launch({ headless: true });

    context = await browser.newContext();
    const page = await context.newPage();

    await login(page);

    const start = getTashkentStartDate();
    let foundCount = 0;

    log(`FlyKhiva LOOKAHEAD: ${LOOKAHEAD_DAYS} kun`);

    // Scan every day in the rolling 15-day window.
    // Do not stop after the first available date. Each day is handled
    // independently, while Telegram rate limits prevent flooding.
    for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
      const date = addDays(start, i);

      try {
        const results = await checkDate(page, date);

        if (results.length) {
          const first = results[0];

          // Confirm the same flight with 10..2 adults to estimate the
          // maximum number of seats available. The 1-adult result remains
          // the source of the price.
          const totalSeatsLabel = await determineSeatCount(page, first);
          const message = buildMessage(
            first,
            formatDate(date),
            totalSeatsLabel
          );
          const key = alertKey(first);

          foundCount += 1;

          log("MAVJUD REYS:", {
            date: first.date,
            flight: first.flight,
            times: first.times,
            seat: totalSeatsLabel
          });

          const sent = await sendTelegram(message, key);
          if (sent) {
            log("Telegram alert yuborildi.");
          }
        }
      } catch (error) {
        log(`Sana ${formatDate(date)} monitor xato:`, error.message);
      }

      // Small pause so the site is not hammered between dates.
      await sleep(700);
    }

    log(`FlyKhiva ${LOOKAHEAD_DAYS} kunlik scan tugadi. Mavjud kunlar: ${foundCount}`);
  } catch (error) {
    log("MONITOR XATO:", error.message);
  } finally {
    if (context) await context.close().catch(() => {});
    busy = false;
  }
}

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("FlyKhiva bot ishlayapti");
  })
  .listen(PORT, () => {
    log(`Health server: ${PORT}`);
  });

(async () => {
  await monitor();

  setInterval(() => {
    monitor().catch(error => log("Interval monitor xato:", error.message));
  }, POLL_SECONDS * 1000);
})();

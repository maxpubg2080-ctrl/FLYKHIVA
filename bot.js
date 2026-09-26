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

let browser = null;
let busy = false;

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

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Telegram env variables topilmadi.");
  }

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

  if (!(await loginInput.count())) {
    throw new Error("Login input topilmadi.");
  }

  if (!(await passwordInput.count())) {
    throw new Error("Password input topilmadi.");
  }

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

  // Always open the user-confirmed Charter Tickets page explicitly.
  await page.goto(TICKETS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(2500);

  log("FlyKhiva TICKETS PAGE", { url: page.url() });
}

async function setRouteSelect(page, name, value, leg, textPatterns, fallbackText) {
  const selects = page.locator(`select[name="${name}"]`);
  const count = await selects.count();

  log(`FlyKhiva ${leg}: ${count} ta ${name} select topildi`);

  if (!count) {
    return { ok: false, reason: "SELECT_NOT_FOUND" };
  }

  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);

    const info = await select.evaluate((el, data) => {
      const wantedValue = String(data.value);
      const patterns = data.patterns || [];
      const options = [...el.options];

      let option = options.find(o => String(o.value) === wantedValue);
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
        value: option ? option.value : null,
        text: option ? option.textContent.trim() : null,
        optionCount: options.length,
        selectedValue: el.value,
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      };
    }, { value, patterns: textPatterns });

    log(`FlyKhiva ${leg} SELECT ${i}:`, info);

    if (info.found) {
      const applied = await select.evaluate((el, wantedValue) => {
        const value = String(wantedValue);
        const option = [...el.options].find(o => String(o.value) === value);
        if (!option) {
          return { ok: false, reason: "OPTION_DISAPPEARED" };
        }

        // FlyKhiva hides the native SELECT (Chosen/custom UI).
        // Playwright's selectOption waits for visibility, so set the native
        // value directly and fire the same DOM/jQuery events the page uses.
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
      }, String(info.value));

      if (!applied.ok) {
        throw new Error(`${name} option apply bo'lmadi: ${applied.reason}`);
      }

      await select.evaluate(el => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });

      await sleep(1000);

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

    // Fallback: the user's real browser session proves that the Charter page
    // accepts these exact numeric values even when automation initially sees
    // a different/default option set. Inject the known-good option and fire
    // the same events the site uses for a normal selection.
    if (i === 0) {
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
      }, {
        value,
        text: fallbackText
      });

      await sleep(1200);

      log(`FlyKhiva ${leg}: fallback option ishlatildi`, injected);

      if (String(injected.value) === String(value)) {
        const idx = await select.evaluate(el => el.selectedIndex);
        return {
          ok: true,
          name,
          value: injected.value,
          text: injected.text,
          index: idx,
          optionCount: injected.optionCount,
          matchedBy: "injected-value"
        };
      }
    }
  }

  return {
    ok: false,
    reason: "OPTION_NOT_FOUND",
    name,
    value
  };
}

async function setRoute(page) {
  const from = await setRouteSelect(
    page,
    "TOWNFROMINC",
    FROM_VALUE,
    "FROM",
    ["sharm", "шарм", "ssh", "sharm-el-sheikh", "шарм-эль-шейх"],
    "Sharm (SSH)"
  );

  if (!from.ok) {
    log("FlyKhiva FROM: Sharm route tanlanmadi.");
    return false;
  }

  await sleep(1000);

  const to = await setRouteSelect(
    page,
    "TOWNTOINC",
    TO_VALUE,
    "TO",
    ["toshkent", "ташкент", "tashkent", "tas"],
    "Toshkent (TAS)"
  );

  if (!to.ok) {
    log("FlyKhiva TO: Toshkent route tanlanmadi.");
    return false;
  }

  await sleep(1200);

  log(`FlyKhiva ROUTE OK: Sharm -> Toshkent | ${from.value} -> ${to.value}`);
  return true;
}

async function setDate(page, dateText) {
  const result = await page.evaluate(dateText => {
    const inputs = [...document.querySelectorAll("input")];

    const visible = inputs.filter(el => {
      const style = window.getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !el.disabled
      );
    });

    const candidates = visible.filter(el => {
      const info = [
        el.name || "",
        el.id || "",
        el.placeholder || "",
        el.className || "",
        el.getAttribute("aria-label") || ""
      ]
        .join(" ")
        .toLowerCase();

      return (
        el.type === "date" ||
        info.includes("checkin") ||
        info.includes("check") ||
        info.includes("date") ||
        info.includes("depart") ||
        info.includes("when") ||
        info.includes("дата") ||
        info.includes("когда")
      );
    });

    if (!candidates.length) {
      return { ok: false, reason: "DATE_INPUT_NOT_FOUND" };
    }

    const input = candidates[0];
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    ).set;

    setter.call(input, dateText);

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));

    return {
      ok: true,
      name: input.name,
      id: input.id,
      type: input.type,
      value: input.value
    };
  }, dateText);

  log(`FlyKhiva DATE SET ${dateText}:`, result);

  if (!result.ok) {
    throw new Error(`Sana input topilmadi: ${dateText}`);
  }

  await sleep(700);
}

async function clickSearch(page) {
  let clicked = false;

  const submit = page.locator("input[type='submit'].load").first();

  if (await submit.count()) {
    try {
      await submit.click();
      clicked = true;
      log("FlyKhiva SEARCH: submit.load");
    } catch (error) {
      log("submit.load bosilmadi:", error.message);
    }
  }

  if (!clicked) {
    const button = page.getByRole("button", {
      name: /искать|search/i
    });

    if (await button.count()) {
      await button.first().click();
      clicked = true;
      log("FlyKhiva SEARCH: button");
    }
  }

  if (!clicked) {
    throw new Error("Search tugmasi topilmadi.");
  }

  await sleep(4000);
}

function parsePrice(text) {
  const match = text.match(
    /([\d\s.,]+)\s*(UZS|USD|EUR|KZT|RUB|AZN)\b/i
  );

  if (!match) return null;

  return {
    amount: match[1].trim(),
    currency: match[2].toUpperCase()
  };
}

function parseFlightCards(cards) {
  const results = [];

  for (const card of cards) {
    const text = (card.text || "").trim();
    if (!text) continue;

    const lower = text.toLowerCase();

    if (lower.includes("нет мест")) {
      continue;
    }

    const hasSeats =
      lower.includes("есть места") ||
      lower.includes("места есть") ||
      lower.includes("мест мало");

    if (!hasSeats) continue;

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
      cardText: text
    });
  }

  return results;
}

async function readFlightResults(page) {
  const cards = await page
    .locator(".flight.flight-most-relevant")
    .evaluateAll(elements =>
      elements.map(element => ({
        text: element.innerText || ""
      }))
    );

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

  await sleep(1800);
  log(`FlyKhiva DATE PAGE URL: ${page.url()}`);

  const routeReady = await setRoute(page);

  if (!routeReady) {
    log(`FlyKhiva ROUTE YO'Q: ${dateText} — natija tekshirilmaydi.`);
    return;
  }

  await setDate(page, dateText);
  await clickSearch(page);

  const results = await readFlightResults(page);

  if (!results.length) {
    log(`JOY YO'Q: ${dateText}`);
    return;
  }

  for (const result of results) {
    const timeText =
      result.times.length >= 2
        ? `${result.times[0]} → ${result.times[1]}`
        : result.times.join(" → ");

    const numericAmount = result.price.amount.replace(/[^\d]/g, "");
    const formattedAmount = Number(numericAmount).toLocaleString("en-US");

    const message =
`🟢 HAQIQIY JOY BOR\n\n🏢 Sistema: FlyKhiva\n🛫 Yo'nalish: Sharm → Toshkent\n📅 Sana: ${result.date || dateText}\n✈️ Reys: ${result.flight || "Noma'lum"}\n🕐 Vaqt: ${timeText || "Noma'lum"}\n💺 Joy: BOR\n💰 Narx: ${formattedAmount} ${result.price.currency}`;

    log("HAQIQIY JOY TOPILDI");
    log(message);

    await sendTelegram(message);
  }
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

    if (!browser) {
      browser = await chromium.launch({ headless: true });
    }

    context = await browser.newContext();
    const page = await context.newPage();

    await login(page);

    const today = new Date();

    for (let i = 1; i <= 30; i++) {
      const date = addDays(today, i);

      try {
        await checkDate(page, date);
      } catch (error) {
        log(`Sana ${formatDate(date)} xato:`, error.message);
      }

      await sleep(1000);
    }
  } catch (error) {
    log("MONITOR XATO:", error.message);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    busy = false;
  }
}

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8"
    });
    res.end("FlyKhiva bot ishlayapti");
  })
  .listen(PORT, () => {
    log(`Health server: ${PORT}`);
  });

(async () => {
  await monitor();

  setInterval(() => {
    monitor().catch(error => {
      log("Interval monitor xato:", error.message);
    });
  }, POLL_SECONDS * 1000);
})();

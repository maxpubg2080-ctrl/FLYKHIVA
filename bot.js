const { chromium } = require("playwright");
const http = require("http");

const PORT = process.env.PORT || 10000;

const URL =
  process.env.FLYKHIVA_URL ||
  "https://b2b.flykhiva.travel/search_tour";

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
    log("Telegram ma'lumotlari yo'q.");
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
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
  await page.goto(`${URL}?samo_action=logon`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(1500);

  const loginInput = page
    .locator(
      "input[name='login'], input#login, input[type='text']"
    )
    .first();

  const passwordInput = page
    .locator(
      "input[name='password'], input#password, input[type='password']"
    )
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
  await sleep(2000);

  log("FlyKhiva LOGIN OK");
}

async function setSelectByOptionValue(page, value, leg) {
  const selectName =
    leg === "FROM" ? "TOWNFROMINC" : "TOWNTOINC";

  const select = page.locator(
    `select[name="${selectName}"]`
  );

  try {
    await select.waitFor({
      state: "visible",
      timeout: 15000
    });
  } catch {
    throw new Error(
      `${selectName} select topilmadi yoki ko'rinmayapti.`
    );
  }

  let found = false;

  for (let i = 0; i < 20; i++) {
    found = await select.evaluate(
      (el, value) => {
        return [...el.options].some(
          option => String(option.value) === String(value)
        );
      },
      value
    );

    if (found) break;

    await sleep(500);
  }

  if (!found) {
    const options = await select.evaluate(el =>
      [...el.options].map(option => ({
        value: option.value,
        text: option.textContent.trim()
      }))
    );

    log(`FlyKhiva ${leg} OPTIONS:`, options);

    throw new Error(
      `${selectName} ichida ${value} topilmadi.`
    );
  }

  await select.selectOption(String(value));

  await sleep(800);

  await select.evaluate(el => {
    el.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );

    el.dispatchEvent(
      new Event("change", {
        bubbles: true
      })
    );

    el.dispatchEvent(
      new Event("blur", {
        bubbles: true
      })
    );

    if (window.jQuery) {
      window.jQuery(el).trigger("change");
      window.jQuery(el).trigger("chosen:updated");
    }
  });

  const result = await select.evaluate(el => ({
    name: el.name,
    value: el.value,
    text:
      el.options[el.selectedIndex]?.textContent?.trim() || "",
    count: el.options.length
  }));

  log(`FlyKhiva ${leg}:`, {
    ok: true,
    ...result
  });

  return result;
}

async function setRoute(page) {
  await setSelectByOptionValue(
    page,
    FROM_VALUE,
    "FROM"
  );

  await sleep(1000);

  await setSelectByOptionValue(
    page,
    TO_VALUE,
    "TO"
  );

  await sleep(1000);

  log("FlyKhiva ROUTE OK: Sharm -> Toshkent");
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
        info.includes("from") ||
        info.includes("when") ||
        info.includes("дата") ||
        info.includes("когда")
      );
    });

    if (!candidates.length) {
      return {
        ok: false,
        reason: "DATE_INPUT_NOT_FOUND"
      };
    }

    const input = candidates[0];

    const setter =
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      ).set;

    setter.call(input, dateText);

    input.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );

    input.dispatchEvent(
      new Event("change", {
        bubbles: true
      })
    );

    input.dispatchEvent(
      new Event("blur", {
        bubbles: true
      })
    );

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
    throw new Error(
      `Sana input topilmadi: ${dateText}`
    );
  }

  await sleep(700);
}

async function clickSearch(page) {
  let clicked = false;

  const submit = page
    .locator("input[type='submit'].load")
    .first();

  if (await submit.count()) {
    try {
      await submit.click();
      clicked = true;
      log("FlyKhiva SEARCH: submit.load");
    } catch {}
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

  await sleep(3500);
}

function parsePrice(text) {
  const match = text.match(
    /([\d\s.,]+)\s*(UZS|USD|EUR|KZT|RUB|AZN)\b/i
  );

  if (!match) {
    return null;
  }

  return {
    amount: match[1].trim(),
    currency: match[2].toUpperCase()
  };
}

function parseFlightCards(cards) {
  const results = [];

  for (const card of cards) {
    const text = (card.text || "").trim();

    if (!text) {
      continue;
    }

    const lower = text.toLowerCase();

    // Eng muhim tekshiruv:
    // faqat karta ichida "есть места" bo'lsa joy bor deb hisoblaymiz.
    if (lower.includes("нет мест")) {
      continue;
    }

    const hasSeats =
      lower.includes("есть места") ||
      lower.includes("места есть");

    if (!hasSeats) {
      continue;
    }

    // Narx faqat aynan flight card ichidan olinadi.
    const price = parsePrice(text);

    if (!price) {
      continue;
    }

    const date =
      text.match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0] ||
      null;

    const flight =
      text.match(/\b[A-Z0-9]{2,3}-\d{3,5}\b/)?.[0] ||
      null;

    const times = [
      ...text.matchAll(/\b\d{2}:\d{2}\b/g)
    ].map(match => match[0]);

    results.push({
      date,
      flight,
      times,
      price
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

  log(
    `FlyKhiva flight cards: ${cards.length}`
  );

  return parseFlightCards(cards);
}

async function checkDate(page, date) {
  const dateText = formatDate(date);

  log("");
  log(
    `===== TEKSHIRILMOQDA: ${dateText} =====`
  );

  await page.goto(URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(1500);

  await setRoute(page);

  await setDate(page, dateText);

  await clickSearch(page);

  const results =
    await readFlightResults(page);

  if (!results.length) {
    log(`JOY YO'Q: ${dateText}`);
    return;
  }

  for (const result of results) {
    const timeText =
      result.times.length >= 2
        ? `${result.times[0]} → ${result.times[1]}`
        : result.times.join(" → ");

    const numericAmount =
      result.price.amount.replace(/[^\d]/g, "");

    const formattedAmount =
      Number(numericAmount).toLocaleString(
        "en-US"
      );

    const message =
`🟢 HAQIQIY JOY BOR

🏢 Sistema: FlyKhiva
🛫 Yo'nalish: Sharm → Toshkent
📅 Sana: ${result.date || dateText}
✈️ Reys: ${result.flight || "Noma'lum"}
🕐 Vaqt: ${timeText || "Noma'lum"}
💺 Joy: BOR
💰 Narx: ${formattedAmount} ${result.price.currency}`;

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
    if (!LOGIN) {
      throw new Error(
        "FLYKHIVA_LOGIN env mavjud emas."
      );
    }

    if (!PASSWORD) {
      throw new Error(
        "FLYKHIVA_PASSWORD env mavjud emas."
      );
    }

    if (!browser) {
      browser = await chromium.launch({
        headless: true
      });
    }

    context = await browser.newContext();

    const page = await context.newPage();

    await login(page);

    const today = new Date();

    // Keyingi 30 kunni tekshiramiz.
    for (let i = 1; i <= 30; i++) {
      const date = addDays(today, i);

      try {
        await checkDate(page, date);
      } catch (error) {
        log(
          `Sana ${formatDate(date)} xato:`,
          error.message
        );
      }

      await sleep(1000);
    }
  } catch (error) {
    log(
      "MONITOR XATO:",
      error.message
    );
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
      log(
        "Interval monitor xato:",
        error.message
      );
    });
  }, POLL_SECONDS * 1000);
})();

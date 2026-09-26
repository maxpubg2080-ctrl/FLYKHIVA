const { chromium } = require("playwright");
const http = require("http");

const PORT = process.env.PORT || 10000;

const URL = process.env.FLYKHIVA_URL || "https://b2b.flykhiva.travel/search_tour";
const LOGIN = process.env.FLYKHIVA_LOGIN;
const PASSWORD = process.env.FLYKHIVA_PASSWORD;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const FROM_VALUE = process.env.FROM_VALUE || "1178.16";
const TO_VALUE = process.env.TO_VALUE || "1853.14";

const FROM_TEXT = process.env.FROM_TEXT || "Sharm (SSH)";
const TO_TEXT = process.env.TO_TEXT || "Toshkent (TAS)";

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 300);

let browser;
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
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("Telegram env yo'q, xabar yuborilmadi.");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram xato: ${JSON.stringify(data)}`);
  }
}

async function setSelectByOptionValue(page, value, leg) {
  const result = await page.evaluate(({ value, leg }) => {
    const selects = [...document.querySelectorAll("select")];

    for (const select of selects) {
      const option = [...select.options].find(o => String(o.value) === String(value));

      if (!option) continue;

      select.value = String(value);

      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      select.dispatchEvent(new Event("blur", { bubbles: true }));

      if (window.jQuery) {
        window.jQuery(select).trigger("change");
        window.jQuery(select).trigger("chosen:updated");
      }

      return {
        ok: true,
        name: select.name,
        value: select.value,
        text: option.textContent.trim(),
        count: selects.length,
        leg
      };
    }

    return {
      ok: false,
      count: selects.length,
      leg
    };
  }, { value, leg });

  log(`FlyKhiva ${leg}:`, result);

  if (!result.ok) {
    throw new Error(`Yo'nalish ${leg} topilmadi: ${value}`);
  }

  return result;
}

async function setRoute(page) {
  await setSelectByOptionValue(page, FROM_VALUE, "FROM");
  await sleep(700);

  await setSelectByOptionValue(page, TO_VALUE, "TO");
  await sleep(700);

  log(`FlyKhiva ROUTE OK: ${FROM_TEXT} -> ${TO_TEXT}`);
}

async function setDate(page, dateText) {
  const result = await page.evaluate((dateText) => {
    const inputs = [...document.querySelectorAll("input")];

    const visible = inputs.filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" &&
             style.visibility !== "hidden" &&
             !el.disabled;
    });

    const candidates = visible.filter(el => {
      const all = [
        el.name || "",
        el.id || "",
        el.placeholder || "",
        el.className || "",
        el.getAttribute("aria-label") || ""
      ].join(" ").toLowerCase();

      return (
        el.type === "date" ||
        all.includes("checkin") ||
        all.includes("check") ||
        all.includes("date") ||
        all.includes("depart") ||
        all.includes("from") ||
        all.includes("when") ||
        all.includes("дата") ||
        all.includes("когда")
      );
    });

    const target = candidates[0];

    if (!target) {
      return {
        ok: false,
        inputs: inputs.length,
        visible: visible.length
      };
    }

    target.focus();

    const setter =
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      ).set;

    setter.call(target, dateText);

    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new Event("blur", { bubbles: true }));

    return {
      ok: true,
      name: target.name,
      id: target.id,
      type: target.type,
      value: target.value
    };
  }, dateText);

  log(`FlyKhiva DATE SET ${dateText}:`, result);

  if (!result.ok) {
    throw new Error(`Sana input topilmadi: ${dateText}`);
  }

  await sleep(500);
}

async function clickSearch(page) {
  let clicked = false;

  const submit = page.locator("input[type='submit'].load").first();

  if (await submit.count()) {
    try {
      await submit.click();
      clicked = true;
      log("FlyKhiva SEARCH: submit.load");
    } catch {}
  }

  if (!clicked) {
    const buttons = page.getByRole("button", {
      name: /искать|search/i
    });

    if (await buttons.count()) {
      await buttons.first().click();
      clicked = true;
      log("FlyKhiva SEARCH: button");
    }
  }

  if (!clicked) {
    throw new Error("Search tugmasi topilmadi.");
  }

  await sleep(3000);
}

function parsePrice(text) {
  const match = text.match(
    /([\d\s.,]+)\s*(UZS|USD|EUR|KZT|RUB|AZN)\b/i
  );

  if (!match) return null;

  const amount = match[1].replace(/\s/g, "");

  return {
    amount,
    currency: match[2].toUpperCase()
  };
}

function parseFlightCards(cards) {
  const results = [];

  for (const card of cards) {
    const text = card.text;

    if (!text) continue;

    const lower = text.toLowerCase();

    if (lower.includes("нет мест")) {
      continue;
    }

    const available =
      lower.includes("есть места") ||
      lower.includes("места есть") ||
      lower.includes("few seats") ||
      lower.includes("available");

    if (!available) {
      continue;
    }

    const price = parsePrice(text);

    if (!price) {
      continue;
    }

    const date =
      text.match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0] || null;

    const flight =
      text.match(/\b[A-Z0-9]{2,3}-\d{3,5}\b/)?.[0] || null;

    const times = [...text.matchAll(/\b\d{2}:\d{2}\b/g)].map(m => m[0]);

    results.push({
      date,
      flight,
      times,
      price,
      text
    });
  }

  return results;
}

async function readResults(page) {
  const cards = await page.locator(".flight.flight-most-relevant").evaluateAll(
    els =>
      els.map(el => ({
        text: el.innerText || ""
      }))
  );

  log(`FlyKhiva flight cards: ${cards.length}`);

  const results = parseFlightCards(cards);

  return results;
}

async function login(page) {
  await page.goto(`${URL}?samo_action=logon`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(1500);

  const loginInput = page.locator(
    "input[name='login'], input#login, input[type='text']"
  ).first();

  const passwordInput = page.locator(
    "input[name='password'], input#password, input[type='password']"
  ).first();

  if (!await loginInput.count()) {
    throw new Error("Login input topilmadi.");
  }

  if (!await passwordInput.count()) {
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

async function checkOneDate(page, date) {
  const dateText = formatDate(date);

  log(`\n===== TEKSHIRILMOQDA: ${dateText} =====`);

  await page.goto(URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await sleep(1000);

  await setRoute(page);
  await setDate(page, dateText);
  await clickSearch(page);

  const results = await readResults(page);

  if (!results.length) {
    log(`JOY YO'Q: ${dateText}`);
    return;
  }

  for (const item of results) {
    log("HAQIQIY JOY TOPILDI:", item);

    const timeText =
      item.times.length >= 2
        ? `${item.times[0]} → ${item.times[1]}`
        : item.times.join(" → ");

    const amountFormatted = Number(
      item.price.amount.replace(",", ".")
    ).toLocaleString("en-US");

    const message =
`🟢 HAQIQIY JOY BOR

🏢 Sistema: FlyKhiva
🛫 Yo'nalish: Sharm → Toshkent
📅 Sana: ${item.date || dateText}
✈️ Reys: ${item.flight || "Noma'lum"}
🕐 Vaqt: ${timeText || "Noma'lum"}
💺 Joy: BOR
💰 Narx: ${amountFormatted} ${item.price.currency}`;

    await sendTelegram(message);
  }
}

async function monitor() {
  if (busy) {
    log("Oldingi tekshiruv hali tugamagan.");
    return;
  }

  busy = true;

  try {
    if (!LOGIN || !PASSWORD) {
      throw new Error("FLYKHIVA_LOGIN yoki FLYKHIVA_PASSWORD yo'q.");
    }

    if (!browser) {
      browser = await chromium.launch({
        headless: true
      });
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    await login(page);

    const today = new Date();

    for (let i = 1; i <= 30; i++) {
      const date = addDays(today, i);

      try {
        await checkOneDate(page, date);
      } catch (err) {
        log(`Sana ${formatDate(date)} xato:`, err.message);
      }

      await sleep(800);
    }

    await context.close();
  } catch (err) {
    log("MONITOR XATO:", err.message);
  } finally {
    busy = false;
  }
}

http.createServer((req, res) => {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8"
  });

  res.end("FlyKhiva bot ishlayapti");
}).listen(PORT, () => {
  log(`Health server: ${PORT}`);
});

(async () => {
  await monitor();

  setInterval(() => {
    monitor().catch(err => log(err));
  }, POLL_SECONDS * 1000);
})();

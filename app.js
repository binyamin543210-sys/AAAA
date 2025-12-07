// =======================
// הגדרות בסיס
// =======================

// שים כאן מפתח OpenWeatherMap שלך
const OPEN_WEATHER_KEY = "PUT_OPEN_WEATHER_KEY_HERE";

// הגדרת ברירת מחדל לעיר (אפשר לשנות מהאפליקציה)
const DEFAULT_CITY = {
  name: "Jerusalem, IL",
  lat: 31.778,
  lon: 35.235,
  tzid: "Asia/Jerusalem"
};

// מיפוי שמות חודשים לועזיים
const GREG_MONTH_NAMES = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר"
];

// מזהי משתמשים
const OWNERS = {
  benjamin: { label: "בנימין", className: "benjamin" },
  nana: { label: "ננה", className: "nana" },
  both: { label: "משותף", className: "both" }
};

// אחסון מקומי לאירועים והגדרות
const STORAGE_KEY_EVENTS = "bg_calendar_events_v1";
const STORAGE_KEY_SETTINGS = "bg_calendar_settings_v1";

// מצב גלובלי
const state = {
  today: new Date(),
  currentMonth: null,
  currentYear: null,
  selectedDate: null,
  city: DEFAULT_CITY,
  hebrewDatesCache: {}, // "YYYY-MM" -> מפה של day->heDayText
  jewishMetaCache: {},  // "YYYY-MM" -> פרטי כניסת/יציאת שבת וחגים
  events: {},           // "YYYY-MM-DD" -> מערך אירועים
  editingEventId: null
};

// עוזר להחזיר תאריך נטו (שעה 00:00)
function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// הפיכת תאריך למחרוזת ISO YYYY-MM-DD
function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// =======================
// טעינה ושמירה ל-localStorage
// =======================

function loadFromStorage() {
  try {
    const evRaw = localStorage.getItem(STORAGE_KEY_EVENTS);
    if (evRaw) {
      state.events = JSON.parse(evRaw);
    }
  } catch (e) {
    console.error("אירועים: שגיאה בקריאת localStorage", e);
  }

  try {
    const sRaw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (sRaw) {
      const s = JSON.parse(sRaw);
      if (s.city) state.city = s.city;
      if (s.theme === "light") {
        document.body.classList.remove("dark");
        document.body.classList.add("light");
      }
    }
  } catch (e) {
    console.error("הגדרות: שגיאה בקריאת localStorage", e);
  }
}

function saveEvents() {
  try {
    localStorage.setItem(STORAGE_KEY_EVENTS, JSON.stringify(state.events));
  } catch (e) {
    console.error("אירועים: שגיאה בשמירה", e);
  }
}

function saveSettings() {
  try {
    const settings = {
      city: state.city,
      theme: document.body.classList.contains("light") ? "light" : "dark"
    };
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error("הגדרות: שגיאה בשמירה", e);
  }
}

// =======================
// Hebcal APIs – תאריכים עבריים + חגים + שבת
// =======================

async function fetchHebrewForMonth(year, monthIndex) {
  const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  if (state.hebrewDatesCache[key] && state.jewishMetaCache[key]) {
    return;
  }

  const firstDay = new Date(year, monthIndex, 1);
  const lastDay = new Date(year, monthIndex + 1, 0);
  const start = toIsoDate(firstDay);
  const end = toIsoDate(lastDay);

  // 1) המרת כל התאריכים לחודש העברי
  const convUrl = `https://www.hebcal.com/converter?cfg=json&g2h=1&start=${start}&end=${end}`;
  // 2) קבלת לוח שנה – חגים, כניסת שבת ויציאת שבת
  const calUrl = `https://www.hebcal.com/hebcal?v=1&cfg=json&start=${start}&end=${end}&maj=on&min=on&mod=on&nx=on&ss=on&mf=on&c=on&geo=pos&latitude=${state.city.lat}&longitude=${state.city.lon}&tzid=${encodeURIComponent(
    state.city.tzid
  )}&M=on&s=on`;

  try {
    const [convRes, calRes] = await Promise.all([fetch(convUrl), fetch(calUrl)]);
    const conv = await convRes.json();
    const cal = await calRes.json();

    const hebrewByDay = {};
    if (Array.isArray(conv.items)) {
      conv.items.forEach((item) => {
        if (!item.date || !item.hebrew) return;
        const d = new Date(item.date);
        if (d.getMonth() !== monthIndex) return;
        const day = d.getDate();
        const parts = item.hebrew.split(" ");
        hebrewByDay[day] = parts[0] || item.hebrew;
      });
    }

    const metaByIso = {};
    if (Array.isArray(cal.items)) {
      cal.items.forEach((item) => {
        if (!item.date || !item.category) return;
        const iso = item.date.substring(0, 10);
        if (!metaByIso[iso]) metaByIso[iso] = { candles: null, havdalah: null, holiday: [] };
        if (item.category === "candles") {
          metaByIso[iso].candles = item;
        } else if (item.category === "havdalah") {
          metaByIso[iso].havdalah = item;
        } else if (item.category === "holiday" || item.category === "chag") {
          metaByIso[iso].holiday.push(item);
        }
      });
    }

    state.hebrewDatesCache[key] = hebrewByDay;
    state.jewishMetaCache[key] = metaByIso;
  } catch (e) {
    console.error("שגיאה בשליפת נתוני Hebcal", e);
  }
}

// =======================
// OpenWeather – מזג אוויר
// =======================

async function fetchWeather(lat, lon) {
  if (!OPEN_WEATHER_KEY || OPEN_WEATHER_KEY === "PUT_OPEN_WEATHER_KEY_HERE") {
    return null;
  }
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OPEN_WEATHER_KEY}&units=metric&lang=he`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.error("שגיאה בשליפת מזג אוויר", e);
    return null;
  }
}

function weatherEmoji(main, description) {
  const text = (description || main || "").toLowerCase();
  if (text.includes("thunder")) return "⛈️";
  if (text.includes("snow")) return "❄️";
  if (text.includes("rain") || text.includes("shower")) return "🌧️";
  if (text.includes("drizzle")) return "🌦️";
  if (text.includes("cloud")) return "☁️";
  if (text.includes("mist") || text.includes("fog")) return "🌫️";
  return "☀️";
}

// =======================
// אירועים – יצירה / מחיקה
// =======================

function getEventsForDate(isoDate, { includeAuto = true } = {}) {
  const list = state.events[isoDate] || [];
  if (includeAuto) return list;
  return list.filter((e) => !e.auto);
}

function addOrUpdateEvent(event) {
  const dateKey = event.date;
  if (!state.events[dateKey]) state.events[dateKey] = [];
  const idx = state.events[dateKey].findIndex((e) => e.id === event.id);
  if (idx >= 0) {
    state.events[dateKey][idx] = event;
  } else {
    state.events[dateKey].push(event);
  }
  saveEvents();
}

function deleteEventById(id, date) {
  const key = date;
  const list = state.events[key] || [];
  const filtered = list.filter((e) => e.id !== id);
  state.events[key] = filtered;
  saveEvents();
}

// יצירת אירועי עבודה ואוכל/מקלחת אוטומטיים
function injectAutoEventsForDate(isoDate) {
  const d = new Date(isoDate);
  const weekday = d.getDay(); // 0=Sunday
  // ימים ראשון-חמישי = 0..4
  if (weekday >= 0 && weekday <= 4) {
    const list = state.events[isoDate] || [];
    const hasWork = list.some((e) => e.auto && e.autoType === "work");
    const hasFood = list.some((e) => e.auto && e.autoType === "food");

    if (!hasWork) {
      list.push({
        id: `auto-work-${isoDate}`,
        auto: true,
        autoType: "work",
        kind: "event",
        owner: "both",
        title: "עבודה",
        date: isoDate,
        start: "08:00",
        end: "17:00",
        address: "",
        reminderEnabled: false,
        reminderMinutes: 60
      });
    }

    if (!hasFood) {
      list.push({
        id: `auto-food-${isoDate}`,
        auto: true,
        autoType: "food",
        kind: "event",
        owner: "both",
        title: "אוכל ומקלחת",
        date: isoDate,
        start: "17:00",
        end: "18:30",
        address: "",
        reminderEnabled: false,
        reminderMinutes: 60
      });
    }

    state.events[isoDate] = list;
  }
}

// =======================
// UI – בניית לוח חודשי
// =======================

async function renderMonth(year, monthIndex) {
  const grid = document.getElementById("calendar-grid");
  const gregLabel = document.getElementById("greg-month-label");
  const hebrewLabel = document.getElementById("hebrew-month-label");

  state.currentYear = year;
  state.currentMonth = monthIndex;

  gregLabel.textContent = `${GREG_MONTH_NAMES[monthIndex]} ${year}`;
  hebrewLabel.textContent = ""; // נעדכן עם שם החודש העברי הראשי מתוך Hebcal

  grid.innerHTML = "";

  await fetchHebrewForMonth(year, monthIndex);

  const hebKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const hebrewByDay = state.hebrewDatesCache[hebKey] || {};
  const metaByIso = state.jewishMetaCache[hebKey] || {};

  // למצוא את שם החודש העברי הראשון מתוך meta (חג/ראש חודש)
  const metaValues = Object.values(metaByIso);
  if (metaValues.length > 0) {
    // נשאיר ריק – שם החודש העברי המלא עלול להיות שונה (חודש מעובר וכו')
  }

  const firstOfMonth = new Date(year, monthIndex, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // ניישר לימין
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const prevMonthDays = firstWeekday;
  const totalCells = Math.ceil((prevMonthDays + daysInMonth) / 7) * 7;

  const todayIso = toIsoDate(state.today);

  for (let cellIndex = 0; cellIndex < totalCells; cellIndex++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day";

    const dayOffset = cellIndex - prevMonthDays + 1;
    let cellDate;
    let inCurrentMonth = true;

    if (dayOffset <= 0) {
      cellDate = new Date(year, monthIndex, dayOffset);
      inCurrentMonth = false;
    } else if (dayOffset > daysInMonth) {
      cellDate = new Date(year, monthIndex, dayOffset);
      inCurrentMonth = false;
    } else {
      cellDate = new Date(year, monthIndex, dayOffset);
    }

    const iso = toIsoDate(cellDate);
    const dayNum = cellDate.getDate();

    if (!inCurrentMonth) {
      cell.classList.add("outside");
    }

    if (iso === todayIso) {
      cell.classList.add("today");
    }

    // יצירת אירועים אוטומטיים (אם צריך)
    injectAutoEventsForDate(iso);

    const eventsList = getEventsForDate(iso, { includeAuto: true });
    const userEvents = getEventsForDate(iso, { includeAuto: false });

    // חישוב האם יש יותר משני אירועים/משימות (לא כולל אוטומטיים)
    if (userEvents.length > 2) {
      cell.classList.add("busy");
    }

    const header = document.createElement("div");
    header.className = "day-header";

    const gregSpan = document.createElement("div");
    gregSpan.className = "day-greg";
    gregSpan.textContent = dayNum;

    const hebSpan = document.createElement("div");
    hebSpan.className = "day-hebrew";
    hebSpan.textContent = inCurrentMonth ? (hebrewByDay[dayNum] || "") : "";

    header.appendChild(gregSpan);
    header.appendChild(hebSpan);

    const badges = document.createElement("div");
    badges.className = "day-badges";

    const meta = metaByIso[iso];
    if (meta && meta.candles) {
      const b = document.createElement("div");
      b.className = "badge-shabbat";
      b.innerHTML = `🕯️ <span>כניסת שבת:</span> <span class="time">${timeOnly(meta.candles.date)}</span>`;
      badges.appendChild(b);
    }
    if (meta && meta.havdalah) {
      const b = document.createElement("div");
      b.className = "badge-shabbat";
      b.innerHTML = `✨ <span>יציאת שבת:</span> <span class="time">${timeOnly(meta.havdalah.date)}</span>`;
      badges.appendChild(b);
    }

    header.appendChild(badges);

    const content = document.createElement("div");
    content.className = "day-content";
    const preview = document.createElement("div");
    preview.className = "day-events-preview";

    const ownersSeen = new Set();
    userEvents.forEach((ev) => {
      if (!ownersSeen.has(ev.owner)) {
        ownersSeen.add(ev.owner);
        const dot = document.createElement("div");
        dot.className = `event-dot ${ev.owner}`;
        preview.appendChild(dot);
      }
    });

    content.appendChild(preview);

    cell.appendChild(header);
    cell.appendChild(content);

    cell.addEventListener("click", () => openDayModal(cellDate));

    grid.appendChild(cell);
  }
}

// חילוץ שעה ממחרוזת תאריך עם זמן ISO
function timeOnly(dtString) {
  try {
    const d = new Date(dtString);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "";
  }
}

// =======================
// מודאל יום
// =======================

let lastOpenedDate = null;

function openDayModal(date) {
  const modal = document.getElementById("day-modal");
  const gregEl = document.getElementById("modal-date-greg");
  const hebEl = document.getElementById("modal-date-hebrew");
  const listEl = document.getElementById("day-events-list");
  const weatherStrip = document.getElementById("modal-weather-strip");

  const iso = toIsoDate(date);
  lastOpenedDate = iso;

  gregEl.textContent = iso.split("-").reverse().join(".");
  hebEl.textContent = "";

  listEl.innerHTML = "";
  weatherStrip.innerHTML = "";

  const events = getEventsForDate(iso, { includeAuto: true }).slice();
  events.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "event-item";
    empty.textContent = "אין אירועים/משימות ליום זה";
    listEl.appendChild(empty);
  } else {
    events.forEach((ev) => {
      const item = document.createElement("div");
      item.className = "event-item";
      if (ev.auto) {
        item.style.opacity = "0.8";
      }

      const header = document.createElement("div");
      header.className = "event-header-row";

      const title = document.createElement("div");
      title.className = "event-title";
      title.textContent = ev.title;

      const time = document.createElement("div");
      time.className = "event-time";
      time.textContent = ev.start && ev.end ? `${ev.start}–${ev.end}` : ev.start || "";

      header.appendChild(title);
      header.appendChild(time);

      const meta = document.createElement("div");
      meta.className = "event-kind-label";

      if (!ev.auto) {
        const ownerChip = document.createElement("span");
        ownerChip.className = `event-owner-chip event-owner-${ev.owner}`;
        ownerChip.textContent = OWNERS[ev.owner]?.label || "";
        meta.appendChild(ownerChip);
        const kindSpan = document.createElement("span");
        kindSpan.textContent = ev.kind === "task" ? " · משימה" : " · אירוע";
        meta.appendChild(kindSpan);
      } else {
        meta.textContent = ev.autoType === "work" ? "אירוע קבוע: עבודה" : "אירוע קבוע: אוכל ומקלחת";
      }

      item.appendChild(header);
      item.appendChild(meta);

      if (ev.address) {
        const addr = document.createElement("div");
        addr.style.fontSize = "0.75rem";
        addr.style.color = "var(--text-subtle)";
        addr.textContent = ev.address;
        item.appendChild(addr);

        const wazeLink = document.createElement("a");
        wazeLink.href = `https://waze.com/ul?q=${encodeURIComponent(ev.address)}`;
        wazeLink.target = "_blank";
        wazeLink.rel = "noopener";
        wazeLink.style.fontSize = "0.75rem";
        wazeLink.style.marginTop = "2px";
        wazeLink.textContent = "פתח ב-Waze";
        item.appendChild(wazeLink);
      }

      if (!ev.auto) {
        item.addEventListener("click", () => openEventModal(iso, ev));
      }

      listEl.appendChild(item);
    });
  }

  const eventDate = new Date(iso);
  const hebKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}`;
  const hebMap = state.hebrewDatesCache[hebKey] || {};
  const hebDay = hebMap[eventDate.getDate()];
  if (hebDay) hebEl.textContent = hebDay;

  modal.classList.remove("hidden");

  const dateInput = document.getElementById("event-date");
  dateInput.value = iso;
}

// =======================
// מודאל אירוע – חדש / עריכה
// =======================

function openEventModal(isoDate, event = null) {
  const modal = document.getElementById("event-modal");
  const form = document.getElementById("event-form");
  const deleteBtn = document.getElementById("delete-event-btn");

  form.reset();
  state.editingEventId = null;

  document.querySelectorAll("input[name='kind'][value='event']").forEach((el) => (el.checked = true));
  document.querySelectorAll("input[name='owner'][value='benjamin']").forEach((el) => (el.checked = true));

  document.getElementById("event-date").value = isoDate;
  document.getElementById("event-start").value = "18:00";
  document.getElementById("event-end").value = "19:00";
  document.getElementById("event-reminder-toggle").checked = true;
  document.getElementById("event-reminder-mins").value = "60";

  deleteBtn.classList.add("hidden");

  if (event) {
    state.editingEventId = event.id;
    document.getElementById("event-title").value = event.title || "";
    document.getElementById("event-date").value = event.date;
    document.getElementById("event-start").value = event.start || "";
    document.getElementById("event-end").value = event.end || "";
    document.getElementById("event-address").value = event.address || "";
    document.getElementById("event-reminder-toggle").checked = !!event.reminderEnabled;
    document.getElementById("event-reminder-mins").value = String(event.reminderMinutes || 60);

    document.querySelectorAll(`input[name='kind'][value='${event.kind}']`).forEach((el) => (el.checked = true));
    document.querySelectorAll(`input[name='owner'][value='${event.owner}']`).forEach((el) => (el.checked = true));

    if (!event.auto) {
      deleteBtn.classList.remove("hidden");
      deleteBtn.onclick = () => {
        deleteEventById(event.id, event.date);
        modal.classList.add("hidden");
        renderMonth(state.currentYear, state.currentMonth);
      };
    }
  }

  modal.classList.remove("hidden");
}

function handleEventFormSubmit(e) {
  e.preventDefault();
  const form = e.target;

  const id = state.editingEventId || `ev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const kind = form.elements["kind"].value;
  const owner = form.elements["owner"].value;
  const title = form.elements["title"].value.trim();
  const date = form.elements["date"].value;
  const start = form.elements["start"].value;
  const end = form.elements["end"].value;
  const address = form.elements["address"].value.trim();
  const reminderEnabled = document.getElementById("event-reminder-toggle").checked;
  const reminderMinutes = parseInt(document.getElementById("event-reminder-mins").value, 10);

  if (!title || !date) return;

  const event = {
    id,
    auto: false,
    autoType: null,
    kind,
    owner,
    title,
    date,
    start,
    end,
    address,
    reminderEnabled,
    reminderMinutes
  };

  addOrUpdateEvent(event);
  scheduleReminder(event);

  document.getElementById("event-modal").classList.add("hidden");
  renderMonth(state.currentYear, state.currentMonth);

  if (lastOpenedDate === date) {
    openDayModal(new Date(date));
  }
}

// =======================
// תזכורות (Notification API / setTimeout)
// =======================

function scheduleReminder(event) {
  if (!("Notification" in window)) return;
  if (!event.reminderEnabled) return;
  if (!event.start) return;

  const [hh, mm] = event.start.split(":").map((s) => parseInt(s, 10));
  const eventDate = new Date(event.date);
  eventDate.setHours(hh, mm, 0, 0);

  const when = eventDate.getTime() - event.reminderMinutes * 60 * 1000;
  const now = Date.now();
  const delay = when - now;

  if (delay <= 0 || delay > 1000 * 60 * 60 * 24 * 7) {
    return;
  }

  Notification.requestPermission().then((perm) => {
    if (perm !== "granted") return;
    setTimeout(() => {
      new Notification(event.title, {
        body: `${event.kind === "task" ? "משימה" : "אירוע"} ב-${event.start}`,
        tag: event.id
      });
    }, delay);
  });
}

function scheduleAllReminders() {
  Object.values(state.events).forEach((list) => {
    list.forEach((ev) => {
      if (!ev.auto) scheduleReminder(ev);
    });
  });
}

// =======================
// זמן חופשי
// =======================

function calcFreeTimeForDate(isoDate) {
  const events = getEventsForDate(isoDate, { includeAuto: true }).slice();
  if (!events.length) {
    return [{ start: "00:00", end: "23:59" }];
  }
  const ranges = events
    .filter((e) => e.start && e.end)
    .map((e) => ({
      start: e.start,
      end: e.end
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  const toMin = (t) => {
    const [h, m] = t.split(":").map((x) => parseInt(x, 10));
    return h * 60 + m;
  };
  const toStr = (mins) => {
    const h = String(Math.floor(mins / 60)).padStart(2, "0");
    const m = String(mins % 60).padStart(2, "0");
    return `${h}:${m}`;
  };

  const merged = [];
  let curr = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const r = ranges[i];
    if (toMin(r.start) <= toMin(curr.end)) {
      if (toMin(r.end) > toMin(curr.end)) curr.end = r.end;
    } else {
      merged.push(curr);
      curr = r;
    }
  }
  merged.push(curr);

  const free = [];
  let prevEnd = 0;
  merged.forEach((r) => {
    const startM = toMin(r.start);
    if (startM > prevEnd) {
      free.push({ start: toStr(prevEnd), end: toStr(startM) });
    }
    prevEnd = Math.max(prevEnd, toMin(r.end));
  });
  if (prevEnd < 24 * 60 - 1) {
    free.push({ start: toStr(prevEnd), end: "23:59" });
  }
  return free;
}

function openFreeTimeModal() {
  const iso = lastOpenedDate || toIsoDate(state.today);
  const modal = document.getElementById("free-time-modal");
  const content = document.getElementById("free-time-content");
  content.innerHTML = "";

  const title = document.createElement("div");
  title.style.marginBottom = "6px";
  title.textContent = `זמן חופשי ל-${iso.split("-").reverse().join(".")}`;
  content.appendChild(title);

  const free = calcFreeTimeForDate(iso);
  if (!free.length) {
    content.textContent = "אין זמן פנוי – כל היום מלא אירועים.";
  } else {
    const ul = document.createElement("ul");
    ul.style.paddingRight = "18px";
    free.forEach((slot) => {
      const li = document.createElement("li");
      li.textContent = `${slot.start}–${slot.end}`;
      ul.appendChild(li);
    });
    content.appendChild(ul);
  }

  modal.classList.remove("hidden");
}

// =======================
// משימות לחודש קדימה
// =======================

function openTasksModal() {
  const modal = document.getElementById("tasks-modal");
  const container = document.getElementById("tasks-container");
  container.innerHTML = "";

  const now = stripTime(new Date());
  const maxDate = new Date(now);
  maxDate.setMonth(maxDate.getMonth() + 1);

  const tasks = [];

  Object.entries(state.events).forEach(([iso, list]) => {
    const d = new Date(iso);
    if (d < now || d > maxDate) return;
    list.forEach((ev) => {
      if (ev.auto) return;
      if (ev.kind !== "task") return;
      tasks.push({ date: iso, ev });
    });
  });

  tasks.sort((a, b) => a.date.localeCompare(b.date) || (a.ev.start || "").localeCompare(b.ev.start || ""));

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "task-item";
    empty.textContent = "אין משימות בחודש הקרוב";
    container.appendChild(empty);
  } else {
    tasks.forEach(({ date, ev }) => {
      const item = document.createElement("div");
      item.className = "task-item";
      item.innerHTML = `<strong>${ev.title}</strong><br>${date.split("-").reverse().join(".")} ${
        ev.start || ""
      }<br>${OWNERS[ev.owner]?.label || ""}`;
      container.appendChild(item);
    });
  }

  modal.classList.remove("hidden");
}

// =======================
// מזג אוויר – מודאלים
// =======================

async function showDayWeather() {
  const iso = lastOpenedDate || toIsoDate(state.today);
  const weatherStrip = document.getElementById("modal-weather-strip");
  weatherStrip.innerHTML = "טוען מזג אוויר...";

  const data = await fetchWeather(state.city.lat, state.city.lon);
  if (!data) {
    weatherStrip.textContent = "לא הוגדר מפתח OpenWeather או שיש שגיאת רשת.";
    return;
  }
  renderWeatherStrip(weatherStrip, data, iso);
}

async function showGlobalWeatherToday() {
  const modal = document.getElementById("global-weather-modal");
  const content = document.getElementById("global-weather-content");
  content.innerHTML = "טוען מזג אוויר...";

  const data = await fetchWeather(state.city.lat, state.city.lon);
  if (!data) {
    content.textContent = "לא הוגדר מפתח OpenWeather או שיש שגיאת רשת.";
  } else {
    renderWeatherStrip(content, data, toIsoDate(state.today));
  }
  modal.classList.remove("hidden");
}

function renderWeatherStrip(container, data, iso) {
  container.innerHTML = "";
  const main = data.weather?.[0]?.main || "";
  const desc = data.weather?.[0]?.description || "";
  const temp = data.main?.temp;
  const feels = data.main?.feels_like;
  const humidity = data.main?.humidity;
  const wind = data.wind?.speed;
  const emoji = weatherEmoji(main, desc);

  const title = document.createElement("div");
  title.textContent = `מזג האוויר ל-${iso.split("-").reverse().join(".")} בעיר ${state.city.name}`;
  container.appendChild(title);

  const row = document.createElement("div");
  row.className = "weather-row-main";

  const left = document.createElement("div");
  left.textContent = `${emoji} ${desc}`;
  row.appendChild(left);

  const right = document.createElement("div");
  right.className = "weather-temp";
  right.textContent = temp != null ? `${Math.round(temp)}°` : "";
  row.appendChild(right);

  container.appendChild(row);

  const extra = document.createElement("div");
  extra.className = "weather-extra";
  if (feels != null) extra.innerHTML += `<span>מרגיש כמו ${Math.round(feels)}°</span>`;
  if (humidity != null) extra.innerHTML += `<span>לחות ${humidity}%</span>`;
  if (wind != null) extra.innerHTML += `<span>רוח ${wind.toFixed(1)} מ׳/ש'</span>`;
  container.appendChild(extra);
}

// =======================
// אתחול
// =======================

function setupEventListeners() {
  document.getElementById("prev-month").addEventListener("click", () => {
    const m = state.currentMonth - 1;
    if (m < 0) {
      renderMonth(state.currentYear - 1, 11);
    } else {
      renderMonth(state.currentYear, m);
    }
  });

  document.getElementById("next-month").addEventListener("click", () => {
    const m = state.currentMonth + 1;
    if (m > 11) {
      renderMonth(state.currentYear + 1, 0);
    } else {
      renderMonth(state.currentYear, m);
    }
  });

  document.getElementById("today-btn").addEventListener("click", () => {
    const t = state.today;
    renderMonth(t.getFullYear(), t.getMonth());
  });

  document.getElementById("theme-toggle-input").addEventListener("change", (e) => {
    if (e.target.checked) {
      document.body.classList.remove("light");
      document.body.classList.add("dark");
    } else {
      document.body.classList.remove("dark");
      document.body.classList.add("light");
    }
    saveSettings();
  });

  document.getElementById("city-save-btn").addEventListener("click", () => {
    const input = document.getElementById("city-input");
    const name = input.value.trim();
    if (!name) return;
    // לצורך פשטות נשמור רק את השם, ואת הקואורדינטות המשתמש יעדכן בקוד לפי העיר שלו אם צריך
    state.city.name = name;
    saveSettings();
    alert("נשמרה העיר. אם תרצה דיוק מלא, עדכן בקוד את lat/lon/tzid.");
  });

  document.getElementById("floating-add-btn").addEventListener("click", () => {
    const iso = lastOpenedDate || toIsoDate(state.today);
    openEventModal(iso);
  });

  document.getElementById("modal-add-event").addEventListener("click", () => {
    const iso = lastOpenedDate || toIsoDate(state.today);
    openEventModal(iso);
  });

  document.getElementById("close-day-modal").addEventListener("click", () => {
    document.getElementById("day-modal").classList.add("hidden");
  });

  document.getElementById("close-event-modal").addEventListener("click", () => {
    document.getElementById("event-modal").classList.add("hidden");
  });

  document.getElementById("cancel-event-btn").addEventListener("click", () => {
    document.getElementById("event-modal").classList.add("hidden");
  });

  document.getElementById("event-form").addEventListener("submit", handleEventFormSubmit);

  document.getElementById("tasks-btn").addEventListener("click", openTasksModal);
  document.getElementById("close-tasks-modal").addEventListener("click", () => {
    document.getElementById("tasks-modal").classList.add("hidden");
  });

  document.getElementById("free-time-btn").addEventListener("click", openFreeTimeModal);
  document.getElementById("close-free-time-modal").addEventListener("click", () => {
    document.getElementById("free-time-modal").classList.add("hidden");
  });

  document.getElementById("modal-weather-btn").addEventListener("click", showDayWeather);
  document.getElementById("global-weather-btn").addEventListener("click", showGlobalWeatherToday);
  document.getElementById("close-global-weather-modal").addEventListener("click", () => {
    document.getElementById("global-weather-modal").classList.add("hidden");
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  loadFromStorage();

  const cityInput = document.getElementById("city-input");
  cityInput.value = state.city.name;

  const themeToggle = document.getElementById("theme-toggle-input");
  themeToggle.checked = !document.body.classList.contains("light");

  setupEventListeners();

  const t = state.today;
  await renderMonth(t.getFullYear(), t.getMonth());

  scheduleAllReminders();
});

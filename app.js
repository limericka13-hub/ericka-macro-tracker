/**
 * Macro Tracker & Meal Builder
 * - Direct Supabase Cloud Database Fetching & Sync
 * - Week Strip Day Picker with Fold-Out Macro Bars
 * - Daily Macro Subtotals & Real-Time Progress
 * - Custom Meal Builder & Favorites Combo Picker
 * - Searchable Past History Logs
 * - Debounced Food Search
 * - Smart Same-Day Grouping & Merging
 * - Strict DD/MM/YYYY Date Formatting
 */

// Supplied by config.js, which loads first. Held as a reference rather than a
// copy because saveCustomSupabaseConfig() reassigns CONFIG.SUPABASE_URL and
// .SUPABASE_ANON_KEY in place before re-initialising the client.
const CONFIG = window.APP_CONFIG;

const ACTIVE_DRAFT_UUID = '00000000-0000-0000-0000-000000000001';
const LOCAL_MIRROR_KEY = 'macroLocalMirror.v1';
// The half-built meal, parked in the same table as the day draft under its
// own id so it syncs across devices without a schema change.
const BUILDER_DRAFT_UUID = '00000000-0000-0000-0000-000000000002';
// Calorie carries and planned high/low days, parked the same way.
const CARRIES_UUID = '00000000-0000-0000-0000-000000000003';
// A carry that would take a day's target below this gets a warning.
const CARRY_FLOOR_KCAL = 1200;
// Each food's serving type (per 100 ml, per slice...), parked the same way.
// { foodId: unit } for every food not measured in grams, or
// { foodId: { unit, qty } } when its serving is not a whole number - kept
// here exactly, whatever the food table's Quantity column can hold.
const FOOD_UNITS_UUID = '00000000-0000-0000-0000-000000000004';

// The serving types a food can be measured in. A food's macros are quoted per
// `Quantity` of its unit, and every amount logged against it is in that unit
// too - so the arithmetic is the same for all of them, only the names change.
// `base` is the serving a new food starts at; `count` units (a slice, a
// scoop) start the Meal Builder at one serving rather than an empty box.
const FOOD_UNITS = [
  { id: 'g', label: 'g', name: 'Grams (g)', base: 100 },
  { id: 'ml', label: 'ml', name: 'Millilitres (ml)', base: 100 },
  { id: 'l', label: 'L', name: 'Litres (L)', base: 1, spaced: true },
  { id: 'kg', label: 'kg', name: 'Kilograms (kg)', base: 1, spaced: true },
  { id: 'unit', label: 'unit', plural: 'units', name: 'Units (e.g. 1 egg)', base: 1, count: true },
  { id: 'serving', label: 'serving', plural: 'servings', name: 'Servings', base: 1, count: true },
  { id: 'slice', label: 'slice', plural: 'slices', name: 'Slices', base: 1, count: true },
  { id: 'scoop', label: 'scoop', plural: 'scoops', name: 'Scoops', base: 1, count: true },
  { id: 'cup', label: 'cup', plural: 'cups', name: 'Cups', base: 1, count: true },
  { id: 'tbsp', label: 'tbsp', name: 'Tablespoons (tbsp)', base: 1, count: true },
  { id: 'tsp', label: 'tsp', name: 'Teaspoons (tsp)', base: 1, count: true }
];

// "1 day", "3 days" - a count with the right noun, rather than "day(s)".
function plural(n, one, many = `${one}s`) {
  return `${Number(n).toLocaleString()} ${Number(n) === 1 ? one : many}`;
}

function unitInfo(id) {
  return FOOD_UNITS.find(u => u.id === id) || FOOD_UNITS[0];
}

// The day a meal in Today's Log was logged on, read from the time stamped
// into its id when it was logged ("meal-1791..."), as a toDateString() key.
// null for a meal that carries no such stamp - it counts as today's.
function mealLoggedDay(meal) {
  const m = /^meal-(\d{12,})/.exec(String((meal && meal.id) || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]));
  return isNaN(d.getTime()) ? null : d.toDateString();
}

// The food table may have been set up with whole-number columns. Postgres
// says so with this error when handed a decimal.
function isWholeNumberColumnError(err) {
  return !!err && (err.code === '22P02' ||
    /invalid input syntax for (type )?(integer|bigint|smallint)/i.test(err.message || ''));
}

// The unit of a food, a builder row or a logged item - whichever spelling it
// carries. Anything from before units existed is in grams.
function unitOfEntry(x) {
  const id = x && (x.Unit || x.unit);
  return FOOD_UNITS.some(u => u.id === id) ? id : 'g';
}

// "150g", "250ml", "0.5 L", "1 slice", "2 scoops", "2 tbsp".
function formatAmount(qty, unitId) {
  const n = Number(qty);
  if (qty === '' || qty === null || qty === undefined || !isFinite(n)) return String(qty ?? '');
  const u = unitInfo(unitId);
  const shown = String(Math.round(n * 100) / 100);
  if (!u.count) return u.spaced ? `${shown} ${u.label}` : `${shown}${u.label}`;
  return `${shown} ${u.plural && n !== 1 ? u.plural : u.label}`;
}

// What a food's macros are quoted against: "per 100g", "per slice",
// "per 2 slices".
function formatBasis(qty, unitId) {
  const u = unitInfo(unitId);
  return u.count && Number(qty) === 1 ? `per ${u.label}` : `per ${formatAmount(qty, unitId)}`;
}

// The Meal Builder's quantity label: QTY(G), QTY(ML), SLICES, TBSP.
function qtyLabelFor(unitId) {
  const u = unitInfo(unitId);
  return u.count ? (u.plural || u.label).toUpperCase() : `QTY(${u.label.toUpperCase()})`;
}

// A barcode inside scanner corners. The four bars sit symmetrically about the
// middle - the old three were off-centre by a pixel, which read as a glitch
// at 15px. Shared by the builder rows and the Foods page menu.
const SCAN_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><path d="M7 8v8"></path><path d="M10 8v8"></path><path d="M14 8v8"></path><path d="M17 8v8"></path></svg>';

// The ⋮ that opens a row's menu, and the icons its entries carry.
const MENU_DOTS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="12" cy="19" r="1.9"></circle></svg>';
const MENU_ICONS = {
  edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
  star: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>'
};

// The Food List's sort orders. `short` is what the Sort button shows; dir 1
// is ascending, -1 descending. A missing field sorts by name.
const FOOD_SORTS = [
  { id: 'name', label: 'Name (A–Z)', short: 'A–Z', dir: 1 },
  { id: 'name-desc', label: 'Name (Z–A)', short: 'Z–A', dir: -1 },
  { id: 'kcal-desc', label: 'Most calories', short: 'Most kcal', field: 'Kcal', dir: -1 },
  { id: 'kcal', label: 'Fewest calories', short: 'Fewest kcal', field: 'Kcal', dir: 1 },
  { id: 'prot-desc', label: 'Most protein', short: 'Most protein', field: 'Protein', dir: -1 },
  { id: 'carb-desc', label: 'Most carbs', short: 'Most carbs', field: 'Carb', dir: -1 },
  { id: 'fat-desc', label: 'Most fat', short: 'Most fat', field: 'Fat', dir: -1 }
];

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// A Meal Builder row with anything in it: a name, a quantity or a macro.
// The builder always shows one blank row, which is not worth keeping.
function builderRowHasContent(r) {
  return !!(r && ((r.name || '').trim() || r.qty > 0 ||
    r.kcal > 0 || r.prot > 0 || r.carb > 0 || r.fat > 0));
}

// A carry read back from the cloud or the mirror is only trusted when every
// part of it is there, since a bad one would skew a whole week's targets.
function isValidCarry(c) {
  const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  return !!(c && typeof c.id === 'string'
    && (c.kind === 'carry' || c.kind === 'plan')
    && isDay(c.day)
    && Number.isInteger(c.delta) && c.delta !== 0
    && Array.isArray(c.spread) && c.spread.length > 0 && c.spread.every(isDay)
    && !c.spread.includes(c.day));
}

function formatDateDMY(dateInput) {
  if (!dateInput) return '';
  if (dateInput instanceof Date) {
    if (isNaN(dateInput.getTime())) return '';
    return `${pad2(dateInput.getDate())}/${pad2(dateInput.getMonth() + 1)}/${dateInput.getFullYear()}`;
  }
  if (typeof dateInput === 'number') {
    const d = new Date(dateInput);
    if (!isNaN(d.getTime())) {
      return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
  }
  const str = String(dateInput).trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(str)) {
    const p = str.split(' ')[0].split('/');
    return `${pad2(parseInt(p[0], 10))}/${pad2(parseInt(p[1], 10))}/${p[2]}`;
  }
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) {
    const p = str.split('T')[0].split(' ')[0].split('-');
    return `${pad2(parseInt(p[2], 10))}/${pad2(parseInt(p[1], 10))}/${p[0]}`;
  }
  const d = new Date(str.split('-')[0].trim());
  if (!isNaN(d.getTime())) {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  return str;
}

// The display form: dd/mm/yy. formatDateDMY above is a storage format as
// well as a display one - it is what "Log Session" holds and what
// parseAnyDate matches on - so the year is trimmed here rather than there.
function formatDateDMYShort(dateInput) {
  const full = formatDateDMY(dateInput);
  const m = full.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[1]}/${m[2]}/${m[3].slice(2)}` : full;
}

function formatDateTimeDMY(dateInput) {
  if (!dateInput) return '';
  const str = String(dateInput).trim();
  let datePart = str;
  let timeSuffix = '';
  if (str.includes(' - ')) {
    const parts = str.split(' - ');
    datePart = parts[0].trim();
    timeSuffix = parts.slice(1).join(' - ').trim();
  }
  const formattedDate = formatDateDMYShort(datePart);
  if (timeSuffix) {
    return `${formattedDate} - ${timeSuffix}`;
  }
  const d = new Date(str);
  if (!isNaN(d.getTime()) && (d.getHours() > 0 || d.getMinutes() > 0)) {
    const hours = d.getHours();
    const minutes = pad2(d.getMinutes());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    return `${formatDateDMYShort(d)} - ${pad2(h12)}:${minutes} ${ampm}`;
  }
  return formattedDate;
}

// The value a <input type="date"> wants, built from local parts. Going via
// toISOString() converts local midnight to UTC first, which lands on the
// previous day for anyone east of Greenwich - a date picker that opens on
// yesterday.
function toISODateLocal(dateInput) {
  const d = dateInput instanceof Date ? dateInput : parseAnyDate(dateInput);
  if (!d || isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseAnyDate(dateInput) {
  if (!dateInput) return new Date();
  if (dateInput instanceof Date) return dateInput;
  const s = String(dateInput).trim();
  
  // Strict matching for sorting accuracy down to the minute: DD/MM/YYYY - HH:MM AM/PM
  const dmyTimeMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2})\s*([APap][Mm]))?/);
  if (dmyTimeMatch) {
    let [_, d, m, y, h, min, ampm] = dmyTimeMatch;
    let hours = 0, minutes = 0;
    if (h && min && ampm) {
      hours = parseInt(h, 10);
      minutes = parseInt(min, 10);
      if (ampm.toLowerCase() === 'pm' && hours < 12) hours += 12;
      if (ampm.toLowerCase() === 'am' && hours === 12) hours = 0;
    }
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), hours, minutes);
  }
  
  const ymdMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymdMatch) {
    return new Date(parseInt(ymdMatch[1], 10), parseInt(ymdMatch[2], 10) - 1, parseInt(ymdMatch[3], 10));
  }
  const firstPart = s.split('-')[0].trim();
  const dObj = new Date(firstPart);
  if (!isNaN(dObj.getTime())) return dObj;
  return new Date();
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// STORE & SUPABASE ENGINE
class MacroDataStore {
  constructor() {
    // A snapshot of the last successful sync is kept on the device (see
    // saveLocalMirror) so an installed app can open and show something with no
    // connection. The cloud still wins outright: the mirror is replaced whole
    // the moment a fetch succeeds, so it only ever fills the gap before the
    // first reply lands - or stands in when no reply is coming.
    this.session = { email: '', active: false, user: null };
    this.sessionChecked = false;
    this.targets = { id: 1, kcal: 2000, protein: 180, carbs: 200, fat: 55 };
    this.foods = [];
    this.pastLogs = [];
    this.favorites = [];
    this.weights = [];
    this.todayMeals = [];
    this.supabase = null;
    this.realtimeChannel = null;
    // Concurrency guards. fetchCloudData runs on a 4s timer, on focus, on
    // visibilitychange AND on realtime events, so without these a fetch that
    // started before a local draft write landed would come back with a stale
    // snapshot and overwrite the meal the user just logged.
    this.fetchInFlight = false;
    // Quiet attempts spent on an error that looks like it will clear itself.
    this.syncRetries = 0;
    this.draftWritesInFlight = 0;
    this.lastLocalDraftChange = 0;
    // Set when a draft write could not reach the cloud - usually offline.
    // Until it clears, today's meals are local truth and a fetch must not
    // overwrite them.
    this.draftSyncFailed = false;
    // The Meal Builder lives here rather than on the app so it syncs and
    // mirrors with everything else; MacroApp reads it through an accessor.
    this.builderRows = [];
    // The builder's own rows, set aside while a logged meal is edited in it.
    this.builderStash = null;
    this.builderWritesInFlight = 0;
    this.lastLocalBuilderChange = 0;
    this.builderSyncFailed = false;
    // Calories moved between days: { id, kind: 'carry' | 'plan', day, delta,
    // spread }. `day` (YYYY-MM-DD) gains `delta` and the `spread` days share
    // -delta between them, so the week's total never changes.
    this.carries = [];
    this.carriesWritesInFlight = 0;
    this.lastLocalCarriesChange = 0;
    this.carriesSyncFailed = false;
    // Serving types live on each food as `Unit` while the app runs; the cloud
    // keeps them in their own row (FOOD_UNITS_UUID), with the same settling
    // rules as the carries.
    this.foodUnitsWritesInFlight = 0;
    this.lastLocalFoodUnitsChange = 0;
    this.foodUnitsSyncFailed = false;
    this.initSupabase();
  }

  // True while the local draft is newer than anything the server can tell us:
  // a write is in flight, or one landed so recently that an in-flight fetch
  // may still be carrying the pre-write snapshot.
  isDraftLocallyDirty() {
    return this.draftSyncFailed
      || this.draftWritesInFlight > 0
      || (Date.now() - this.lastLocalDraftChange) < 4000;
  }

  // ---- on-device mirror of the last good sync ----------------------------
  // One synchronous localStorage write of everything the account holds -
  // a few hundred KB once there is a year of history behind you. It is only
  // a cache, so it waits for a gap in the work rather than blocking the tap
  // that triggered it. Repeated calls collapse into one write.
  saveLocalMirror() {
    if (this.mirrorWritePending) return;
    this.mirrorWritePending = true;
    const run = () => {
      // flushLocalMirror may have beaten us to it.
      if (!this.mirrorWritePending) return;
      this.mirrorWritePending = false;
      this.writeLocalMirror();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2000 });
    } else {
      setTimeout(run, 0);
    }
  }

  // Anything about to lose the page flushes through here first, so a tab
  // closed mid-idle does not lose the last sync.
  flushLocalMirror() {
    if (!this.mirrorWritePending) return;
    this.mirrorWritePending = false;
    this.writeLocalMirror();
  }

  writeLocalMirror() {
    try {
      const uid = this.session && this.session.user ? this.session.user.id : null;
      if (!uid) return;
      localStorage.setItem(LOCAL_MIRROR_KEY, JSON.stringify({
        uid,
        savedAt: Date.now(),
        targets: this.targets,
        foods: this.foods,
        pastLogs: this.pastLogs,
        favorites: this.favorites,
        weights: this.weights,
        todayMeals: this.todayMeals,
        builderRows: this.builderStash || this.builderRows,
        carries: this.carries
      }));
    } catch (e) { /* private mode, or the quota is full */ }
  }

  clearLocalMirror() {
    try { localStorage.removeItem(LOCAL_MIRROR_KEY); } catch (e) { /* private mode */ }
  }

  // Keyed by user id, so signing in as someone else never shows the previous
  // account's food. Returns whether anything was restored.
  hydrateFromMirror(uid) {
    try {
      const raw = localStorage.getItem(LOCAL_MIRROR_KEY);
      if (!raw) return false;
      const m = JSON.parse(raw);
      if (!m || (uid && m.uid && m.uid !== uid)) return false;
      this.targets = m.targets || this.targets;
      this.foods = Array.isArray(m.foods) ? m.foods : [];
      this.pastLogs = Array.isArray(m.pastLogs) ? m.pastLogs : [];
      this.favorites = Array.isArray(m.favorites) ? m.favorites : [];
      this.weights = Array.isArray(m.weights) ? m.weights : [];
      this.todayMeals = Array.isArray(m.todayMeals) ? m.todayMeals : [];
      this.builderRows = Array.isArray(m.builderRows) ? m.builderRows : [];
      this.carries = Array.isArray(m.carries) ? m.carries.filter(isValidCarry) : [];
      return true;
    } catch (e) {
      return false;
    }
  }

  resetLocalData() {
    this.targets = { id: 1, kcal: 2000, protein: 180, carbs: 200, fat: 55 };
    this.foods = [];
    this.pastLogs = [];
    this.favorites = [];
    this.weights = [];
    this.todayMeals = [];
    this.builderRows = [];
    this.builderStash = null;
    this.carries = [];
  }

  async initSupabase() {
    if (window.supabase) {
      try {
        // persistSession/autoRefreshToken (the SDK defaults) are what let a
        // real login survive an app restart - this is the ONLY thing this app
        // stores on the device. It is a Supabase JWT, not a spoofable flag.
        this.supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true }
        });

        this.supabase.auth.onAuthStateChange((event, session) => {
          if (session && session.user) {
            this.session = { email: session.user.email, active: true, user: session.user };
            // Paint the last known data immediately rather than waiting on five
            // round-trips - and show it at all when those never arrive.
            if (this.hydrateFromMirror(session.user.id) && window.app) {
              window.app.renderAll();
            }
            this.setSyncStatus(navigator.onLine ? 'synced' : 'offline');
            this.instrumentWrites();
            this.setupRealtime();
            this.fetchCloudData();
          } else {
            this.session = { email: '', active: false, user: null };
            this.resetLocalData();
            // Only an actual sign-out wipes the on-device copy. A null session
            // also arrives when a token cannot be refreshed - which is exactly
            // what happens offline, and exactly when that copy is the only one
            // left. Deleting it there would throw away the data it exists for.
            if (event === 'SIGNED_OUT') this.clearLocalMirror();
            this.setSyncStatus('offline');
          }
          this.sessionChecked = true;
          if (window.app) window.app.checkAuth();
        });

        const { data: sessionData } = await this.supabase.auth.getSession();
        if (sessionData && sessionData.session && sessionData.session.user) {
          this.session = {
            email: sessionData.session.user.email,
            active: true,
            user: sessionData.session.user
          };
          this.instrumentWrites();
          this.setupRealtime();
          this.fetchCloudData();
        }
        this.sessionChecked = true;
        if (window.app) window.app.checkAuth();
      } catch (err) {
        console.warn("Supabase init error:", err);
        this.sessionChecked = true;
        if (window.app) window.app.checkAuth();
      }
    }
  }

  async signIn(email, password) {
    if (!this.supabase) return { error: { message: "Supabase client not initialized" } };
    this.setSyncStatus('syncing');
    try {
      const res = await this.supabase.auth.signInWithPassword({ email, password });
      if (res.error) {
        this.setSyncStatus('error');
        return res;
      }
      this.session = {
        email: res.data.user.email,
        active: true,
        user: res.data.user
      };
      this.setSyncStatus('synced');
      this.setupRealtime();
      await this.fetchCloudData();
      return res;
    } catch (err) {
      this.setSyncStatus('error');
      return { error: err };
    }
  }

  async signUp(email, password) {
    if (!this.supabase) return { error: { message: "Supabase client not initialized" } };
    this.setSyncStatus('syncing');
    try {
      const res = await this.supabase.auth.signUp({ email, password });
      if (res.error) {
        this.setSyncStatus('error');
        return res;
      }
      if (res.data?.user && res.data?.session) {
        this.session = {
          email: res.data.user.email,
          active: true,
          user: res.data.user
        };
        this.setSyncStatus('synced');
        this.setupRealtime();
        await this.fetchCloudData();
      }
      return res;
    } catch (err) {
      this.setSyncStatus('error');
      return { error: err };
    }
  }

  async signOut() {
    if (this.supabase) {
      try {
        await this.supabase.auth.signOut();
      } catch (e) {}
    }
    this.session = { email: '', active: false, user: null };
    this.resetLocalData();
    this.setSyncStatus('offline');
  }

  // Supabase hands our own writes back to us as realtime events, and every
  // one of them used to kick off a full re-read of all five tables. The
  // Meal Builder saves its draft about once a second while you type, so a
  // sentence of typing became a queue of full syncs - the stutter you feel
  // on a phone. Wrapping the one place every query is built lets us know an
  // echo when we see one, without threading a flag through twenty writes.
  instrumentWrites() {
    if (!this.supabase || this.supabase.__writesInstrumented) return;
    const rawFrom = this.supabase.from.bind(this.supabase);
    this.supabase.from = (table) => {
      const builder = rawFrom(table);
      for (const op of ['insert', 'update', 'upsert', 'delete']) {
        const fn = builder[op];
        if (typeof fn !== 'function') continue;
        builder[op] = (...args) => {
          this.noteSelfWrite();
          return fn.apply(builder, args);
        };
      }
      return builder;
    };
    this.supabase.__writesInstrumented = true;
  }

  // Errors that mean "not yet" rather than "no". The common one is a token
  // presented the instant it was issued: Supabase stamps the issued-at from
  // the auth server's clock, and if the node checking it is running a second
  // or two behind, a brand new token looks like it comes from the future.
  // It validates on its own a moment later, so it is worth a quiet retry
  // rather than a red dot and a toast.
  isTransientSyncError(msg) {
    if (!msg) return false;
    return /issued at future|issued in the future|jwt expired|token is expired|clock|failed to fetch|networkerror|load failed|timeout|fetch failed/i
      .test(String(msg));
  }

  noteSelfWrite() {
    // Long enough to cover the round trip and the echo that follows it.
    this.selfWriteUntil = Date.now() + 2000;
  }

  // One coalesced fetch instead of one per event. While this device is
  // still writing, the fetch is pushed out rather than cancelled, so an
  // update from another device is delayed by a beat but never dropped.
  scheduleCloudFetch(delay = 500) {
    const settling = (this.selfWriteUntil || 0) - Date.now();
    const wait = settling > 0 ? settling + 250 : delay;
    clearTimeout(this.cloudFetchTimer);
    this.cloudFetchTimer = setTimeout(() => this.fetchCloudData(), wait);
  }

  setupRealtime() {
    if (!this.supabase || this.realtimeChannel) return;
    try {
      const onChange = () => this.scheduleCloudFetch();
      this.realtimeChannel = this.supabase.channel('public_macro_sync_channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'macro_daily_logs' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'macro_weight_tracker' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'macro_targets' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'macro_food_database' }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'macro_tracker_favorites' }, onChange)
        .subscribe();
    } catch (err) {
      console.warn("Realtime setup notice:", err);
    }
  }

  async fetchCloudData() {
    if (!this.supabase) return;
    // Overlapping fetches raced each other and the last one to resolve won,
    // which is not necessarily the freshest. A request that arrives while
    // one is running is remembered rather than dropped, so the last word
    // from the cloud still lands.
    if (this.fetchInFlight) { this.fetchQueued = true; return; }
    clearTimeout(this.cloudFetchTimer);
    this.fetchInFlight = true;
    this.setSyncStatus('syncing');
    // Track whether every table actually came back successfully. Before this,
    // a failed query was silently ignored and the status still said "synced" -
    // so a device with a bad connection/config would keep showing old cached
    // data while looking perfectly fine.
    let hadError = false;
    let firstErrorMsg = '';
    const flagError = (err) => {
      if (err) {
        hadError = true;
        if (!firstErrorMsg) firstErrorMsg = err.message || String(err);
      }
    };
    try {
      // Five independent tables, so one round trip instead of five stacked
      // end to end. On mobile data that alone was most of the wait.
      const [
        { data: targetsData, error: targetsErr },
        { data: foodsData, error: foodsErr },
        { data: logsData, error: logsErr },
        { data: favsData, error: favsErr },
        { data: weightsData, error: weightsErr }
      ] = await Promise.all([
        this.supabase.from('macro_targets').select('*').limit(1),
        this.supabase.from('macro_food_database').select('*'),
        this.supabase.from('macro_daily_logs').select('*'),
        this.supabase.from('macro_tracker_favorites').select('*'),
        this.supabase.from('macro_weight_tracker').select('*').order('date', { ascending: true })
      ]);

      flagError(targetsErr);
      if (targetsData && targetsData.length > 0) {
        const t = targetsData[0];
        this.targets = {
          id: t.id || 1,
          kcal: Number(t.kcal ?? t.Kcal ?? t.calories ?? 2000),
          protein: Number(t.protein ?? t.Protein ?? 180),
          carbs: Number(t.carbs ?? t.Carbs ?? t.carb ?? 200),
          fat: Number(t.fat ?? t.Fat ?? 55)
        };
      }

      flagError(foodsErr);
      // The rows below come back without serving types; they are put back
      // once the logs (where they are kept) have been read.
      const localUnits = this.foodUnitMap();
      if (foodsData && !foodsErr) {
        this.foods = foodsData.map(f => ({
          id: f.id || generateUUID(),
          Item: (f.Item || f.item || f.name || 'Food').trim(),
          Quantity: Number(f.Quantity ?? f.quantity ?? 100),
          Kcal: Number(f.Kcal ?? f.kcal ?? 0),
          Protein: Number(f.Protein ?? f.protein ?? 0),
          Carb: Number(f.Carb ?? f.carb ?? f.Carbs ?? f.carbs ?? 0),
          Fat: Number(f.Fat ?? f.fat ?? 0),
          barcode: f.barcode || null
        }));
      }

      flagError(logsErr);
      // Draft handling runs whenever the query succeeded - including when the
      // table is empty. It used to be skipped unless there was at least one
      // row, so clearing every meal on one device never propagated.
      if (logsData && !logsErr) {
        const isDraftRow = (l) =>
          l.id === ACTIVE_DRAFT_UUID ||
          (l['Log Session'] || l.log_session || '').toString().trim().toUpperCase() === 'ACTIVE_DRAFT';

        const draftRows = logsData.filter(isDraftRow);
        // Prefer the canonical row. A stray second draft (an older fallback
        // insert) would otherwise win the race non-deterministically, showing
        // stale/empty meals while the real draft sat in the table.
        const activeDraft = draftRows.find(l => l.id === ACTIVE_DRAFT_UUID) || draftRows[0];

        if (draftRows.length > 1) {
          for (const stray of draftRows) {
            if (stray.id !== activeDraft.id) {
              this.supabase.from('macro_daily_logs').delete().eq('id', stray.id).then(() => {}, () => {});
            }
          }
        }

        // The cloud is the single source of truth for today's draft, EXCEPT
        // while a local write is still settling - otherwise a fetch that was
        // already in flight when the user logged a meal comes back with the
        // pre-write snapshot and wipes that meal off the screen.
        if (!this.isDraftLocallyDirty()) {
          let serverMeals = [];
          if (activeDraft) {
            const itemsRaw = activeDraft['Items Logged'] || activeDraft.items_logged;
            if (itemsRaw) {
              try {
                const parsedDraft = typeof itemsRaw === 'string' ? JSON.parse(itemsRaw) : itemsRaw;
                if (Array.isArray(parsedDraft)) serverMeals = parsedDraft;
              } catch (e) {}
            }
          }
          this.todayMeals = serverMeals;
        }

        // The Meal Builder draft, same treatment: the cloud wins unless a
        // local edit is still settling or a caret is sitting in a row.
        const builderRow = logsData.find(l =>
          l.id === BUILDER_DRAFT_UUID ||
          (l['Log Session'] || l.log_session || '').toString().trim().toUpperCase() === 'BUILDER_DRAFT'
        );
        if (!this.isBuilderLocallyDirty()) {
          let serverRows = [];
          if (builderRow) {
            const raw = builderRow['Items Logged'] || builderRow.items_logged;
            if (raw) {
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (Array.isArray(parsed)) serverRows = parsed;
              } catch (e) {}
            }
          }
          // Only repaint when it actually differs, or every poll would
          // rebuild the rows and throw away the dropdown that was open.
          if (JSON.stringify(serverRows) !== JSON.stringify(this.meaningfulBuilderRows())) {
            this.builderRows = serverRows;
            this._builderNeedsRepaint = true;
          }
        }

        // Carries: the cloud wins unless a local change is still settling.
        const carriesRow = logsData.find(l =>
          l.id === CARRIES_UUID ||
          (l['Log Session'] || l.log_session || '').toString().trim().toUpperCase() === 'CALORIE_CARRIES'
        );
        if (!this.isCarriesLocallyDirty()) {
          let serverCarries = [];
          if (carriesRow) {
            const raw = carriesRow['Items Logged'] || carriesRow.items_logged;
            if (raw) {
              try {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (Array.isArray(parsed)) serverCarries = parsed.filter(isValidCarry);
              } catch (e) {}
            }
          }
          this.carries = serverCarries;
        }
      }
      // Serving types: the cloud wins unless a local change is still settling
      // or the logs could not be read.
      let unitsToApply = localUnits;
      if (logsData && !logsErr && !this.isFoodUnitsLocallyDirty()) {
        const unitsRow = logsData.find(l =>
          l.id === FOOD_UNITS_UUID ||
          (l['Log Session'] || l.log_session || '').toString().trim().toUpperCase() === 'FOOD_UNITS'
        );
        unitsToApply = {};
        const raw = unitsRow && (unitsRow['Items Logged'] || unitsRow.items_logged);
        if (raw) {
          try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) unitsToApply = parsed;
          } catch (e) {}
        }
      }
      this.applyFoodUnitMap(unitsToApply);
      if (logsData && !logsErr) {
        this.pastLogs = logsData
          .filter(l => {
            const session = (l['Log Session'] || l.log_session || '').toString().trim().toUpperCase();
            return l.id !== ACTIVE_DRAFT_UUID
              && l.id !== BUILDER_DRAFT_UUID
              && l.id !== CARRIES_UUID
              && l.id !== FOOD_UNITS_UUID
              && session !== 'ACTIVE_DRAFT'
              && session !== 'BUILDER_DRAFT'
              && session !== 'CALORIE_CARRIES'
              && session !== 'FOOD_UNITS';
          })
          .map(l => ({
            id: l.id || generateUUID(),
            "Log Session": l['Log Session'] || l.log_session || l.date || 'Past Day',
            "Total Kcal": Number(l['Total Kcal'] ?? l.total_kcal ?? l.kcal ?? 0),
            "Total Protein": Number(l['Total Protein'] ?? l.total_protein ?? l.protein ?? 0),
            "Total Carbs": Number(l['Total Carbs'] ?? l.total_carbs ?? l.carbs ?? 0),
            "Total Fat": Number(l['Total Fat'] ?? l.total_fat ?? l.fat ?? 0),
            "Items Logged": l['Items Logged'] || l.items_logged || ''
          }));
        
        // Group and Merge Days of the same date
        this.consolidatePastLogs();
      }

      flagError(favsErr);
      if (favsData && !favsErr) {
        this.favorites = favsData.map(f => ({
          id: f.id || generateUUID(),
          Name: f.Name || f.name || 'Favorite Combo',
          Items: typeof f.Items === 'string' ? f.Items : (typeof f.items === 'string' ? f.items : JSON.stringify(f.Items || f.items || []))
        }));
      }

      flagError(weightsErr);
      if (weightsData && !weightsErr) {
        this.weights = weightsData.map(w => {
          // Body fat is optional and the column may not exist on an older
          // database, so a missing value stays null rather than becoming 0.
          const rawBf = w.bf ?? w.BF ?? w.body_fat ?? w.bodyFat;
          const bf = (rawBf === null || rawBf === undefined || rawBf === '') ? null : Number(rawBf);
          return {
            id: w.id || generateUUID(),
            date: w.date || w.Date,
            weight: Number(w.weight ?? w.Weight ?? 0),
            bf: (bf === null || isNaN(bf)) ? null : bf
          };
        }).filter(w => w.date && !isNaN(w.weight)).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      }

      if (hadError) {
        // At least one table failed to load. A failure that will clear on its
        // own gets a couple of quiet attempts first - showing the user a red
        // dot for something that fixes itself in two seconds is just noise.
        // Anything still failing after that is reported as it always was.
        const retriable = this.isTransientSyncError(firstErrorMsg) && this.syncRetries < 2;
        if (retriable) {
          this.syncRetries++;
          console.warn(`Cloud fetch retrying (${this.syncRetries}/2):`, firstErrorMsg);
          // Still syncing, as far as the user is concerned - because it is.
          this.setSyncStatus('syncing');
          this.scheduleCloudFetch(this.syncRetries === 1 ? 1500 : 4000);
        } else {
          this.setSyncStatus('error', firstErrorMsg);
          console.warn("Cloud fetch had errors:", firstErrorMsg);
          if (window.app && this._lastSyncError !== firstErrorMsg) {
            window.app.showToast(`Cloud sync issue: ${firstErrorMsg}`, 'error');
          }
          this._lastSyncError = firstErrorMsg;
        }
      } else {
        this.setSyncStatus('synced');
        this._lastSyncError = null;
        this.syncRetries = 0;
        this.saveLocalMirror();
      }
      // Only repaint when the cloud actually returned something different.
      // A blind repaint on every poll/realtime event tore down open accordions
      // and dropdowns while the user was reading them.
      const signature = JSON.stringify([
        this.targets, this.todayMeals, this.pastLogs, this.favorites, this.weights, this.foods, this.carries
      ]);
      if (window.app && signature !== this._lastDataSignature) {
        this._lastDataSignature = signature;
        window.app.renderAll();
      }
      // The builder is deliberately outside that signature: it changes on
      // every keystroke, and folding it in would repaint the whole page
      // while the user types.
      if (window.app && this._builderNeedsRepaint) {
        this._builderNeedsRepaint = false;
        window.app.renderBuilderRowsFromRemote();
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (this.isTransientSyncError(msg) && this.syncRetries < 2) {
        this.syncRetries++;
        console.warn(`Cloud fetch retrying (${this.syncRetries}/2):`, msg);
        this.setSyncStatus('syncing');
        this.scheduleCloudFetch(this.syncRetries === 1 ? 1500 : 4000);
      } else {
        console.warn("Cloud fetch notice:", e);
        this.setSyncStatus('error', msg);
        if (window.app && this._lastSyncError !== msg) {
          window.app.showToast(`Cloud sync failed: ${msg}`, 'error');
        }
        this._lastSyncError = msg;
      }
    } finally {
      this.fetchInFlight = false;
      if (this.fetchQueued) {
        this.fetchQueued = false;
        this.scheduleCloudFetch(400);
      }
    }
  }

  consolidatePastLogs() {
    const grouped = {};
    let needsUpdate = false;
    const mergedLogs = [];
    const logsToDelete = [];

    // Sort newest first so we always keep the most recent time when merging into one calendar day
    this.pastLogs.sort((a, b) => parseAnyDate(b['Log Session']).getTime() - parseAnyDate(a['Log Session']).getTime());

    for (const log of this.pastLogs) {
      const dateOnly = (log['Log Session'] || '').split(' - ')[0].trim();
      if (!grouped[dateOnly]) {
        grouped[dateOnly] = { ...log };
        mergedLogs.push(grouped[dateOnly]);
      } else {
        needsUpdate = true;
        grouped[dateOnly]['Total Kcal'] += log['Total Kcal'];
        grouped[dateOnly]['Total Protein'] = Math.round((grouped[dateOnly]['Total Protein'] + log['Total Protein']) * 10) / 10;
        grouped[dateOnly]['Total Carbs'] = Math.round((grouped[dateOnly]['Total Carbs'] + log['Total Carbs']) * 10) / 10;
        grouped[dateOnly]['Total Fat'] = Math.round((grouped[dateOnly]['Total Fat'] + log['Total Fat']) * 10) / 10;
        
        let existingParsed = [];
        try { existingParsed = JSON.parse(grouped[dateOnly]['Items Logged']); } catch(e) {}
        let currentParsed = [];
        try { currentParsed = JSON.parse(log['Items Logged']); } catch(e) {}
        
        if (!Array.isArray(existingParsed)) {
            existingParsed = [{ name: "Previous Log", totals: {}, items: [{ qty: "Old", name: grouped[dateOnly]['Items Logged'] || 'Log' }] }];
        }
        if (!Array.isArray(currentParsed)) {
            currentParsed = [{ name: "Merged Log", totals: {}, items: [{ qty: "Old", name: log['Items Logged'] || 'Log' }] }];
        }
        
        grouped[dateOnly]['Items Logged'] = JSON.stringify([...existingParsed, ...currentParsed]);
        logsToDelete.push(log.id);
      }
    }

    if (needsUpdate) {
      this.pastLogs = mergedLogs;
      
      if (this.supabase) {
        for (const log of mergedLogs) {
          // Supabase's query builder is a thenable, not a real Promise - it
          // has .then() but not .catch(), so calling .catch() throws
          // synchronously and (since this runs inside fetchCloudData) was
          // aborting the rest of the sync before favorites/weights loaded.
          this.supabase.from('macro_daily_logs').update({
            "Total Kcal": log['Total Kcal'],
            "Total Protein": log['Total Protein'],
            "Total Carbs": log['Total Carbs'],
            "Total Fat": log['Total Fat'],
            "Items Logged": log['Items Logged']
          }).eq('id', log.id).then(() => {}, () => {});
        }
        for (const id of logsToDelete) {
          this.supabase.from('macro_daily_logs').delete().eq('id', id).then(() => {}, () => {});
        }
      }
    }
  }

  setSyncStatus(status, errorMessage) {
    this.syncState = status;
    this.syncError = status === 'error' ? (errorMessage || '') : '';
    if (status === 'synced') this.lastSyncedAt = Date.now();
    const btn = document.getElementById('sync-status-circle-btn');
    if (btn) {
      btn.className = `sync-circle-btn ${status}`;
      const words = {
        synced: 'Everything is synced',
        syncing: 'Syncing…',
        offline: 'Offline - your changes will sync when you are back online',
        error: `Sync problem${errorMessage ? `: ${errorMessage}` : ''}`
      };
      btn.title = `${words[status] || 'Sync status'} (tap for details)`;
      btn.setAttribute('aria-label', btn.title);
    }
    if (window.app && typeof window.app.refreshSyncDialog === 'function') window.app.refreshSyncDialog();
  }

  getTodayTotals() {
    return this.totalsOfMeals(this.todayMeals);
  }

  totalsOfMeals(meals) {
    let totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    meals.forEach(meal => {
      if (meal.totals) {
        totals.kcal += meal.totals.kcal || 0;
        totals.protein += meal.totals.protein || 0;
        totals.carbs += meal.totals.carbs || 0;
        totals.fat += meal.totals.fat || 0;
      }
    });
    totals.kcal = Math.round(totals.kcal);
    totals.protein = Math.round(totals.protein * 10) / 10;
    totals.carbs = Math.round(totals.carbs * 10) / 10;
    totals.fat = Math.round(totals.fat * 10) / 10;
    return totals;
  }

  async addMealToToday(meal) {
    this.todayMeals.unshift(meal);
    await this.syncActiveDraft();
  }

  // ---- the Meal Builder draft ---------------------------------------------
  // The half-built meal used to live only in app memory, so it was lost on a
  // reload and never reached another device. It now rides in the same table as
  // today's draft, under its own sentinel row, which means no schema change.
  isBuilderLocallyDirty() {
    // Mid-edit, the rows on screen are a logged meal. A remote draft landing
    // now would replace them with the builder's usual contents.
    if (this.builderStash) return true;
    if (this.builderSyncFailed || this.builderWritesInFlight > 0) return true;
    if ((Date.now() - this.lastLocalBuilderChange) < 4000) return true;
    // Never swap the rows out from under a caret. A remote update landing while
    // a quantity is half-typed would rebuild the row and lose the keystrokes.
    try {
      if (document.hasFocus()) {
        const el = document.activeElement;
        if (el && el.closest && el.closest('.food-builder-row')) return true;
      }
    } catch (e) { /* no document during tests */ }
    return false;
  }

  // Rows worth keeping. The builder always shows at least one blank row, and
  // syncing that is noise - an empty builder should read as empty everywhere.
  // While a logged meal is being edited, the builder on screen is holding
  // that meal; the rows that were there before wait in builderStash, and
  // those are the ones that sync and survive a reload.
  meaningfulBuilderRows() {
    return (this.builderStash || this.builderRows || []).filter(builderRowHasContent);
  }

  builderDraftTotals() {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    this.meaningfulBuilderRows().forEach(r => {
      t.kcal += r.kcal || 0;
      t.protein += r.prot || 0;
      t.carbs += r.carb || 0;
      t.fat += r.fat || 0;
    });
    return {
      kcal: Math.round(t.kcal),
      protein: Math.round(t.protein * 10) / 10,
      carbs: Math.round(t.carbs * 10) / 10,
      fat: Math.round(t.fat * 10) / 10
    };
  }

  async syncBuilderDraft() {
    if (!this.supabase || !this.session.active) return { success: true };

    this.builderWritesInFlight++;
    this.lastLocalBuilderChange = Date.now();
    try {
      const rows = this.meaningfulBuilderRows();

      if (rows.length === 0) {
        const { error: delErr } = await this.supabase
          .from('macro_daily_logs')
          .delete()
          .eq('id', BUILDER_DRAFT_UUID);
        if (delErr) throw delErr;
        this.builderSyncFailed = false;
        return { success: true };
      }

      const totals = this.builderDraftTotals();
      const record = {
        id: BUILDER_DRAFT_UUID,
        'Log Session': 'BUILDER_DRAFT',
        'Total Kcal': totals.kcal,
        'Total Protein': totals.protein,
        'Total Carbs': totals.carbs,
        'Total Fat': totals.fat,
        'Items Logged': JSON.stringify(rows)
      };

      const { error: upsertErr } = await this.supabase
        .from('macro_daily_logs')
        .upsert([record], { onConflict: 'id' });

      if (upsertErr) {
        // Same fallback the today-draft uses: an older database without an
        // upsert-friendly constraint still takes an update, then an insert.
        const { data: updated, error: updErr } = await this.supabase
          .from('macro_daily_logs')
          .update(record)
          .eq('id', BUILDER_DRAFT_UUID)
          .select();
        if (updErr || !updated || updated.length === 0) {
          const { error: insErr } = await this.supabase
            .from('macro_daily_logs')
            .insert([record]);
          if (insErr) throw upsertErr;
        }
      }

      this.builderSyncFailed = false;
      return { success: true };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn('syncBuilderDraft failed:', msg);
      // Local is now the only copy, so a fetch must not overwrite it.
      this.builderSyncFailed = true;
      return { success: false, error: msg };
    } finally {
      this.builderWritesInFlight--;
      this.lastLocalBuilderChange = Date.now();
      this.saveLocalMirror();
    }
  }

  // ---- calorie carries -----------------------------------------------------
  // Same sentinel-row trick as the builder draft: one row holding the list.
  isCarriesLocallyDirty() {
    return this.carriesSyncFailed
      || this.carriesWritesInFlight > 0
      || (Date.now() - this.lastLocalCarriesChange) < 4000;
  }

  // One carry per day and kind: saving a day's carry again replaces it.
  async saveCarry(carry) {
    this.carries = this.carries
      .filter(c => !(c.day === carry.day && c.kind === carry.kind))
      .concat(carry);
    this.pruneCarries();
    return this.syncCarries();
  }

  async removeCarry(day, kind) {
    this.carries = this.carries.filter(c => !(c.day === day && c.kind === kind));
    return this.syncCarries();
  }

  // Carries only matter while their days are still on screen somewhere; a
  // few months back is plenty, and it keeps the row small.
  pruneCarries() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 120);
    const cut = toISODateLocal(cutoff);
    this.carries = this.carries.filter(c => c.day >= cut || c.spread.some(d => d >= cut));
  }

  async syncCarries() {
    this.lastLocalCarriesChange = Date.now();
    if (!this.supabase || !this.session.active) {
      this.saveLocalMirror();
      return { success: true };
    }

    this.carriesWritesInFlight++;
    try {
      if (this.carries.length === 0) {
        const { error: delErr } = await this.supabase
          .from('macro_daily_logs')
          .delete()
          .eq('id', CARRIES_UUID);
        if (delErr) throw delErr;
        this.carriesSyncFailed = false;
        return { success: true };
      }

      const record = {
        id: CARRIES_UUID,
        'Log Session': 'CALORIE_CARRIES',
        'Total Kcal': 0,
        'Total Protein': 0,
        'Total Carbs': 0,
        'Total Fat': 0,
        'Items Logged': JSON.stringify(this.carries)
      };

      const { error: upsertErr } = await this.supabase
        .from('macro_daily_logs')
        .upsert([record], { onConflict: 'id' });

      if (upsertErr) {
        const { data: updated, error: updErr } = await this.supabase
          .from('macro_daily_logs')
          .update(record)
          .eq('id', CARRIES_UUID)
          .select();
        if (updErr || !updated || updated.length === 0) {
          const { error: insErr } = await this.supabase
            .from('macro_daily_logs')
            .insert([record]);
          if (insErr) throw upsertErr;
        }
      }

      this.carriesSyncFailed = false;
      return { success: true };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn('syncCarries failed:', msg);
      // Local is now the only copy, so a fetch must not overwrite it. It is
      // pushed again when the connection comes back.
      this.carriesSyncFailed = true;
      return { success: false, error: msg };
    } finally {
      this.carriesWritesInFlight--;
      this.lastLocalCarriesChange = Date.now();
      this.saveLocalMirror();
    }
  }

  // ---- food serving types ------------------------------------------------

  // What the synced map keeps for a food beyond its row: its unit when that
  // is not grams, and its exact serving when that is not a whole number (an
  // integer Quantity column would have rounded it). null when the row says
  // it all.
  foodMapEntry(f) {
    const unit = unitOfEntry(f);
    const qty = Number(f.Quantity);
    if (!isFinite(qty) || Number.isInteger(qty)) return unit === 'g' ? null : unit;
    return { unit, qty };
  }

  foodUnitMap() {
    const map = {};
    this.foods.forEach(f => {
      const entry = this.foodMapEntry(f);
      if (entry !== null) map[f.id] = entry;
    });
    return map;
  }

  applyFoodUnitMap(map) {
    this.foods.forEach(f => {
      const entry = map && map[f.id];
      const unit = typeof entry === 'string' ? entry : (entry && entry.unit);
      f.Unit = FOOD_UNITS.some(u => u.id === unit) ? unit : 'g';
      const qty = entry && typeof entry === 'object' ? Number(entry.qty) : NaN;
      if (isFinite(qty) && qty > 0) f.Quantity = qty;
    });
  }

  // Writes a food row (an update when given an id), stepping around what
  // the table cannot take: a decimal serving in a whole-number column is
  // rounded (the exact one is in the synced map), then kcal, then the
  // macros - each only if the table still refuses - and a barcode the table
  // has no column for is left out.
  async writeFoodRow(row, id = null) {
    const send = (r) => id
      ? this.supabase.from('macro_food_database').update(r).eq('id', id)
      : this.supabase.from('macro_food_database').insert([r]);
    const rounded = (r, keys) => {
      const out = { ...r };
      keys.forEach(k => {
        if (!(k in out)) return;
        const n = Math.round(Number(out[k]) || 0);
        out[k] = k === 'Quantity' ? Math.max(1, n) : n;
      });
      return out;
    };
    const roundingSteps = [['Quantity'], ['Quantity', 'Kcal'], ['Quantity', 'Kcal', 'Protein', 'Carb', 'Fat']];
    let current = row;
    let { error } = await send(current);
    let barcodeDropped = false;
    for (let i = 0; i < 6 && error; i++) {
      // The next rounding that would actually change something.
      const next = isWholeNumberColumnError(error)
        ? roundingSteps.map(keys => rounded(current, keys)).find(r => JSON.stringify(r) !== JSON.stringify(current))
        : null;
      if (next) {
        current = next;
      } else if ('barcode' in current && !barcodeDropped) {
        // This database has not had the barcode column added yet. Save the
        // food without it rather than dropping the row entirely.
        const { barcode, ...withoutBarcode } = current;
        current = withoutBarcode;
        barcodeDropped = true;
      } else {
        break;
      }
      ({ error } = await send(current));
    }
    return { error };
  }

  isFoodUnitsLocallyDirty() {
    return this.foodUnitsSyncFailed
      || this.foodUnitsWritesInFlight > 0
      || (Date.now() - this.lastLocalFoodUnitsChange) < 4000;
  }

  async syncFoodUnits() {
    this.lastLocalFoodUnitsChange = Date.now();
    if (!this.supabase || !this.session.active) {
      this.saveLocalMirror();
      return { success: true };
    }

    this.foodUnitsWritesInFlight++;
    try {
      const map = this.foodUnitMap();
      if (Object.keys(map).length === 0) {
        const { error: delErr } = await this.supabase
          .from('macro_daily_logs')
          .delete()
          .eq('id', FOOD_UNITS_UUID);
        if (delErr) throw delErr;
        this.foodUnitsSyncFailed = false;
        return { success: true };
      }

      const record = {
        id: FOOD_UNITS_UUID,
        'Log Session': 'FOOD_UNITS',
        'Total Kcal': 0,
        'Total Protein': 0,
        'Total Carbs': 0,
        'Total Fat': 0,
        'Items Logged': JSON.stringify(map)
      };

      const { error: upsertErr } = await this.supabase
        .from('macro_daily_logs')
        .upsert([record], { onConflict: 'id' });

      if (upsertErr) {
        const { data: updated, error: updErr } = await this.supabase
          .from('macro_daily_logs')
          .update(record)
          .eq('id', FOOD_UNITS_UUID)
          .select();
        if (updErr || !updated || updated.length === 0) {
          const { error: insErr } = await this.supabase
            .from('macro_daily_logs')
            .insert([record]);
          if (insErr) throw upsertErr;
        }
      }

      this.foodUnitsSyncFailed = false;
      return { success: true };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.warn('syncFoodUnits failed:', msg);
      // Local is now the only copy, so a fetch must not overwrite it. It is
      // pushed again when the connection comes back.
      this.foodUnitsSyncFailed = true;
      return { success: false, error: msg };
    } finally {
      this.foodUnitsWritesInFlight--;
      this.lastLocalFoodUnitsChange = Date.now();
      this.saveLocalMirror();
    }
  }

  async syncActiveDraft() {
    if (!this.supabase) return;

    this.draftWritesInFlight++;
    this.lastLocalDraftChange = Date.now();
    try {
      if (this.todayMeals.length === 0) {
        // Clear both the canonical row and any legacy/stray draft rows, so an
        // emptied day really is empty on every device.
        const { error: delErr } = await this.supabase
          .from('macro_daily_logs')
          .delete()
          .eq('id', ACTIVE_DRAFT_UUID);
        if (delErr) throw delErr;
        await this.supabase
          .from('macro_daily_logs')
          .delete()
          .eq('Log Session', 'ACTIVE_DRAFT');
        return;
      }

      const totals = this.getTodayTotals();
      const draftRecord = {
        id: ACTIVE_DRAFT_UUID,
        "Log Session": "ACTIVE_DRAFT",
        "Total Kcal": totals.kcal,
        "Total Protein": totals.protein,
        "Total Carbs": totals.carbs,
        "Total Fat": totals.fat,
        "Items Logged": JSON.stringify(this.todayMeals)
      };

      const { error: upsertErr } = await this.supabase
        .from('macro_daily_logs')
        .upsert([draftRecord], { onConflict: 'id' });
      // Reaching here at all means the write went out; a failure below still
      // throws and re-raises the flag.
      this.draftSyncFailed = false;

      if (upsertErr) {
        const { data: updateData, error: updErr } = await this.supabase
          .from('macro_daily_logs')
          .update(draftRecord)
          .eq('Log Session', 'ACTIVE_DRAFT')
          .select();

        if (!updErr && updateData && updateData.length > 0) return;

        const { error: insErr } = await this.supabase
          .from('macro_daily_logs')
          .insert([draftRecord]);
        // Report the original upsert failure - it is the informative one.
        if (insErr) throw upsertErr;
      }
    } catch (err) {
      // Silently swallowing this meant a meal could look logged on screen
      // while never reaching the cloud, then vanish on the next sync.
      const msg = (err && err.message) || String(err);
      console.warn("syncActiveDraft failed:", err);
      this.draftSyncFailed = true;
      this.setSyncStatus(navigator.onLine ? 'error' : 'offline', msg);
      if (window.app) {
        window.app.showToast(`Meal not saved to cloud: ${msg}`, 'error');
      }
    } finally {
      this.draftWritesInFlight--;
      this.lastLocalDraftChange = Date.now();
      this.saveLocalMirror();
    }
  }

  // Reports what it did. A silent no-op is fine when this is a side effect of
  // logging a meal, but the Foods tab calls it on an explicit "Add Food", where
  // saying nothing would look like a success that added nothing.
  async addFoodToDatabase(food) {
    const foodName = (food.Item || food.name || '').trim();
    if (!foodName) return { added: false, duplicate: false, error: 'No food name' };
    const existing = this.foods.find(f => (f.Item || f.name || '').trim().toLowerCase() === foodName.toLowerCase());
    if (!existing) {
      const baseQty = food.baseQty || food.Quantity || 100;
      const baseKcal = food.baseKcal !== undefined ? food.baseKcal : (food.Kcal || 0);
      const baseProt = food.baseProt !== undefined ? food.baseProt : (food.Protein || 0);
      const baseCarb = food.baseCarb !== undefined ? food.baseCarb : (food.Carb || 0);
      const baseFat = food.baseFat !== undefined ? food.baseFat : (food.Fat || 0);

      const newFood = {
        id: generateUUID(),
        Item: foodName,
        Quantity: baseQty,
        Kcal: baseKcal,
        Protein: baseProt,
        Carb: baseCarb,
        Fat: baseFat
      };

      // Only carried when a barcode was actually scanned, so existing rows are
      // untouched and the column stays optional.
      if (food.barcode) newFood.barcode = food.barcode;

      // The serving type is not a column: it is kept on the food here and
      // synced in its own row, so it never goes into the insert. A decimal
      // serving is kept there exactly too.
      const local = { ...newFood, Unit: unitOfEntry(food) };
      this.foods.unshift(local);
      if (this.foodMapEntry(local) !== null) this.syncFoodUnits();
      if (this.supabase) {
        try {
          const { error } = await this.writeFoodRow(newFood);
          if (error) console.warn("Error inserting food database:", error);
        } catch (e) {
          console.warn("Error inserting food database:", e);
        }
      }
      return { added: true, duplicate: false };
    }
    return { added: false, duplicate: true };
  }

  // Both of these report failure rather than swallowing it. fetchCloudData()
  // replaces this.foods wholesale on every poll, so a cloud write that quietly
  // fails brings the old row straight back and looks like the app undid itself.
  async updateFoodInDatabase(id, patch) {
    const food = this.foods.find(f => f.id === id);
    if (!food) return { success: false, error: 'Food not found' };
    const entryBefore = JSON.stringify(this.foodMapEntry(food));
    Object.assign(food, patch);
    if (JSON.stringify(this.foodMapEntry(food)) !== entryBefore) this.syncFoodUnits();
    if (!this.supabase) return { success: true };
    try {
      const { error } = await this.writeFoodRow({
        Item: food.Item,
        Quantity: food.Quantity,
        Kcal: food.Kcal,
        Protein: food.Protein,
        Carb: food.Carb,
        Fat: food.Fat
      }, id);
      if (error) return { success: false, error: error.message || String(error) };
      return { success: true };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  }

  async deleteFoodFromDatabase(id) {
    const before = this.foods.length;
    const gone = this.foods.find(f => f.id === id);
    this.foods = this.foods.filter(f => f.id !== id);
    if (before === this.foods.length) return { success: false, error: 'Food not found' };
    if (gone && this.foodMapEntry(gone) !== null) this.syncFoodUnits();
    if (!this.supabase) return { success: true };
    try {
      const { error } = await this.supabase.from('macro_food_database').delete().eq('id', id);
      if (error) return { success: false, error: error.message || String(error) };
      return { success: true };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  }

  // Files meals out of Today's Log into the history under a date: all of
  // them, or just `onlyMeals` (left over from an earlier day, say), leaving
  // the rest where they are.
  async finishAndArchiveDay(selectedDateStr = null, mergeExistingId = null, onlyMeals = null) {
    const filing = onlyMeals ? this.todayMeals.filter(m => onlyMeals.includes(m)) : this.todayMeals.slice();
    if (filing.length === 0) return { success: false, error: 'No meals to log.' };
    const keep = this.todayMeals.filter(m => !filing.includes(m));
    // Whatever stays in Today's Log is synced; an empty log loses its row.
    const settleDraft = async () => {
      this.todayMeals = keep;
      if (keep.length) await this.syncActiveDraft();
      else await this.clearActiveDraftRow();
    };

    const totals = this.totalsOfMeals(filing);
    let baseDate = new Date();
    
    if (selectedDateStr) {
      const parts = selectedDateStr.split('-');
      if (parts.length === 3) {
        baseDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      } else {
        baseDate = new Date(selectedDateStr);
      }
    }

    const hours = new Date().getHours();
    const minutes = pad2(new Date().getMinutes());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    const timeStr = `${pad2(h12)}:${minutes} ${ampm}`;
    const dateFormatted = formatDateDMY(baseDate);
    const sessionDateFormatted = `${dateFormatted} - ${timeStr}`;

    // Path 1: Merge with existing log
    if (mergeExistingId) {
      const existingLog = this.pastLogs.find(l => l.id === mergeExistingId);
      if (existingLog) {
        existingLog['Total Kcal'] += totals.kcal;
        existingLog['Total Protein'] = Math.round((existingLog['Total Protein'] + totals.protein) * 10) / 10;
        existingLog['Total Carbs'] = Math.round((existingLog['Total Carbs'] + totals.carbs) * 10) / 10;
        existingLog['Total Fat'] = Math.round((existingLog['Total Fat'] + totals.fat) * 10) / 10;

        let existingParsed = [];
        try {
          existingParsed = JSON.parse(existingLog['Items Logged']);
        } catch(e) {}
        
        if (Array.isArray(existingParsed) && existingParsed.length > 0) {
          existingLog['Items Logged'] = JSON.stringify([...existingParsed, ...filing]);
        } else {
          existingLog['Items Logged'] = JSON.stringify([
            { name: "Previous Log", totals: {}, items: [{ qty: "Old", name: existingLog['Items Logged'] || 'Log' }] },
            ...filing
          ]);
        }

        if (this.supabase) {
           const { error: updErr } = await this.supabase.from('macro_daily_logs').update({
             "Total Kcal": existingLog['Total Kcal'],
             "Total Protein": existingLog['Total Protein'],
             "Total Carbs": existingLog['Total Carbs'],
             "Total Fat": existingLog['Total Fat'],
             "Items Logged": existingLog['Items Logged']
           }).eq('id', existingLog.id);
           
           if (updErr) return { success: false, error: updErr.message };
        }

        await settleDraft();

        return { success: true, merged: true, count: filing.length };
      }
    }

    const summaryItems = JSON.stringify(filing);
    
    const newLog = {
      id: generateUUID(),
      "Log Session": sessionDateFormatted,
      "Total Kcal": totals.kcal,
      "Total Protein": totals.protein,
      "Total Carbs": totals.carbs,
      "Total Fat": totals.fat,
      "Items Logged": summaryItems
    };

    if (this.supabase) {
      const { error: insErr } = await this.supabase.from('macro_daily_logs').insert([newLog]);
      if (insErr) return { success: false, error: insErr.message };
    }

    this.pastLogs.unshift(newLog);

    await settleDraft();

    return { success: true, merged: false, count: filing.length };
  }

  // Archiving a day removes the draft row directly. The dirty markers stop an
  // already-in-flight fetch from resurrecting the just-archived meals.
  async clearActiveDraftRow() {
    if (!this.supabase) return;
    this.draftWritesInFlight++;
    this.lastLocalDraftChange = Date.now();
    try {
      await this.supabase.from('macro_daily_logs').delete().eq('id', ACTIVE_DRAFT_UUID);
      await this.supabase.from('macro_daily_logs').delete().eq('Log Session', 'ACTIVE_DRAFT');
    } catch (e) {
      console.warn('clearActiveDraftRow notice:', e);
    } finally {
      this.draftWritesInFlight--;
      this.lastLocalDraftChange = Date.now();
      this.saveLocalMirror();
    }
  }

  async deleteTodayMeal(mealId) {
    this.todayMeals = this.todayMeals.filter(m => m.id !== mealId);
    await this.syncActiveDraft();
  }

  async updateTodayMeal(mealId, newName, newItems) {
    const meal = this.todayMeals.find(m => m.id === mealId);
    if (!meal) return;
    let totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    newItems.forEach(i => {
      totals.kcal += i.kcal || 0;
      totals.protein += i.protein || 0;
      totals.carbs += i.carbs || 0;
      totals.fat += i.fat || 0;
    });
    totals.kcal = Math.round(totals.kcal);
    totals.protein = Math.round(totals.protein * 10) / 10;
    totals.carbs = Math.round(totals.carbs * 10) / 10;
    totals.fat = Math.round(totals.fat * 10) / 10;

    meal.name = newName;
    meal.items = newItems;
    meal.totals = totals;

    await this.syncActiveDraft();
  }

  deletePastLog(id) {
    this.pastLogs = this.pastLogs.filter(l => l.id !== id);
    if (this.supabase) {
      this.supabase.from('macro_daily_logs').delete().eq('id', id).then(() => {}, () => {});
    }
  }

  async updatePastLog(id, updatedFields) {
    const log = this.pastLogs.find(l => l.id === id);
    if (!log) return { success: false, error: 'Log not found' };
    Object.assign(log, updatedFields);
    if (this.supabase) {
      const { error } = await this.supabase.from('macro_daily_logs').update(updatedFields).eq('id', id);
      if (error) {
        this.setSyncStatus('error', error.message);
        return { success: false, error: error.message };
      }
    }
    return { success: true };
  }

  // Returns the parsed meal array for a past log, or null when the log is in
  // the legacy plain-text format (which has no per-item macros to edit).
  getPastLogMeals(id) {
    const log = this.pastLogs.find(l => l.id === id);
    if (!log) return null;
    const raw = log['Items Logged'];
    if (typeof raw !== 'string' || !raw.trim().startsWith('[')) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  // Single source of truth for a past day's numbers: rewrite the meals, then
  // derive every meal subtotal and the day totals from the items themselves,
  // so the headline macros can never drift away from the food list again.
  async savePastLogMeals(id, meals) {
    const round1 = (n) => Math.round(n * 10) / 10;
    const dayTotals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

    const cleanedMeals = meals.map(meal => {
      const items = meal.items || [];
      const mealTotals = items.reduce((acc, i) => ({
        kcal: acc.kcal + (Number(i.kcal) || 0),
        protein: acc.protein + (Number(i.protein) || 0),
        carbs: acc.carbs + (Number(i.carbs) || 0),
        fat: acc.fat + (Number(i.fat) || 0)
      }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

      mealTotals.kcal = Math.round(mealTotals.kcal);
      mealTotals.protein = round1(mealTotals.protein);
      mealTotals.carbs = round1(mealTotals.carbs);
      mealTotals.fat = round1(mealTotals.fat);

      dayTotals.kcal += mealTotals.kcal;
      dayTotals.protein += mealTotals.protein;
      dayTotals.carbs += mealTotals.carbs;
      dayTotals.fat += mealTotals.fat;

      return { ...meal, items, totals: mealTotals };
    }).filter(meal => meal.items.length > 0);

    return this.updatePastLog(id, {
      "Items Logged": JSON.stringify(cleanedMeals),
      "Total Kcal": Math.round(dayTotals.kcal),
      "Total Protein": round1(dayTotals.protein),
      "Total Carbs": round1(dayTotals.carbs),
      "Total Fat": round1(dayTotals.fat)
    });
  }

  saveFavorite(name, items) {
    const newFav = {
      id: generateUUID(),
      Name: name,
      Items: JSON.stringify(items)
    };
    this.favorites.unshift(newFav);
    if (this.supabase) {
      this.supabase.from('macro_tracker_favorites').insert([newFav]).then(() => {}, () => {});
    }
  }

  deleteFavorite(id) {
    this.favorites = this.favorites.filter(f => f.id !== id);
    if (this.supabase) {
      this.supabase.from('macro_tracker_favorites').delete().eq('id', id).then(() => {}, () => {});
    }
  }

  deleteWeight(id) {
    this.weights = this.weights.filter(w => w.id !== id);
    if (this.supabase) {
      this.supabase.from('macro_weight_tracker').delete().eq('id', id).then(() => {}, () => {});
    }
  }

  // Writes that carry a bf column retry without it, the same way saving a
  // food does with its barcode: a database that predates the column should
  // still take the rest of the row rather than rejecting the whole write.
  async writeWeightRow(op, id, row) {
    if (!this.supabase) return { success: true };
    const table = () => this.supabase.from('macro_weight_tracker');
    const run = (payload) => op === 'insert'
      ? table().insert([payload])
      : table().update(payload).eq('id', id);
    try {
      const { error } = await run(row);
      if (error && Object.prototype.hasOwnProperty.call(row, 'bf')) {
        const { bf, ...withoutBf } = row;
        const retry = await run(withoutBf);
        if (retry.error) return { success: false, error: retry.error.message || String(retry.error) };
        return { success: true, bfColumnMissing: true };
      }
      if (error) return { success: false, error: error.message || String(error) };
      return { success: true };
    } catch (e) {
      return { success: false, error: (e && e.message) || String(e) };
    }
  }

  async updateWeight(id, patch) {
    const entry = this.weights.find(w => w.id === id);
    if (!entry) return { success: false, error: 'Entry not found' };
    Object.assign(entry, patch);
    this.weights.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const res = await this.writeWeightRow('update', id, {
      date: entry.date,
      weight: entry.weight,
      bf: entry.bf
    });
    this.saveLocalMirror();
    return res;
  }
}

const store = new MacroDataStore();
// A top-level `const` in a classic script lives in the global lexical scope and
// is NOT a property of window, so every `if (window.app)` / `window.store`
// guard silently evaluated false: the post-fetch re-render and the post-session
// checkAuth never ran, leaving freshly synced cloud data invisible on screen.
window.store = store;

// APPLICATION UI CONTROLLER
class MacroApp {
  // The rows live on the store so they sync and mirror with everything else.
  // Reading them through an accessor keeps every existing call site working.
  get builderRows() { return store.builderRows; }
  set builderRows(rows) { store.builderRows = rows; }

  constructor() {
    this.activeView = 'dashboard';
    this.suppressBuilderSync = false;
    this.builderSyncTimer = null;
    // The Tracker page shows one day at a time. null means "today" and
    // follows the clock, so a phone left open overnight rolls over to the
    // new day instead of stranding you on yesterday with no Meal Builder.
    this.selectedDate = null;
    // The Sunday of the week on the strip once the arrows or a swipe have
    // paged away from the selected day's own week, or null. Paging only
    // moves the strip - the day below changes when a day is tapped.
    this.stripWeek = null;
    // Set by a swipe on the week strip so the click that ends it does not
    // also select whichever day the pointer was lifted over.
    this.stripSwiped = false;
    this.historySearchOpen = false;
    // The week chart always starts folded away; the strip alone is the default.
    this.weekBarsOpen = false;
    // The logged meal currently loaded into the Meal Builder for editing, or
    // null. While set, the builder's own foods wait in store.builderStash.
    this.mealEdit = null;
    // The open ⋮ menu: { el, anchor }, or null.
    this.actionMenu = null;
    // 'builder' when a scan fills a Meal Builder row, 'database' when it came
    // from the Foods page and should end up saved as a food.
    this.scanPurpose = 'builder';
    this.weightChart = null;
    this.deferredPwaPrompt = null;
    this.searchDebounceTimers = {};
    this.searchRequestCounters = {};
    this.openHistoryCards = new Set();
    this.openTodayMeals = new Set();
    this.openHistoryMeals = new Set();
    this.pendingRender = false;
    // Barcode scanner state
    this.scanTargetRowId = null;
    this.scanStream = null;
    this.scanRafId = null;
    this.scanActive = false;
    this.barcodeDetector = null;
    this.pendingScannedFood = null;
    this.torchOn = false;
    this.scanCandidate = null;
    this.scanCandidateCount = 0;
    this.scanStartedAt = 0;
    this.lastDetectAt = 0;
    this.scanCanvas = null;
    this.notFoundBarcode = null;
    this.foodSearchCache = new Map();
    this.cameraDevices = [];
    // Per-row search paging/filter state, keyed by builder row id.
    this.searchState = {};
    this.storeChips = [
      { label: 'Tesco', value: 'tesco' },
      { label: 'Aldi', value: 'aldi' },
      { label: 'Lidl', value: 'lidl' },
      { label: "Sainsbury's", value: "sainsbury's" },
      { label: 'Dunnes', value: 'dunnes-stores' },
      { label: 'SuperValu', value: 'supervalu' }
    ];
    // Paginated lists: render 10, extend on demand.
    this.historyVisibleCount = 10;
    this.historySearchQuery = '';
    // Parsed "Items Logged" blobs, kept against the raw string so typing a
    // query does not re-parse every logged day on every keystroke.
    this.historyIndexCache = new Map();
    this.weightVisibleCount = 10;
    // 'weight' | 'bf' | 'both'
    // Weight and body fat together is the view worth opening on: the two
    // only mean something read against each other. Falls back to weight
    // alone below when no body fat has been recorded yet.
    this.weightChartMode = 'both';
    this.foodsVisibleCount = 10;
    this.foodsSearchQuery = '';
    // One of FOOD_SORTS' ids, remembered on this device.
    this.foodsSort = 'name';
    try { this.foodsSort = localStorage.getItem('macroFoodsSort') || 'name'; } catch (e) { /* private mode */ }
    this.keyboardScrollTimer = null;
    this.editingTodayItem = null;
    // Voice state
    this.recognition = null;
    this.voiceItems = [];
    this.voiceListening = false;
    this.voiceSegments = [];
    this.voiceLiveTimer = null;
    this.voiceListFrozen = false;
    // Open dialogs, oldest first. Mirrored by one history entry so the phone's
    // back gesture closes the dialog rather than leaving the app.
    this.modalStack = [];
    this.focusBeforeModal = null;
    this.modalHistoryGuard = 0;
    this.modalHistoryTimer = null;
    this.ignoreNextPop = false;
    this.ignorePopTimer = null;
  }

  init() {
    this.checkAuth();
    // renderBuilderRows() seeds the first empty row itself - adding one here
    // too is what produced two blank rows on load.
    this.bindEvents();
    this.setupSyncTriggers();
    this.registerServiceWorker();
    this.setupPwaInstallUI();
    this.enhanceDateInputs();
    this.renderAll();
  }

  // A native date field lays its text out in the browser's own locale, and
  // Chrome ignores lang= on the element - so on an en-US browser it reads
  // 09/25/2026 whatever the page asks for. The native field stays (its
  // picker, and its ISO value that everything else reads), with its own
  // text hidden and a day/month/year label drawn over it.
  enhanceDateInputs() {
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    document.querySelectorAll('input[type="date"]').forEach(input => {
      // The week strip's field is never seen - only its picker is - so it
      // has no text to relabel.
      if (input.dataset.dmy || input.hasAttribute('data-picker-only')) return;
      input.dataset.dmy = '1';

      const wrap = document.createElement('div');
      wrap.className = 'date-field';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      input.classList.add('date-native');

      const label = document.createElement('span');
      label.className = 'date-field-label';
      label.setAttribute('aria-hidden', 'true');
      wrap.appendChild(label);

      const refresh = () => {
        const v = valueDesc.get.call(input);
        label.textContent = v ? formatDateDMYShort(v) : 'dd/mm/yy';
        label.classList.toggle('is-empty', !v);
      };

      // The app fills these fields in code (today's date, the entry being
      // edited). None of that fires an input event, so the label listens
      // on the value itself rather than on every place that sets it.
      Object.defineProperty(input, 'value', {
        configurable: true,
        get() { return valueDesc.get.call(this); },
        set(v) { valueDesc.set.call(this, v); refresh(); }
      });
      input.addEventListener('input', refresh);
      input.addEventListener('change', refresh);

      // With its text hidden the field has nothing to click into, so the
      // whole box opens the calendar rather than just the icon.
      input.addEventListener('click', () => {
        if (typeof input.showPicker === 'function') {
          try { input.showPicker(); } catch (e) { /* already open, or not allowed */ }
        }
      });

      refresh();
    });
  }

  checkAuth() {
    const loginView = document.getElementById('login-screen-view');
    const mainApp = document.getElementById('main-app-container');
    // A real Supabase user object is required - a locally-set flag alone is
    // never enough to unlock the app.
    const isAuthenticated = !!(store.session && store.session.active && store.session.user);
    if (loginView && mainApp) {
      if (isAuthenticated) {
        loginView.classList.add('hidden');
        mainApp.classList.remove('hidden');
        document.body.classList.add('app-active');
        this.renderAll();
      } else {
        loginView.classList.remove('hidden');
        mainApp.classList.add('hidden');
        document.body.classList.remove('app-active');
      }
    }
  }

  setupSyncTriggers() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        store.scheduleCloudFetch(150);
      } else {
        // About to lose the page: a mirror write waiting for idle time
        // would never get it.
        store.flushLocalMirror();
      }
    });
    // On a phone this fires every time the keyboard opens or a dialog takes
    // focus, so it schedules a sync rather than starting one outright.
    window.addEventListener('focus', () => {
      store.scheduleCloudFetch(150);
    });
    window.addEventListener('pagehide', () => store.flushLocalMirror());
    // Realtime postgres_changes already pushes updates the instant another
    // device writes, so this is only a safety net for a dropped subscription.
    // It used to run every 4s, which - once the render path was fixed - meant
    // the whole UI repainted constantly and collapsed whatever you had open.
    setInterval(() => {
      if (document.visibilityState === 'visible' && store.session && store.session.active) {
        store.fetchCloudData();
      }
    }, 60000);
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  setupPwaInstallUI() {
    const installBtn = document.getElementById('pwa-install-btn');
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.deferredPwaPrompt = event;
      if (installBtn) {
        installBtn.style.display = 'flex';
        installBtn.classList.add('visible');
      }
    });
  }

  // BULLETPROOF DELETE MODAL
  confirmDelete(actionFn, message) {
    this.setConfirmDialogText('Confirm Deletion', 'Confirm Delete', true);
    const msgEl = document.getElementById('delete-confirm-message');
    if (msgEl) msgEl.textContent = message;

    const confirmBtn = document.getElementById('confirm-delete-action-btn');
    if (confirmBtn) {
      // Dynamic reassignment guarantees 100% reliable execution
      confirmBtn.onclick = () => {
        actionFn();
        this.closeModal('delete-confirm-modal');
      };
    }
    this.openModal('delete-confirm-modal');
  }

  // The same dialog for a question that is not a deletion, so it does not
  // shout "Confirm Delete" in red at an ordinary choice.
  confirmAction({ title, message, confirmLabel, onConfirm }) {
    this.setConfirmDialogText(title, confirmLabel, false);
    const msgEl = document.getElementById('delete-confirm-message');
    if (msgEl) msgEl.textContent = message;
    const confirmBtn = document.getElementById('confirm-delete-action-btn');
    if (confirmBtn) {
      // Closed first: renderAll() holds off while any dialog is open.
      confirmBtn.onclick = () => {
        this.closeModal('delete-confirm-modal');
        onConfirm();
      };
    }
    this.openModal('delete-confirm-modal');
  }

  setConfirmDialogText(title, confirmLabel, danger) {
    const titleEl = document.getElementById('delete-confirm-modal-title');
    const confirmBtn = document.getElementById('confirm-delete-action-btn');
    if (titleEl) titleEl.textContent = title;
    if (confirmBtn) {
      confirmBtn.textContent = confirmLabel;
      confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
    }
  }

  bindEvents() {
    const loginForm = document.getElementById('main-login-form');
    const authErrorAlert = document.getElementById('login-auth-error-msg');
    
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = (document.getElementById('login-email-input').value || '').trim();
        const password = document.getElementById('login-password-input').value;
        if (authErrorAlert) authErrorAlert.style.display = 'none';

        if (!email || !password || password.length < 6) {
          if (authErrorAlert) {
            authErrorAlert.style.display = 'block';
            authErrorAlert.textContent = 'Please enter your email and password (at least 6 characters).';
          }
          return;
        }

        const submitBtn = document.getElementById('login-signin-btn');
        const submitLabel = document.getElementById('login-signin-label');
        if (submitBtn) submitBtn.disabled = true;
        if (submitLabel) submitLabel.textContent = 'Signing in…';
        if (authErrorAlert) authErrorAlert.style.display = 'none';
        const res = await store.signIn(email, password);
        if (submitBtn) submitBtn.disabled = false;
        if (submitLabel) submitLabel.textContent = 'Sign in';

        if (res.error) {
          if (authErrorAlert) {
            const msg = res.error.message || '';
            authErrorAlert.style.display = 'block';
            authErrorAlert.textContent = /invalid login credentials/i.test(msg)
              ? "That email and password don't match. Check them and try again."
              : (msg ? `Could not sign in: ${msg}` : 'Could not sign in. Check your connection and try again.');
          }
          return;
        }

        this.checkAuth();
        this.showToast(`Logged in as ${store.session.email}`, 'success');
      });
    }

    const signUpBtn = document.getElementById('login-signup-btn');
    if (signUpBtn) {
      signUpBtn.addEventListener('click', async () => {
        const email = (document.getElementById('login-email-input').value || '').trim();
        const password = document.getElementById('login-password-input').value;
        if (!email || !password || password.length < 6) {
          if (authErrorAlert) {
            authErrorAlert.style.display = 'block';
            authErrorAlert.textContent = 'Please enter an email and a password with at least 6 characters.';
          }
          return;
        }
        const res = await store.signUp(email, password);
        if (res.error) {
          if (authErrorAlert) {
            authErrorAlert.style.display = 'block';
            authErrorAlert.textContent = res.error.message;
          }
        } else if (store.session.active) {
          this.checkAuth();
          this.showToast('Account created - welcome!', 'success');
        } else {
          if (authErrorAlert) {
            authErrorAlert.style.display = 'block';
            authErrorAlert.textContent = 'Account created! Check your email to confirm it, then sign in.';
          }
        }
      });
    }

    document.querySelectorAll('[data-nav-target]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-nav-target');
        this.switchView(target);
      });
    });

    const addRowBtn = document.getElementById('add-builder-row-btn');
    if (addRowBtn) {
      addRowBtn.addEventListener('click', () => {
        this.addNewBuilderRow();
        this.renderBuilderRows();
        // Straight into the new row's name field, in the same tick as the
        // tap. A phone only raises its keyboard for a focus() made inside the
        // user's own gesture; deferred behind a timer, iOS in particular
        // focuses the field but leaves the keyboard down.
        const added = this.builderRows[this.builderRows.length - 1];
        if (added) this.focusBuilderRowName(added.id);
      });
    }

    const logMealBtn = document.getElementById('log-meal-submit-btn');
    if (logMealBtn) {
      logMealBtn.addEventListener('click', () => this.handleLogMeal());
    }

    const logDayForm = document.getElementById('log-day-archive-form');
    if (logDayForm) {
      logDayForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleLogDaySubmit();
      });
    }

    const saveFoodDbForm = document.getElementById('save-food-db-form');
    if (saveFoodDbForm) {
      saveFoodDbForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveFoodToDbSubmit();
      });
    }

    const editTodayForm = document.getElementById('edit-today-meal-form');
    if (editTodayForm) {
      editTodayForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveEditedTodayMeal();
      });
    }

    const editHistoryForm = document.getElementById('edit-history-log-form');
    if (editHistoryForm) {
      editHistoryForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveEditedHistoryLog();
      });
    }

    const editHistoryItemForm = document.getElementById('edit-history-item-form');
    if (editHistoryItemForm) {
      editHistoryItemForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveEditedHistoryItem();
      });
    }

    const editTodayItemForm = document.getElementById('edit-today-item-form');
    if (editTodayItemForm) {
      editTodayItemForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveEditedTodayItem();
      });
    }

    const targetsForm = document.getElementById('target-macros-form');
    if (targetsForm) {
      targetsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleTargetsSubmit();
      });
    }

    const saveFavoriteForm = document.getElementById('save-favorite-form');
    if (saveFavoriteForm) {
      saveFavoriteForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleSaveFavoriteSubmit();
      });
    }

    const editWeightForm = document.getElementById('edit-weight-form');
    if (editWeightForm) {
      editWeightForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleEditWeightSubmit();
      });
    }

    const weightForm = document.getElementById('weight-quick-form');
    if (weightForm) {
      weightForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleWeightSubmit();
      });
    }

    document.querySelectorAll('[data-modal-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Close only the dialog this button belongs to. Now that dialogs
        // stack, closing all of them would drop the one underneath too.
        const overlay = btn.closest('.modal-overlay');
        if (overlay && overlay.id) this.closeModal(overlay.id);
        else this.closeAllModals();
      });
    });

    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal && modal.id) this.closeModal(modal.id);
      });
    });

    // Esc closes the top-most dialog. Rows with an open result list handle Esc
    // themselves and stop it before it reaches here.
    document.addEventListener('keydown', (e) => this.handleModalTab(e));

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (this.actionMenu) {
        e.preventDefault();
        const anchor = this.actionMenu.anchor;
        this.closeActionMenu();
        if (anchor && anchor.focus) anchor.focus();
        return;
      }
      const menu = document.getElementById('header-menu-dropdown');
      if (menu && menu.classList.contains('open')) {
        e.preventDefault();
        this.closeHeaderMenu();
        return;
      }
      const top = this.getTopModal();
      if (!top) return;
      e.preventDefault();
      this.closeModal(top);
    });

    // Android back / browser back while a dialog is open pops the guard entry
    // we pushed when it opened, so it closes the dialog and stops there.
    window.addEventListener('popstate', () => this.handleHistoryPop());

    // Losing the connection is worth saying out loud: without it a failed save
    // just looks like the app is broken.
    const syncOnlineState = (justCameBack) => {
      const offline = !navigator.onLine;
      document.body.classList.toggle('is-offline', offline);
      if (offline) store.setSyncStatus('offline');
      else if (justCameBack) {
        if (store.carriesSyncFailed) store.syncCarries();
        if (store.foodUnitsSyncFailed) store.syncFoodUnits();
        store.fetchCloudData();
      }
    };
    window.addEventListener('online', () => syncOnlineState(true));
    window.addEventListener('offline', () => syncOnlineState(false));
    syncOnlineState(false);

    // A floating menu is placed against the page as it was when opened, so
    // it closes rather than drift once anything scrolls or resizes.
    window.addEventListener('scroll', () => this.closeActionMenu(), { passive: true, capture: true });
    window.addEventListener('resize', () => this.closeActionMenu());

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.header-menu-wrap')) this.closeHeaderMenu();
      if (!e.target.closest('.action-menu, .menu-trigger')) this.closeActionMenu();
      if (!e.target.closest('.food-builder-row')) {
        // Full close, not just the class: a pending search would otherwise
        // resolve and pop the list back open.
        this.builderRows.forEach(r => this.closeRowDropdown(r.id));
      }
    });

    // Keep a focused field visible when the mobile keyboard slides up. The
    // browser already scrolls a focused field into view itself, so this only
    // steps in when that was not enough, and only once the keyboard has
    // stopped moving. Scrolling on every visualViewport resize restarted a
    // smooth scroll on each frame of the keyboard animation, fighting both the
    // animation and the browser's own scroll - that was the stutter as the
    // keyboard came and went.
    const revealFocusedField = () => {
      if (window.innerWidth > 680) return;
      const el = document.activeElement;
      if (!el || !el.matches || !el.matches('input, textarea, select')) return;
      const vv = window.visualViewport;
      const visibleTop = vv ? vv.offsetTop : 0;
      const visibleBottom = visibleTop + (vv ? vv.height : window.innerHeight);
      const r = el.getBoundingClientRect();
      if (r.top >= visibleTop + 8 && r.bottom <= visibleBottom - 8) return;
      try {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (err) {
        el.scrollIntoView(false);
      }
    };

    // Moving between fields with the keyboard already up fires no resize,
    // so focus gets its own check once any keyboard animation is over.
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el || !el.matches || !el.matches('input, textarea, select')) return;
      clearTimeout(this.keyboardScrollTimer);
      this.keyboardScrollTimer = setTimeout(revealFocusedField, 350);
    });

    document.addEventListener('focusout', () => {
      clearTimeout(this.keyboardScrollTimer);
      this.keyboardScrollTimer = null;
    });

    // Resize fires dozens of times while the keyboard slides. Wait for it to
    // settle, then act once - and only when the keyboard opened. Closing it
    // just hands space back, and nothing needs to move.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      let settledHeight = vv.height;
      let settleTimer = null;
      vv.addEventListener('resize', () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          const opened = vv.height < settledHeight;
          settledHeight = vv.height;
          if (!opened) return;
          clearTimeout(this.keyboardScrollTimer);
          revealFocusedField();
        }, 150);
      });
    }
  }

  // Targets and sign-out live behind one overflow button rather than sitting
  // in the header permanently.
  // EXPORT
  // Everything lives in one Supabase project. These give you a copy on the
  // device that does not depend on that project still being there.
  downloadFile(filename, mime, text) {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return true;
    } catch (e) {
      this.showToast(`Could not start the download: ${(e && e.message) || e}`, 'error');
      return false;
    }
  }

  exportStamp() {
    return formatDateDMY(new Date()).replace(/\//g, '-');
  }

  csvCell(v) {
    const str = (v === null || v === undefined) ? '' : String(v);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  toCsv(headers, rows) {
    return [headers, ...rows]
      .map(r => r.map(c => this.csvCell(c)).join(','))
      .join('\r\n');
  }

  exportJsonBackup() {
    const payload = {
      schema: 'macro-tracker-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      account: (store.session && store.session.email) || null,
      targets: store.targets,
      foods: store.foods,
      favorites: store.favorites,
      weights: store.weights,
      pastLogs: store.pastLogs,
      todayMeals: store.todayMeals,
      carries: store.carries
    };
    if (this.downloadFile(
      `macro-tracker-backup-${this.exportStamp()}.json`,
      'application/json',
      JSON.stringify(payload, null, 2)
    )) {
      this.showToast('Full backup downloaded', 'success');
    }
  }

  exportDaysCsv() {
    if (store.pastLogs.length === 0) {
      this.showToast('No archived days to export yet', 'error');
      return;
    }
    const csv = this.toCsv(
      ['Log Session', 'Kcal', 'Protein (g)', 'Carbs (g)', 'Fat (g)'],
      store.pastLogs.map(l => [
        l['Log Session'],
        l['Total Kcal'],
        l['Total Protein'],
        l['Total Carbs'],
        l['Total Fat']
      ])
    );
    if (this.downloadFile(`macro-tracker-days-${this.exportStamp()}.csv`, 'text/csv', csv)) {
      this.showToast(`${plural(store.pastLogs.length, 'day')} exported`, 'success');
    }
  }

  exportFoodsCsv() {
    if (store.foods.length === 0) {
      this.showToast('Your food list is empty', 'error');
      return;
    }
    const csv = this.toCsv(
      ['Item', 'Serving', 'Serving type', 'Kcal', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Barcode'],
      store.foods.map(f => [f.Item, f.Quantity, unitInfo(unitOfEntry(f)).label, f.Kcal, f.Protein, f.Carb, f.Fat, f.barcode || ''])
    );
    if (this.downloadFile(`macro-tracker-foods-${this.exportStamp()}.csv`, 'text/csv', csv)) {
      this.showToast(`${plural(store.foods.length, 'food')} exported`, 'success');
    }
  }

  exportWeightsCsv() {
    if (store.weights.length === 0) {
      this.showToast('No weight entries to export yet', 'error');
      return;
    }
    const csv = this.toCsv(
      ['Date', 'Weight (kg)'],
      store.weights.map(w => [formatDateDMY(w.date), w.weight])
    );
    if (this.downloadFile(`macro-tracker-weights-${this.exportStamp()}.csv`, 'text/csv', csv)) {
      this.showToast(`${plural(store.weights.length, 'weigh-in')} exported`, 'success');
    }
  }

  openExportModal() {
    const counts = document.getElementById('export-counts');
    if (counts) {
      counts.textContent =
        `${plural(store.pastLogs.length, 'logged day')} · ${plural(store.foods.length, 'food')} · ` +
        `${plural(store.favorites.length, 'favorite')} · ${plural(store.weights.length, 'weigh-in')}`;
    }
    this.openModal('export-data-modal');
  }

  toggleHeaderMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('header-menu-dropdown');
    if (!menu) return;
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    const btn = document.getElementById('header-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  closeHeaderMenu() {
    const menu = document.getElementById('header-menu-dropdown');
    if (menu) menu.classList.remove('open');
    const btn = document.getElementById('header-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // A plain reload: it picks up a newer deployed version as well as the
  // latest data, and nothing is held only in memory - meals live in the
  // cloud with an on-device mirror behind them.
  reloadApp() {
    location.reload();
  }

  handleLogout() {
    this.closeHeaderMenu();
    // Signing out wipes the stash along with everything else.
    this.mealEdit = null;
    this.applyMealEditState();
    store.signOut();
    this.checkAuth();
    this.showToast('Signed out', 'success');
  }

  switchView(viewName) {
    this.activeView = viewName;
    document.querySelectorAll('[data-nav-target]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-nav-target') === viewName);
    });
    document.querySelectorAll('.view-panel').forEach(p => p.style.display = 'none');
    
    const targetPanel = document.getElementById(`panel-${viewName}`);
    if (targetPanel) targetPanel.style.display = 'flex';
    if (viewName === 'foods') this.renderFoodsList();
    if (viewName === 'weights') setTimeout(() => this.renderWeightChart(), 60);
  }

  renderAll() {
    // Never rebuild the DOM out from under an open dialog - it would wipe
    // half-typed values. The repaint is deferred until the dialog closes.
    if (document.querySelector('.modal-overlay.active')) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    this.renderWeekStrip();
    this.renderDailySubtotal();
    // renderAll fires on every cloud sync; without this the repaint would be
    // read as a local edit and written straight back, and two devices would
    // bounce the draft between each other forever.
    this.renderBuilderRowsFromRemote();
    this.renderTodaysLogs();
    this.renderDayLogs();
    if (this.historySearchOpen) this.renderHistoryList();
    if (this.activeView === 'foods') this.renderFoodsList();
    if (this.activeView === 'weights') this.renderWeightChart();
  }

  // The summary card follows the day picked on the week strip. For today it
  // counts both the meals still in Today's Log and anything already archived
  // with Finish day under today's date, so the card agrees with the strip.
  renderDailySubtotal() {
    const date = this.getSelectedDate();
    const totals = this.getDayTotals(date);
    const targets = this.targetsFor(date);
    // Any day but today turns the card's header into a tinted banner - how
    // long ago it was, the full date and a way back - so a past day can never
    // be mistaken for today at a glance.
    const isToday = this.isViewingToday();
    const card = document.getElementById('day-summary-card');
    if (card) card.classList.toggle('not-today', !isToday);
    const kicker = document.getElementById('day-away-kicker');
    if (kicker) kicker.textContent = isToday ? '' : this.relativeDayLabel(date);
    const dateSub = document.getElementById('subtotal-current-date-lbl');
    if (dateSub) {
      const opts = isToday
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : { weekday: 'long', day: 'numeric', month: 'long' };
      if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
      // en-GB puts a comma after the weekday ("Fri, 25 Sep").
      const day = date.toLocaleDateString('en-GB', opts).replace(',', '');
      dateSub.textContent = isToday ? `Today · ${day}` : day;
    }

    const kcalEl = document.getElementById('day-subtotal-kcal');
    const kcalSub = document.getElementById('day-target-kcal-sub');
    const protEl = document.getElementById('day-subtotal-prot');
    const protSub = document.getElementById('day-target-prot-sub');
    const carbEl = document.getElementById('day-subtotal-carb');
    const carbSub = document.getElementById('day-target-carb-sub');
    const fatEl = document.getElementById('day-subtotal-fat');
    const fatSub = document.getElementById('day-target-fat-sub');

    if (kcalEl) kcalEl.textContent = totals.kcal.toLocaleString();
    if (kcalSub) kcalSub.textContent = `/ ${targets.kcal.toLocaleString()} kcal`;
    if (protEl) protEl.textContent = `${totals.protein}g`;
    if (protSub) protSub.textContent = `/ ${targets.protein}g`;
    if (carbEl) carbEl.textContent = `${totals.carbs}g`;
    if (carbSub) carbSub.textContent = `/ ${targets.carbs}g`;
    if (fatEl) fatEl.textContent = `${totals.fat}g`;
    if (fatSub) fatSub.textContent = `/ ${targets.fat}g`;

    // What is left is the number you actually act on at six in the evening;
    // consumed-over-target only tells you where you have been.
    const setRemaining = (id, consumed, target, isKcal) => {
      const el = document.getElementById(id);
      if (!el) return;
      const left = Math.round((target - consumed) * 10) / 10;
      const over = left < 0;
      const n = Math.abs(left);
      const shown = isKcal ? Math.round(n).toLocaleString() : `${n}g`;
      el.textContent = over ? `${shown} over` : `${shown} left`;
      el.classList.toggle('over', over);
      // The bar under each figure: how far through the target the day is,
      // full and red once past it.
      const bar = document.getElementById(id.replace('day-remaining-', 'day-progress-'));
      if (bar) {
        const pct = target > 0 ? Math.min(100, (consumed / target) * 100) : 0;
        bar.classList.toggle('over', over);
        bar.setAttribute('aria-valuemax', String(Math.round(target)));
        bar.setAttribute('aria-valuenow', String(Math.round(consumed)));
        const fill = bar.firstElementChild;
        if (fill) fill.style.width = `${pct.toFixed(1)}%`;
      }
    };
    setRemaining('day-remaining-kcal', totals.kcal, targets.kcal, true);
    setRemaining('day-remaining-prot', totals.protein, targets.protein, false);
    setRemaining('day-remaining-carb', totals.carbs, targets.carbs, false);
    setRemaining('day-remaining-fat', totals.fat, targets.fat, false);

    this.renderCarryControls(date, totals, targets);
  }

  // The Calories tile's carry button and the brackets beside its target
  // saying why the target moved.
  renderCarryControls(date, totals, targets) {
    const btn = document.getElementById('day-carry-btn');
    const label = document.getElementById('day-carry-label');
    const note = document.getElementById('day-target-note');
    const st = this.carryStateFor(date, totals);

    if (note) {
      const text = targets.delta ? this.carryNoteFor(st.iso) : '';
      note.textContent = text ? `(${text})` : '';
      note.hidden = !text;
      const group = note.closest('.stat-value-group');
      if (group) group.classList.toggle('has-note', !!text);
    }
    if (!btn || !label) return;

    let text = '';
    let title = '';
    if (st.carry) {
      text = 'Carried';
      title = 'Change or undo this carry';
    } else if (st.isPast && st.canCarry) {
      const n = Math.abs(st.balance).toLocaleString();
      text = `Carry ${n} kcal`;
      title = st.balance > 0
        ? `Move this day's ${n} kcal under onto the days left this week`
        : `Take this day's ${n} kcal over back from the days left this week`;
    } else if (st.canPlan) {
      text = st.plan ? (st.plan.delta > 0 ? 'High day' : 'Low day') : 'Plan day';
      title = st.plan ? 'Change or remove this plan' : 'Make this a high or low day, balanced by the rest of the week';
    }
    btn.hidden = !text;
    btn.classList.toggle('is-set', !!(st.carry || st.plan));
    label.textContent = text;
    btn.title = title;
  }

  // THE CARRY SHEET
  // One dialog for both jobs. `mode` is 'carry' (move a finished day's
  // balance) or 'plan' (raise or lower a day still to come).
  openCarrySheet(mode = null) {
    const date = this.getSelectedDate();
    const st = this.carryStateFor(date);
    if (!mode) mode = st.carry || st.isPast ? 'carry' : 'plan';
    if (mode === 'carry' && !st.canCarry) mode = 'plan';
    if (mode === 'plan' && !st.canPlan) return;

    const sheet = { date, mode, planDir: 1, amount: 500, dest: 'spread', oneDay: null };
    if (mode === 'carry') this.resetCarrySheetCarry(sheet, st);
    else this.resetCarrySheetPlan(sheet, st);
    this.carrySheet = sheet;

    const form = document.getElementById('carry-form');
    if (form) form.onsubmit = (e) => { e.preventDefault(); this.submitCarrySheet(); };
    this.renderCarrySheet(true);
    this.openModal('carry-modal');
  }

  // An existing carry opens as it was saved; a new one offers the whole
  // balance, spread over the rest of the week.
  resetCarrySheetCarry(sheet, st) {
    const all = this.carrySpreadDays(sheet.date).map(toISODateLocal);
    sheet.amount = st.carry ? Math.abs(st.carry.delta) : Math.abs(st.balance);
    sheet.dest = 'spread';
    sheet.oneDay = all[all.length - 1] || null;
    if (st.carry && st.carry.spread.length === 1 && all.length > 1 && all.includes(st.carry.spread[0])) {
      sheet.dest = 'one';
      sheet.oneDay = st.carry.spread[0];
    }
  }

  resetCarrySheetPlan(sheet, st) {
    sheet.planDir = st.plan ? Math.sign(st.plan.delta) : 1;
    sheet.amount = st.plan ? Math.abs(st.plan.delta) : 500;
  }

  // Pass rerenderInput=false while the amount is being typed, so the field
  // keeps its caret.
  setCarrySheet(patch, rerenderInput = true) {
    if (!this.carrySheet) return;
    const s = this.carrySheet;
    const switching = patch.mode && patch.mode !== s.mode;
    Object.assign(s, patch);
    if (switching) {
      const st = this.carryStateFor(s.date);
      if (s.mode === 'carry') this.resetCarrySheetCarry(s, st);
      else this.resetCarrySheetPlan(s, st);
      rerenderInput = true;
    }
    this.renderCarrySheet(rerenderInput);
  }

  // The carry the sheet would save right now, and what is wrong with it.
  carrySheetProposal() {
    const s = this.carrySheet;
    const st = this.carryStateFor(s.date);
    const amount = Math.round(Number(s.amount) || 0);
    const existing = s.mode === 'carry' ? st.carry : st.plan;
    let spreadDays;
    let delta;
    let error = '';
    if (s.mode === 'carry') {
      spreadDays = this.carrySpreadDays(s.date).map(toISODateLocal);
      const max = Math.abs(st.balance);
      delta = st.balance > 0 ? -amount : amount;
      if (max === 0) error = 'This day is right on target, so there is nothing to carry.';
      else if (amount < 1) error = 'Enter how many calories to carry.';
      else if (amount > max) error = `At most ${max.toLocaleString()}, the whole of this day's balance.`;
    } else {
      spreadDays = this.planSpreadDays(s.date, st.plan).map(toISODateLocal);
      delta = s.planDir * amount;
      if (spreadDays.length === 0) error = 'No other days are left in this week to balance it.';
      else if (amount < 1) error = 'Enter how many calories to move.';
      else if (amount > 3000) error = 'That is more than a day should move. Try 3,000 or less.';
      else if (s.planDir < 0 && amount >= this.targetsFor(s.date, this.carryAdjustments(st.plan)).kcal) {
        error = 'That would take the whole day away.';
      }
    }
    const spread = s.mode === 'carry' && s.dest === 'one' && s.oneDay && spreadDays.includes(s.oneDay)
      ? [s.oneDay]
      : spreadDays;
    const carry = { id: existing ? existing.id : generateUUID(), kind: s.mode, day: st.iso, delta, spread };
    return { st, amount, existing, spreadDays, spread, carry, error };
  }

  renderCarrySheet(rerenderInput = true) {
    const s = this.carrySheet;
    if (!s) return;
    const p = this.carrySheetProposal();
    const { st } = p;
    const n = v => Math.abs(v).toLocaleString();
    const dayName = st.isToday ? 'today' : s.date.toLocaleDateString('en-GB', { weekday: 'long' });
    const DayName = dayName.charAt(0).toUpperCase() + dayName.slice(1);

    const title = document.getElementById('carry-modal-title');
    if (title) {
      title.textContent = s.mode === 'carry'
        ? `Carry ${st.isToday ? "today's" : `${DayName}'s`} balance`
        : `Plan ${dayName}`;
    }

    // Today is the one day that can be both carried and planned.
    const modeSeg = document.getElementById('carry-mode-seg');
    if (modeSeg) {
      const both = st.isToday && st.canCarry && st.canPlan;
      modeSeg.hidden = !both;
      modeSeg.innerHTML = both ? `
        <button type="button" class="carry-seg-btn${s.mode === 'carry' ? ' active' : ''}" aria-pressed="${s.mode === 'carry'}"
                onclick="app.setCarrySheet({ mode: 'carry' })">Carry balance</button>
        <button type="button" class="carry-seg-btn${s.mode === 'plan' ? ' active' : ''}" aria-pressed="${s.mode === 'plan'}"
                onclick="app.setCarrySheet({ mode: 'plan' })">Plan today</button>
      ` : '';
    }

    const summary = document.getElementById('carry-summary');
    if (summary) {
      if (s.mode === 'carry') {
        const state = st.balance > 0 ? `<strong class="under">${n(st.balance)} under</strong>`
          : st.balance < 0 ? `<strong class="over">${n(st.balance)} over</strong>` : '<strong>on target</strong>';
        summary.innerHTML = `${DayName}: ${st.eaten.toLocaleString()} of ${st.target.toLocaleString()} kcal, ${state}.`;
      } else {
        const before = this.targetsFor(s.date, this.carryAdjustments(st.plan)).kcal;
        summary.innerHTML = `${DayName}'s target is <strong>${before.toLocaleString()} kcal</strong> before this plan.`;
      }
    }

    const dirSeg = document.getElementById('carry-dir-seg');
    if (dirSeg) {
      dirSeg.hidden = s.mode !== 'plan';
      dirSeg.innerHTML = s.mode === 'plan' ? `
        <button type="button" class="carry-seg-btn${s.planDir > 0 ? ' active' : ''}" aria-pressed="${s.planDir > 0}"
                onclick="app.setCarrySheet({ planDir: 1 }, false)">High day</button>
        <button type="button" class="carry-seg-btn${s.planDir < 0 ? ' active' : ''}" aria-pressed="${s.planDir < 0}"
                onclick="app.setCarrySheet({ planDir: -1 }, false)">Low day</button>
      ` : '';
    }

    const amountLabel = document.getElementById('carry-amount-label');
    if (amountLabel) {
      amountLabel.textContent = s.mode === 'carry'
        ? 'Calories to carry'
        : (s.planDir > 0 ? 'Calories to add' : 'Calories to take off');
    }
    const input = document.getElementById('carry-amount-input');
    if (input && rerenderInput) input.value = p.amount || '';

    // Where the calories go, or where they come from.
    const dest = document.getElementById('carry-dest');
    if (dest) {
      const share = p.spreadDays.length ? Math.round(Math.abs(p.carry.delta) / p.spreadDays.length) : 0;
      const sign = p.carry.delta < 0 ? '+' : '−';
      if (s.mode === 'carry' && p.spreadDays.length) {
        const heading = st.balance > 0 ? 'Move it to' : 'Take it back from';
        const spreadOpt = `
          <button type="button" class="carry-dest-opt${s.dest === 'spread' || p.spreadDays.length === 1 ? ' active' : ''}"
                  aria-pressed="${s.dest === 'spread'}" onclick="app.setCarrySheet({ dest: 'spread' }, false)">
            <span class="carry-dest-main">${p.spreadDays.length === 1 ? '' : 'Spread over '}${this.carryRangeLabel(p.spreadDays)}</span>
            <span class="carry-dest-sub">${p.amount > 0 ? `${sign}${share.toLocaleString()}${p.spreadDays.length > 1 ? ' a day' : ''}` : ''}</span>
          </button>`;
        const oneOpt = p.spreadDays.length > 1 ? `
          <button type="button" class="carry-dest-opt${s.dest === 'one' ? ' active' : ''}"
                  aria-pressed="${s.dest === 'one'}" onclick="app.setCarrySheet({ dest: 'one' }, false)">
            <span class="carry-dest-main">One day</span>
            <span class="carry-dest-sub">${p.amount > 0 ? `${sign}${p.amount.toLocaleString()} on the day you pick` : 'the day you pick'}</span>
          </button>` : '';
        const chips = s.dest === 'one' && p.spreadDays.length > 1 ? `
          <div class="carry-day-chips">
            ${p.spreadDays.map(iso => `
              <button type="button" class="carry-day-chip${iso === s.oneDay ? ' active' : ''}" aria-pressed="${iso === s.oneDay}"
                      onclick="app.setCarrySheet({ oneDay: '${iso}' }, false)">${this.carryDayLabel(iso)}</button>
            `).join('')}
          </div>` : '';
        dest.innerHTML = `<div class="carry-dest-title">${heading}</div>${spreadOpt}${oneOpt}${chips}`;
      } else if (s.mode === 'plan' && p.spreadDays.length) {
        dest.innerHTML = `
          <div class="carry-dest-title">Balanced by</div>
          <div class="carry-dest-opt static">
            <span class="carry-dest-main">${this.carryRangeLabel(p.spreadDays)}</span>
            <span class="carry-dest-sub">${p.amount > 0 ? `${p.carry.delta > 0 ? '−' : '+'}${share.toLocaleString()}${p.spreadDays.length > 1 ? ' a day' : ''}` : ''}</span>
          </div>`;
      } else {
        dest.innerHTML = '';
      }
    }

    this.renderCarryPreview(p);

    const warn = document.getElementById('carry-warning');
    const submit = document.getElementById('carry-submit-btn');
    const remove = document.getElementById('carry-remove-btn');
    if (warn) {
      warn.textContent = p.error || this.carryFloorWarning(p);
      warn.classList.toggle('is-error', !!p.error);
      warn.hidden = !warn.textContent;
    }
    if (submit) {
      submit.disabled = !!p.error;
      submit.textContent = s.mode === 'carry'
        ? `Carry ${p.amount > 0 ? p.amount.toLocaleString() : ''}`.trim()
        : (p.existing ? 'Update plan' : 'Save plan');
    }
    if (remove) {
      remove.hidden = !p.existing;
      remove.textContent = s.mode === 'carry' ? 'Undo carry' : 'Remove plan';
      remove.onclick = () => this.removeCarrySheetEntry();
    }
  }

  // The week the carry lands in, before and after, so a cycle can be seen
  // taking shape before it is saved.
  renderCarryPreview(p) {
    const el = document.getElementById('carry-preview');
    if (!el) return;
    if (!p.spreadDays.length) {
      el.innerHTML = '';
      return;
    }
    // While the amount is invalid the week is shown as it stands.
    const after = this.carryAdjustments(null, p.error
      ? store.carries
      : store.carries.filter(c => c !== p.existing).concat([p.carry]));
    const now = this.carryAdjustments();
    const anchor = p.spread.length ? parseAnyDate(p.spread[0]) : this.carrySheet.date;
    const today = toISODateLocal(new Date());
    el.innerHTML = `
      <div class="carry-preview-title">${this.weekOf(anchor).some(d => toISODateLocal(d) === today) ? 'This week' : 'That week'} after</div>
      <div class="carry-preview-week">
        ${this.weekOf(anchor).map(d => {
          const iso = toISODateLocal(d);
          const was = this.targetsFor(d, now).kcal;
          const will = this.targetsFor(d, after).kcal;
          const diff = will - was;
          const cls = [
            'carry-preview-day',
            iso === p.st.iso ? 'is-day' : '',
            diff > 0 ? 'up' : diff < 0 ? 'down' : '',
            will < CARRY_FLOOR_KCAL && diff < 0 && !(p.carry.kind === 'carry' && iso === p.st.iso) ? 'low' : ''
          ].filter(Boolean).join(' ');
          return `
            <div class="${cls}">
              <span class="carry-preview-name">${this.carryDayLabel(iso, false)}</span>
              <span class="carry-preview-kcal">${will.toLocaleString()}</span>
              <span class="carry-preview-diff">${diff ? `${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString()}` : ''}</span>
            </div>
          `;
        }).join('')}
      </div>
      <div class="carry-preview-foot">Protein stays at ${store.targets.protein}g; carbs and fat move with the calories.</div>
    `;
  }

  // Not a block - a low day is sometimes the point - but worth saying.
  carryFloorWarning(p) {
    const after = this.carryAdjustments(null, store.carries.filter(c => c !== p.existing).concat([p.carry]));
    // The carried day itself is already eaten, so only days still to come
    // are worth a warning.
    const low = (p.carry.kind === 'plan' ? [p.carry.day, ...p.spread] : p.spread)
      .filter(iso => (after.get(iso) || { kcal: 0 }).kcal < 0)
      .map(iso => ({ iso, kcal: this.targetsFor(parseAnyDate(iso), after).kcal }))
      .filter(x => x.kcal < CARRY_FLOOR_KCAL);
    if (!low.length) return '';
    const worst = low.reduce((a, b) => (b.kcal < a.kcal ? b : a));
    const floor = CARRY_FLOOR_KCAL.toLocaleString();
    const lead = low.length === 1
      ? `${this.carryDayLabel(worst.iso)} would drop to ${worst.kcal.toLocaleString()} kcal, under ${floor}.`
      : `${low.length} days would drop under ${floor} kcal (lowest ${worst.kcal.toLocaleString()}).`;
    const hint = p.carry.kind === 'carry' && p.spread.length === 1 && p.spreadDays.length > 1
      ? 'Spreading it over more days keeps it higher.'
      : 'A smaller amount keeps it higher.';
    return `${lead} ${hint}`;
  }

  async submitCarrySheet() {
    const p = this.carrySheetProposal();
    if (p.error) {
      this.renderCarrySheet(false);
      return;
    }
    const s = this.carrySheet;
    const res = await store.saveCarry(p.carry);
    this.closeModal('carry-modal');
    this.carrySheet = null;
    this.renderAll();
    const range = this.carryRangeLabel(p.spread);
    const amount = p.amount.toLocaleString();
    const dayName = p.st.isToday ? 'Today' : s.date.toLocaleDateString('en-GB', { weekday: 'long' });
    let msg;
    if (s.mode === 'carry') {
      msg = p.carry.delta < 0 ? `Carried ${amount} kcal to ${range}` : `Took ${amount} kcal back from ${range}`;
    } else {
      msg = p.carry.delta > 0
        ? `${dayName} is a high day: +${amount} kcal, balanced by ${range}`
        : `${dayName} is a low day: −${amount} kcal, handed to ${range}`;
    }
    if (res && res.success === false) {
      this.showToast(`Saved on this device, not the cloud yet: ${res.error}`, 'error');
    } else {
      this.showToast(msg, 'success');
    }
  }

  async removeCarrySheetEntry() {
    const s = this.carrySheet;
    if (!s) return;
    const iso = toISODateLocal(s.date);
    const res = await store.removeCarry(iso, s.mode);
    this.closeModal('carry-modal');
    this.carrySheet = null;
    this.renderAll();
    if (res && res.success === false) {
      this.showToast(`Removed on this device, not the cloud yet: ${res.error}`, 'error');
    } else {
      this.showToast(s.mode === 'carry' ? 'Carry undone' : 'Plan removed', 'success');
    }
  }

  // WEEK STRIP
  // Seven days across the top of the Tracker. Picking one points the summary
  // card and the logs below at that day; the chevron folds out a bar chart of
  // the same week, lined up under the same seven columns.

  startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  getSelectedDate() {
    return this.startOfDay(this.selectedDate || new Date());
  }

  isViewingToday() {
    return this.getSelectedDate().toDateString() === new Date().toDateString();
  }

  // Sunday to Saturday of the week on the strip: the selected day's own
  // week, unless the strip has been paged to another.
  getWeekDays() {
    const sunday = this.startOfDay(this.stripWeek || this.getSelectedDate());
    sunday.setDate(sunday.getDate() - sunday.getDay());
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday);
      d.setDate(sunday.getDate() + i);
      weekDays.push(d);
    }
    return weekDays;
  }

  // The day a past log belongs to, as a toDateString() key, or null when its
  // "Log Session" is not a date. parseAnyDate falls back to "now" for text it
  // cannot read, which would quietly file an undated log under today.
  logDayKey(log) {
    const s = String(log['Log Session'] || '').trim();
    if (!s) return null;
    if (!/^\d/.test(s) && isNaN(new Date(s.split('-')[0].trim()).getTime())) return null;
    const d = parseAnyDate(s);
    return isNaN(d.getTime()) ? null : d.toDateString();
  }

  // Every past log grouped by day, built once per repaint rather than
  // re-parsing every date for each of the seven columns.
  pastLogsByDay() {
    const byDay = new Map();
    store.pastLogs.forEach(log => {
      const key = this.logDayKey(log);
      if (!key) return;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(log);
    });
    return byDay;
  }

  // What was eaten on a day: its archived logs, plus the meals still in
  // Today's Log when the day is today.
  getDayTotals(date, byDay = this.pastLogsByDay()) {
    const key = date.toDateString();
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    const add = (kcal, protein, carbs, fat) => {
      t.kcal += Number(kcal) || 0;
      t.protein += Number(protein) || 0;
      t.carbs += Number(carbs) || 0;
      t.fat += Number(fat) || 0;
    };
    // Meals still in Today's Log count on the day they were logged, so one
    // left there overnight shows on its own day and never inflates the next.
    const todayKey = new Date().toDateString();
    store.todayMeals.forEach(m => {
      if (!m.totals || (mealLoggedDay(m) || todayKey) !== key) return;
      add(m.totals.kcal, m.totals.protein, m.totals.carbs, m.totals.fat);
    });
    (byDay.get(key) || []).forEach(l => add(l['Total Kcal'], l['Total Protein'], l['Total Carbs'], l['Total Fat']));
    return {
      kcal: Math.round(t.kcal),
      protein: Math.round(t.protein * 10) / 10,
      carbs: Math.round(t.carbs * 10) / 10,
      fat: Math.round(t.fat * 10) / 10
    };
  }

  // CALORIE CARRIES
  // A carry moves calories between days without changing the week's total.
  // A finished day that came in under or over hands its balance to the days
  // left in the week, and a planned high or low day is balanced by the other
  // days of its week - which is all a weekly calorie cycle is.

  addDays(date, n) {
    const d = this.startOfDay(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  // Sunday to Saturday around a date.
  weekOf(date) {
    const sunday = this.addDays(date, -this.startOfDay(date).getDay());
    return Array.from({ length: 7 }, (_, i) => this.addDays(sunday, i));
  }

  // Whole calories adding up to exactly `total` over n days, the odd ones
  // going to the earliest.
  splitKcal(total, n) {
    const base = Math.trunc(total / n);
    let rest = total - base * n;
    return Array.from({ length: n }, () => {
      if (rest === 0) return base;
      const step = Math.sign(rest);
      rest -= step;
      return base + step;
    });
  }

  // Day (YYYY-MM-DD) -> { kcal, flex }: calories added to or taken off its
  // target, and how much of that moves its carbs and fat. A carried day's
  // own change does not flex them - it is already eaten, and its target only
  // moves to match what it came to. `skip` leaves one carry out, to see a
  // day as it stood before that carry.
  carryAdjustments(skip = null, carries = store.carries) {
    const adj = new Map();
    const add = (iso, kcal, flexes) => {
      const a = adj.get(iso) || { kcal: 0, flex: 0 };
      a.kcal += kcal;
      if (flexes) a.flex += kcal;
      adj.set(iso, a);
    };
    carries.forEach(c => {
      if (c === skip) return;
      add(c.day, c.delta, c.kind === 'plan');
      const shares = this.splitKcal(-c.delta, c.spread.length);
      c.spread.forEach((iso, i) => add(iso, shares[i], true));
    });
    return adj;
  }

  // A day's targets once carries are counted. Protein holds; carbs and fat
  // take the change between them in proportion to the calories each brings
  // to the base targets, which is how calorie cycling is usually run.
  targetsFor(date, adj = this.carryAdjustments()) {
    const base = store.targets;
    const a = adj.get(toISODateLocal(date));
    const delta = a ? a.kcal : 0;
    const flex = a ? a.flex : 0;
    if (!delta && !flex) return { ...base, delta: 0 };
    const carbKcal = base.carbs * 4;
    const fatKcal = base.fat * 9;
    const carbShare = carbKcal + fatKcal > 0 ? carbKcal / (carbKcal + fatKcal) : 0.5;
    return {
      ...base,
      kcal: Math.max(0, base.kcal + delta),
      carbs: flex ? Math.max(0, Math.round(base.carbs + (flex * carbShare) / 4)) : base.carbs,
      fat: flex ? Math.max(0, Math.round(base.fat + (flex * (1 - carbShare)) / 9)) : base.fat,
      delta
    };
  }

  // Where a finished day's balance can go: from today (or the day after it,
  // if that is later) to the end of this week. With nothing left this week -
  // carrying Saturday on a Saturday - it goes to next week instead.
  carrySpreadDays(date) {
    const today = this.startOfDay(new Date());
    const dayAfter = this.addDays(date, 1);
    const start = dayAfter > today ? dayAfter : today;
    const week = this.weekOf(today);
    const left = week.filter(d => d >= start);
    return left.length ? left : this.weekOf(this.addDays(week[6], 1));
  }

  // What balances a planned day: the rest of its week from today on,
  // leaving out days that are planned themselves, so two high days in one
  // week do not cancel each other out.
  planSpreadDays(date, skip = null) {
    const today = this.startOfDay(new Date());
    const iso = toISODateLocal(date);
    const planned = new Set(store.carries
      .filter(c => c.kind === 'plan' && c !== skip)
      .map(c => c.day));
    return this.weekOf(date).filter(d => {
      const k = toISODateLocal(d);
      return d >= today && k !== iso && !planned.has(k);
    });
  }

  // What the Calories tile can offer for a day: carrying its balance once
  // it is over, planning it while it is still to come. Today can do both.
  carryStateFor(date, totals = this.getDayTotals(date)) {
    const iso = toISODateLocal(date);
    const today = this.startOfDay(new Date());
    const carry = store.carries.find(c => c.day === iso && c.kind === 'carry') || null;
    const plan = store.carries.find(c => c.day === iso && c.kind === 'plan') || null;
    // The balance is measured against the target as it was before this
    // day's own carry, so carrying again replaces rather than stacks.
    const target = this.targetsFor(date, this.carryAdjustments(carry)).kcal;
    const balance = target - totals.kcal;
    const isToday = iso === toISODateLocal(today);
    const isPast = date < today;
    const recent = date >= this.addDays(today, -7);
    const carryable = (isToday || (isPast && recent)) && totals.kcal > 0 && balance !== 0;
    return {
      iso, carry, plan, target, balance, eaten: totals.kcal, isToday, isPast,
      canCarry: carryable || !!carry,
      canPlan: !isPast
    };
  }

  carryDayLabel(iso, withDate = true) {
    const d = parseAnyDate(iso);
    const name = d.toLocaleDateString('en-GB', { weekday: 'short' });
    return withDate ? `${name} ${d.getDate()}` : name;
  }

  // "Wed–Sat", "Wed, Fri", "5 days" - and "next week" once the days are
  // all in the week after this one.
  carryRangeLabel(isos) {
    const sorted = isos.slice().sort();
    const names = sorted.map(iso => this.carryDayLabel(iso, false));
    const contiguous = sorted.every((iso, i) =>
      i === 0 || toISODateLocal(this.addDays(parseAnyDate(sorted[i - 1]), 1)) === iso);
    let label;
    if (sorted.length === 1) label = names[0];
    else if (contiguous) label = `${names[0]}–${names[names.length - 1]}`;
    else if (sorted.length <= 3) label = names.join(', ');
    else label = `${sorted.length} days`;
    const nextWeek = this.weekOf(this.addDays(this.weekOf(new Date())[6], 1)).map(toISODateLocal);
    return sorted.every(iso => nextWeek.includes(iso)) ? `${label} next week` : label;
  }

  // Why a day's target is not the usual one, for the brackets beside it:
  // what the day did itself first, then what other days moved onto it -
  // "454 of this carried from Mon 28".
  carryNoteFor(iso) {
    const own = [];
    const gained = [];
    const lost = [];
    const n = v => Math.abs(v).toLocaleString();
    store.carries.forEach(c => {
      if (c.day === iso) {
        if (c.kind === 'plan') {
          own.push(c.delta > 0 ? `High day +${n(c.delta)}` : `Low day −${n(c.delta)}`);
        } else {
          own.push(c.delta < 0
            ? `${n(c.delta)} under, carried to ${this.carryRangeLabel(c.spread)}`
            : `${n(c.delta)} over, taken from ${this.carryRangeLabel(c.spread)}`);
        }
      }
      const i = c.spread.indexOf(iso);
      if (i >= 0) {
        const share = this.splitKcal(-c.delta, c.spread.length)[i];
        if (share > 0) gained.push({ share, day: c.day });
        else if (share < 0) lost.push({ share, day: c.day });
      }
    });
    // Shares from more than one day read as one total: "600 of this
    // carried from Sun 27 and Mon 28".
    const sum = list => n(list.reduce((s, x) => s + x.share, 0));
    const days = list => {
      // A no-break space keeps "Mon 28" together when the note wraps.
      const names = [...new Set(list.map(x => x.day))].sort().map(d => this.carryDayLabel(d).replace(' ', '\u00a0'));
      return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    };
    if (gained.length) own.push(`${sum(gained)} of this carried from ${days(gained)}`);
    if (lost.length) own.push(`${sum(lost)} less, making up for ${days(lost)}`);
    // A no-break space before the dot, so a wrap leaves it ending the line
    // rather than starting the next.
    return own.join('\u00a0· ');
  }

  selectDay(date) {
    const d = this.startOfDay(date);
    if (isNaN(d.getTime())) return;
    // Picking today goes back to following the clock.
    this.selectedDate = d.toDateString() === new Date().toDateString() ? null : d;
    this.stripWeek = null;
    this.renderDayView();
  }

  // "Yesterday", "3 days ago", "In 2 weeks" - how far the day on show is
  // from today, for the banner that marks a day that is not today.
  relativeDayLabel(date) {
    const days = Math.round((this.startOfDay(new Date()) - this.startOfDay(date)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days === -1) return 'Tomorrow';
    const n = Math.abs(days);
    let span;
    if (n < 14) span = `${n} days`;
    else if (n < 60) span = `${Math.round(n / 7)} weeks`;
    else if (n < 730) span = `${Math.round(n / 30.44)} months`;
    else span = `${Math.round(n / 365.25)} years`;
    return days > 0 ? `${span} ago` : `In ${span}`;
  }

  goToToday() {
    this.selectDay(new Date());
  }

  // Everything on the Tracker that depends on which day is picked.
  renderDayView() {
    this.renderWeekStrip();
    this.renderDailySubtotal();
    this.renderDayLogs();
  }

  // A week back or forward only pages the strip. The summary and logs stay
  // on the selected day until a day on the strip is actually tapped.
  shiftWeeklyOffset(delta) {
    const sunday = this.getWeekDays()[0];
    sunday.setDate(sunday.getDate() + delta * 7);
    // Paged back round to the selected day's own week, the strip simply
    // follows the selected day again.
    const home = this.getSelectedDate();
    home.setDate(home.getDate() - home.getDay());
    this.stripWeek = sunday.toDateString() === home.toDateString() ? null : sunday;
    this.renderWeekStrip();
  }

  openDayPicker() {
    const input = document.getElementById('week-strip-date-input');
    if (!input) return;
    input.value = toISODateLocal(this.getSelectedDate());
    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch (e) { /* not allowed here - fall through to focusing it */ }
    input.focus();
    input.click();
  }

  jumpToDate(value) {
    if (!value) return;
    this.selectDay(parseAnyDate(value));
  }

  toggleWeekBars() {
    this.weekBarsOpen = !this.weekBarsOpen;
    this.applyWeekBarsState();
  }

  applyWeekBarsState() {
    const card = document.getElementById('week-strip-card');
    const toggle = document.getElementById('week-strip-toggle');
    if (card) card.classList.toggle('bars-open', this.weekBarsOpen);
    if (toggle) {
      const label = this.weekBarsOpen ? 'Hide the week chart' : 'Show the week chart';
      toggle.setAttribute('aria-expanded', this.weekBarsOpen ? 'true' : 'false');
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    }
  }

  // Swiping the strip sideways changes week - a finger on a phone, a mouse
  // drag or a two-finger trackpad swipe on a computer. The week follows the
  // drag with the week beside it already alongside, coming in from the
  // card's edge; let go past a short way or flick, and both slide on
  // together, otherwise both slide back. Vertical drags are left to the
  // page, so scrolling that happens to start on the strip still scrolls.
  setupWeekStripSwipe() {
    const body = document.getElementById('week-strip-body');
    if (!body || body._swipeReady) return;
    body._swipeReady = true;

    // Between the week on show and the one coming in: the card's own
    // padding, so the next week sits just out of sight until dragged.
    const GAP = 8;

    let active = false;
    let decided = false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let samples = [];
    // The copy of the strip showing the week beside this one, and which
    // side it is on (1 the next week, to the right; -1 the previous one).
    let ghost = null;
    let side = 0;
    // The tidy-up still due after a slide, run early if a new drag starts
    // before it is over so a quick second swipe is never dropped.
    let pending = null;

    const span = () => body.offsetWidth + GAP;
    // Quicker the less there is left to travel, so letting go near the end
    // does not hang about.
    const slideMs = (left) => Math.round(Math.min(300, Math.max(150, (left / span()) * 340)));
    const ease = (ms) => `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;

    const after = (ms, done) => {
      const timer = setTimeout(() => {
        pending = null;
        done();
      }, ms + 20);
      pending = { timer, done };
    };
    const flush = () => {
      if (!pending) return;
      const { timer, done } = pending;
      pending = null;
      clearTimeout(timer);
      done();
    };

    const dropGhost = () => {
      if (ghost) ghost.remove();
      ghost = null;
      side = 0;
    };

    const reset = () => {
      body.style.transition = '';
      body.style.transform = '';
      body.style.willChange = '';
      dropGhost();
      dx = 0;
    };

    // A copy of the strip with the week beside this one drawn into it, laid
    // over the strip and pushed just past the card's edge.
    const showGhost = (dir) => {
      dropGhost();
      const copy = body.cloneNode(true);
      copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      copy.classList.remove('dragging');
      copy.classList.add('week-strip-ghost');
      copy.setAttribute('aria-hidden', 'true');
      copy.querySelectorAll('button').forEach(b => { b.tabIndex = -1; });
      this.fillWeekStrip(copy, this.weekOf(this.addDays(this.getWeekDays()[0], dir * 7)));
      copy.style.cssText = `position:absolute; top:${body.offsetTop}px; left:${body.offsetLeft}px; width:${body.offsetWidth}px;`
        + ` will-change:transform; transition:none; transform:translateX(${dir * span()}px);`;
      body.after(copy);
      ghost = copy;
      side = dir;
    };

    const place = () => {
      const dir = dx < 0 ? 1 : -1;
      if (dir !== side) showGhost(dir);
      body.style.transform = `translateX(${dx}px)`;
      ghost.style.transform = `translateX(${dir * span() + dx}px)`;
    };

    // dir 1 is the next week, -1 the previous one. Finishes a drag from
    // wherever it was let go, or runs a whole slide from rest (a trackpad
    // swipe). The strip takes the new week the moment it is in place, so the
    // copy and the strip swap without a flicker.
    const slideWeek = (dir) => {
      flush();
      if (dir !== side) {
        body.style.transition = 'none';
        showGhost(dir);
        // Commit the starting point before sliding. requestAnimationFrame
        // would do the same but never fires in a tab that is not painting.
        void body.offsetWidth;
      }
      const w = span();
      const ms = slideMs(w - Math.abs(dx));
      body.style.willChange = 'transform';
      body.style.transition = ease(ms);
      ghost.style.transition = ease(ms);
      body.style.transform = `translateX(${-dir * w}px)`;
      ghost.style.transform = 'translateX(0)';
      after(ms, () => {
        reset();
        this.shiftWeeklyOffset(dir);
      });
    };

    const settle = () => {
      const ms = slideMs(Math.abs(dx));
      body.style.transition = ease(ms);
      body.style.transform = 'translateX(0)';
      if (ghost) {
        ghost.style.transition = ease(ms);
        ghost.style.transform = `translateX(${side * span()}px)`;
      }
      after(ms, reset);
    };

    // Pointer events cover mouse, touch and pen with one set of handlers.
    // Heard on the card, not the strip: while the weeks are still sliding,
    // the strip has moved out from under the pointer and the copy coming in
    // (a .week-strip-body too) is what is there to press.
    const card = body.parentElement;
    const onStrip = (e) => {
      if (e.target.closest && e.target.closest('.week-strip-body')) return true;
      // Mid-slide the pointer can also land in the gap between the two.
      if (!pending) return false;
      const r = body.getBoundingClientRect();
      return e.clientY >= r.top && e.clientY <= r.bottom;
    };
    card.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!onStrip(e)) return;
      // A swipe while the last one is still sliding lands it at once.
      flush();
      active = true;
      decided = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      samples = [{ x: e.clientX, t: e.timeStamp }];
      this.stripSwiped = false;
    });

    card.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== pointerId) return;
      const mx = e.clientX - startX;
      const my = e.clientY - startY;
      if (!decided) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        if (Math.abs(my) > Math.abs(mx)) {
          active = false;
          return;
        }
        // Captured only once the drag is known to be sideways, so a plain tap
        // still clicks the day under it. Capture keeps the drag alive when a
        // mouse strays off the strip mid-swipe.
        try { body.setPointerCapture(pointerId); } catch (err) { /* pointer already gone */ }
        body.classList.add('dragging');
        body.style.transition = 'none';
        body.style.willChange = 'transform';
      }
      this.stripSwiped = true;
      dx = mx;
      samples.push({ x: e.clientX, t: e.timeStamp });
      while (samples.length > 2 && e.timeStamp - samples[0].t > 100) samples.shift();
      place();
    });

    const finish = (e) => {
      if (!active || e.pointerId !== pointerId) return;
      active = false;
      pointerId = null;
      body.classList.remove('dragging');
      if (!decided || !ghost) {
        if (ghost || dx) settle();
        return;
      }
      const dir = dx < 0 ? 1 : -1;
      // Speed over the last tenth of a second, so a quick flick counts even
      // when the drag itself was short.
      const first = samples[0];
      const dt = e.timeStamp - first.t;
      const speed = dt > 0 ? (e.clientX - first.x) / dt : 0;
      const flicked = Math.abs(speed) > 0.35 && Math.sign(speed) === -dir && Math.abs(dx) > 12;
      if (e.type === 'pointerup' && side === dir && (Math.abs(dx) > 45 || flicked)) {
        slideWeek(dir);
      } else {
        settle();
      }
    };
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
    // The mouse let go somewhere the page never heard about. Only the
    // strip's own capture counts: a finger starts out captured by the day it
    // touched, and that hands over to the strip (bubbling up here).
    card.addEventListener('lostpointercapture', (e) => {
      if (e.target !== body || !active || e.pointerId !== pointerId) return;
      finish({ type: 'pointercancel', pointerId: e.pointerId, clientX: startX + dx, timeStamp: e.timeStamp });
    });

    // A trackpad's sideways swipe arrives as horizontal wheel events, with
    // momentum trailing on for a second after the fingers lift. The strip
    // follows the fingers, moves on once they have gone far enough, and
    // springs back if they stop short. One gesture moves one week: after a
    // move, the strip ignores the wheel until it has been quiet for a moment.
    let wheelLocked = false;
    let wheelQuietTimer = null;
    card.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !onStrip(e)) return;
      e.preventDefault();
      if (active) return;
      clearTimeout(wheelQuietTimer);
      wheelQuietTimer = setTimeout(() => {
        if (!wheelLocked && !pending && (dx || ghost)) settle();
        wheelLocked = false;
      }, 160);
      if (wheelLocked) return;
      if (pending) flush();
      // Firefox can count in lines rather than pixels.
      const step = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (!dx) {
        body.style.transition = 'none';
        body.style.willChange = 'transform';
      }
      dx -= step;
      if (Math.abs(dx) > 60) {
        wheelLocked = true;
        slideWeek(dx < 0 ? 1 : -1);
      } else {
        place();
      }
    }, { passive: false });

    // One listener for every day and every bar - both are redrawn wholesale
    // on each repaint.
    body.addEventListener('click', (e) => {
      if (this.stripSwiped) {
        this.stripSwiped = false;
        return;
      }
      const btn = e.target.closest('[data-day]');
      if (btn) this.selectDay(parseAnyDate(btn.getAttribute('data-day')));
    });
  }

  // Plain elements rather than a Chart.js canvas: the strip is on screen
  // whenever the Tracker is, and renderAll() runs on every cloud sync.
  // Rebuilding a chart instance that often is what used to make the phone
  // stutter; seven buttons and seven bars cost next to nothing.
  renderWeekStrip() {
    const body = document.getElementById('week-strip-body');
    if (!body) return;
    this.setupWeekStripSwipe();
    this.applyWeekBarsState();

    const weekDays = this.getWeekDays();
    const today = this.startOfDay(new Date());
    const todayKey = today.toDateString();
    const selectedKey = this.getSelectedDate().toDateString();

    // One month name, or both ends when the week crosses into the next.
    // The year only appears once it is not this one.
    const first = weekDays[0];
    const last = weekDays[6];
    const monthText = document.getElementById('week-strip-month-text');
    if (monthText) {
      const monthName = d => d.toLocaleDateString('en-GB', { month: 'long' });
      // Sliced rather than month:'short', which gives en-GB's four-letter "Sept".
      let label = first.getMonth() === last.getMonth()
        ? monthName(first)
        : `${monthName(first).slice(0, 3)} – ${monthName(last).slice(0, 3)}`;
      if (last.getFullYear() !== today.getFullYear()) label += ` ${last.getFullYear()}`;
      monthText.textContent = label;
    }

    // Also offered on today itself once the strip has been paged away from
    // this week, as the one tap that brings it back.
    const todayBtn = document.getElementById('week-strip-today-btn');
    if (todayBtn) {
      todayBtn.classList.toggle('visible', selectedKey !== todayKey || !weekDays.some(d => d.toDateString() === todayKey));
    }

    this.fillWeekStrip(body, weekDays);
  }

  // The days, carry lines, chart and totals of one week, drawn into `root`:
  // the strip itself, or the copy of it that brings the week beside it in
  // while the strip is dragged. Looked up by class, since the copy has no ids.
  fillWeekStrip(root, weekDays) {
    const daysEl = root.querySelector('.week-strip-days');
    const plotEl = root.querySelector('.week-strip-plot');
    if (!daysEl || !plotEl) return;

    const byDay = this.pastLogsByDay();
    const today = this.startOfDay(new Date());
    const todayKey = today.toDateString();
    const selectedKey = this.getSelectedDate().toDateString();
    const baseTarget = store.targets.kcal || 2000;
    const adj = this.carryAdjustments();

    const days = weekDays.map(d => {
      const t = this.getDayTotals(d, byDay);
      const p = Math.round(t.protein * 4);
      const c = Math.round(t.carbs * 4);
      const f = Math.round(t.fat * 9);
      // Each day's own target, once carries and planned days are counted.
      const target = this.targetsFor(d, adj).kcal || baseTarget;
      return { d, key: d.toDateString(), t, p, c, f, col: p + c + f, target };
    });

    const dayClass = (x, base) => {
      let cls = base;
      if (x.key === todayKey) cls += ' today';
      if (x.key === selectedKey) cls += ' selected';
      if (x.d > today) cls += ' future';
      return cls;
    };

    daysEl.innerHTML = days.map(x => {
      const longDate = x.d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      const label = x.t.kcal > 0 ? `${longDate}, ${x.t.kcal.toLocaleString()} kcal` : longDate;
      return `
        <button type="button" class="${dayClass(x, 'week-day')}" data-day="${toISODateLocal(x.d)}"
                aria-pressed="${x.key === selectedKey}" aria-label="${this.escapeHTML(label)}">
          <span class="week-day-name">${x.d.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
          <span class="week-day-num">${x.d.getDate()}</span>
        </button>
      `;
    }).join('');
    this.renderWeekCarries(root.querySelector('.week-strip-carries'), weekDays);

    // Bar heights come from the macros (so the three colours add up to the
    // bar), while the figure above each bar is the day's real logged kcal.
    // One dashed line across the chart while every day shares a target; a
    // short one over each column once carries have given days their own.
    const uniform = days.every(x => x.target === days[0].target);
    const scale = Math.max(...days.map(x => x.target), ...days.map(x => x.col), 1) * 1.08;
    const pct = v => `${Math.min(100, (v / scale) * 100).toFixed(1)}%`;
    const colTarget = x => {
      if (uniform) return '';
      const cls = x.target > baseTarget ? ' up' : x.target < baseTarget ? ' down' : '';
      return `<span class="week-chart-col-target${cls}" style="bottom:${pct(x.target)};"></span>`;
    };
    plotEl.innerHTML = (uniform ? `<div class="week-chart-target" style="bottom:${pct(days[0].target)};"></div>` : '') + days.map(x => `
      <button type="button" class="${dayClass(x, 'week-chart-col')}" data-day="${toISODateLocal(x.d)}" tabindex="-1" aria-hidden="true">
        ${colTarget(x)}
        <span class="week-chart-bar" style="height:${x.col > 0 ? pct(x.col) : '0'};">
          ${x.t.kcal > 0 ? `<span class="week-chart-kcal">${x.t.kcal.toLocaleString()}</span>` : ''}
          <span class="week-chart-stack">
            <span class="week-chart-seg fat" style="flex:${x.f};"></span>
            <span class="week-chart-seg carbs" style="flex:${x.c};"></span>
            <span class="week-chart-seg protein" style="flex:${x.p};"></span>
          </span>
        </span>
      </button>
    `).join('');

    let weekTotalKcal = 0;
    let loggedDaysCount = 0;
    days.forEach(x => {
      if (x.t.kcal > 0) {
        weekTotalKcal += x.t.kcal;
        loggedDaysCount++;
      }
    });
    // Carries inside a week leave this where it was; one carried over from
    // last week moves it.
    const remainingKcal = days.reduce((sum, x) => sum + x.target, 0) - weekTotalKcal;
    const dailyAvg = loggedDaysCount > 0 ? Math.round(weekTotalKcal / loggedDaysCount) : 0;

    const weekTotalEl = root.querySelector('[data-stat="week"]');
    const dailyAvgEl = root.querySelector('[data-stat="avg"]');
    const remainingEl = root.querySelector('[data-stat="remaining"]');
    if (weekTotalEl) weekTotalEl.textContent = `${weekTotalKcal.toLocaleString()} kcal`;
    if (dailyAvgEl) dailyAvgEl.textContent = `${dailyAvg.toLocaleString()} kcal`;
    if (remainingEl) {
      remainingEl.textContent = remainingKcal < 0
        ? `${Math.abs(remainingKcal).toLocaleString()} kcal over`
        : `${remainingKcal.toLocaleString()} kcal left`;
      remainingEl.classList.toggle('negative', remainingKcal < 0);
      remainingEl.classList.toggle('highlight', remainingKcal >= 0);
    }
  }

  // Under the dates, a line for each carry or planned day touching the week
  // on show. A carry runs from the day that carried to the last day that took
  // a share, a dot on each day on the way that took one and the arrow on the
  // last: green when the day came in under (the days after get more), red
  // when it went over (they get less). A planned day is amber, a triangle on
  // it - up for a high day, down for a low one - and a dot on each day that
  // balances it. One reaching into another week runs off that edge, and lines
  // that would overlap stack one under another.
  renderWeekCarries(el, weekDays) {
    if (!el) return;
    const isos = weekDays.map(toISODateLocal);
    const first = isos[0];
    const last = isos[6];
    const inWeek = iso => iso >= first && iso <= last;
    // A column's centre, or the strip's edge for a day off either side.
    const x = iso => iso < first ? 0 : iso > last ? 100 : ((isos.indexOf(iso) + 0.5) / 7) * 100;
    const dot = (cls, iso) => `<span class="${cls}" style="left:${x(iso)}%;"></span>`;

    // A plan with nothing left to balance it still gets its triangle.
    const lines = store.carries
      .filter(c => c.kind === 'plan' || c.spread.length)
      .map(c => {
        const ends = [c.day, ...c.spread].sort();
        const lo = ends[0];
        const hi = ends[ends.length - 1];
        if (hi < first || lo > last) return null;
        return { c, lo, hi, start: x(lo), end: x(hi) };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const laneEnds = [];
    lines.forEach(l => {
      let lane = laneEnds.findIndex(end => end < l.start);
      if (lane < 0) lane = laneEnds.push(0) - 1;
      laneEnds[lane] = l.end;
      l.lane = lane;
    });

    const LANE_PX = 10;
    el.style.height = `${laneEnds.length * LANE_PX}px`;
    el.innerHTML = lines.map(({ c, lo, hi, start, end, lane }) => {
      const n = Math.abs(c.delta).toLocaleString();
      const cls = ['week-carry'];
      let label;
      let marks;
      if (c.kind === 'plan') {
        const high = c.delta > 0;
        cls.push('plan');
        label = `${this.carryDayLabel(c.day)}: ${high ? 'high' : 'low'} day ${high ? '+' : '−'}${n} kcal`
          + (c.spread.length ? `, balanced by ${this.carryRangeLabel(c.spread)}` : '');
        marks = c.spread.filter(inWeek).map(iso => dot('week-carry-mark', iso)).join('')
          + (inWeek(c.day) ? dot(`week-carry-plan ${high ? 'high' : 'low'}`, c.day) : '');
      } else {
        const under = c.delta < 0;
        // Carries go forward in time, but the arrow points away from the
        // day that carried whichever way it runs.
        const back = c.day === hi && c.day !== lo;
        const head = back ? lo : hi;
        cls.push(under ? 'under' : 'over');
        if (back) cls.push('back');
        if (!inWeek(c.day)) cls.push('from-away');
        label = `${this.carryDayLabel(c.day)}: ${n} kcal ${under ? 'under' : 'over'}, carried to ${this.carryRangeLabel(c.spread)}`;
        marks = (inWeek(c.day) ? dot('week-carry-from', c.day) : '')
          + c.spread.filter(iso => inWeek(iso) && iso !== head).map(iso => dot('week-carry-mark', iso)).join('')
          + dot('week-carry-head', head);
      }
      return `
        <div class="${cls.join(' ')}" style="top:${lane * LANE_PX}px;" role="img" aria-label="${this.escapeHTML(label)}" title="${this.escapeHTML(label)}">
          ${end > start ? `<span class="week-carry-line" style="left:${start}%;width:${end - start}%;"></span>` : ''}
          ${marks}
        </div>
      `;
    }).join('');
  }

  // Below the summary card: for today, anything already archived under
  // today's date (Meal Builder and Today's Log stay above it); for any other
  // day, that day's logs are all there is to show.
  renderDayLogs() {
    const panel = document.getElementById('panel-dashboard');
    const section = document.getElementById('day-logs-section');
    if (!section) return;
    const isToday = this.isViewingToday();
    if (panel) panel.classList.toggle('past-day', !isToday);

    // The search list renders the same logs with the same element ids, so
    // only one of the two is ever in the page.
    if (this.historySearchOpen) {
      section.innerHTML = '';
      return;
    }

    const date = this.getSelectedDate();
    const logs = (this.pastLogsByDay().get(date.toDateString()) || [])
      .slice()
      .sort((a, b) => parseAnyDate(a['Log Session']).getTime() - parseAnyDate(b['Log Session']).getTime());

    if (logs.length === 0) {
      if (isToday) {
        section.innerHTML = '';
        return;
      }
      const future = date > this.startOfDay(new Date());
      section.innerHTML = `
        <div class="empty-log-box">
          <div class="empty-title">${future ? 'This day is still ahead' : 'Nothing logged this day'}</div>
          <div class="empty-desc">${future
            ? 'You can plan it as a high or low day above. Meals show up here once that day comes.'
            : 'Pick another day on the strip above, or search your history for a food.'}</div>
        </div>
      `;
      return;
    }

    section.innerHTML = logs.map(log => {
      // The time a day was filed says nothing about the day itself, so it is
      // not shown.
      const title = isToday ? 'Already filed today' : 'Meals';
      return `
        <div class="todays-log-card day-log-card">
          <div class="todays-log-header">
            <div class="todays-log-title">
              <span>${title}</span>
            </div>
            <span class="history-total-kcal">${(Number(log['Total Kcal']) || 0).toLocaleString()} kcal</span>
          </div>
          ${this.historyCardBodyHTML(log)}
        </div>
      `;
    }).join('');
  }

  // HISTORY SEARCH
  // The magnifier on the week strip swaps the day view for every logged day,
  // newest first, filtered as you type.
  openHistorySearch() {
    this.historySearchOpen = true;
    this.applyHistorySearchMode();
    // In the same tick as the tap: a phone only raises its keyboard for a
    // focus() made inside the user's own gesture.
    const input = document.getElementById('history-search-input');
    if (input) input.focus();
    this.historyVisibleCount = 10;
    this.renderHistoryList();
    this.renderDayLogs();
  }

  closeHistorySearch() {
    if (!this.historySearchOpen) return;
    this.historySearchOpen = false;
    this.historySearchQuery = '';
    this.historyVisibleCount = 10;
    const input = document.getElementById('history-search-input');
    if (input) {
      input.value = '';
      input.blur();
    }
    const container = document.getElementById('past-history-logs-container');
    if (container) container.innerHTML = '';
    this.applyHistorySearchMode();
    this.renderDayLogs();
  }

  applyHistorySearchMode() {
    const panel = document.getElementById('panel-dashboard');
    const card = document.getElementById('week-strip-card');
    if (panel) panel.classList.toggle('searching', this.historySearchOpen);
    if (card) card.classList.toggle('searching', this.historySearchOpen);
  }

  // From a search result to that day on the strip.
  openDayFromHistory(logId) {
    const log = store.pastLogs.find(l => l.id === logId);
    const key = log ? this.logDayKey(log) : null;
    if (!key) {
      this.showToast('That log has no date to open', 'error');
      return;
    }
    this.closeHistorySearch();
    this.selectDay(parseAnyDate(log['Log Session']));
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }

  // Anything that drops food into the Meal Builder lands you on today, the
  // only day the builder is shown for.
  showTodayView() {
    this.closeHistorySearch();
    // Mid-edit the builder is already on screen, on the edited meal's day.
    if (this.mealEdit) return;
    if (!this.isViewingToday() || this.stripWeek) {
      this.selectedDate = null;
      this.stripWeek = null;
      this.renderDayView();
    }
  }

  addNewBuilderRow(food = null) {
    const rowId = 'row-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    if (food) {
      const unit = unitOfEntry(food);
      const baseQty = food.Quantity || food.quantity || unitInfo(unit).base;
      const baseKcal = food.Kcal !== undefined ? food.Kcal : (food.kcal || 0);
      const baseProt = food.Protein !== undefined ? food.Protein : (food.protein || 0);
      const baseCarb = food.Carb !== undefined ? food.Carb : (food.carbs || 0);
      const baseFat = food.Fat !== undefined ? food.Fat : (food.fat || 0);
      // A food counted in slices or scoops starts at its own serving; one
      // weighed or measured starts empty, waiting for the amount.
      const defaultQty = food.userQty !== undefined ? food.userQty
        : food.qty !== undefined ? (food.qty || 0)
        : (unitInfo(unit).count ? baseQty : 0);
      const ratio = defaultQty > 0 ? (defaultQty / baseQty) : 0;
      // A food logged with macros typed in but no quantity has nothing to
      // scale by, so its macros come back exactly as logged and held.
      if (food.fixedMacros) {
        this.builderRows.push({
          id: rowId,
          name: food.Item || food.name || '',
          unit,
          baseQty,
          baseKcal,
          baseProt,
          baseCarb,
          baseFat,
          qty: 0,
          kcal: Math.round(baseKcal),
          prot: Math.round(baseProt * 10) / 10,
          carb: Math.round(baseCarb * 10) / 10,
          fat: Math.round(baseFat * 10) / 10,
          overrides: { kcal: true, prot: true, carb: true, fat: true }
        });
        return;
      }
      this.builderRows.push({
        id: rowId,
        name: food.Item || food.name || '',
        unit,
        baseQty,
        baseKcal,
        baseProt,
        baseCarb,
        baseFat,
        qty: defaultQty,
        kcal: Math.round(baseKcal * ratio),
        prot: Math.round(baseProt * ratio * 10) / 10,
        carb: Math.round(baseCarb * ratio * 10) / 10,
        fat: Math.round(baseFat * ratio * 10) / 10,
        // Macros the user has typed by hand, which quantity changes must not
        // overwrite. Keyed by kcal/prot/carb/fat.
        overrides: {}
      });
    } else {
      this.builderRows.push({
        id: rowId,
        name: '',
        unit: 'g',
        baseQty: 100,
        baseKcal: 0,
        baseProt: 0,
        baseCarb: 0,
        baseFat: 0,
        qty: 0,
        kcal: 0,
        prot: 0,
        carb: 0,
        fat: 0,
        overrides: {}
      });
    }
  }

  renderBuilderRows() {
    const container = document.getElementById('food-builder-rows-container');
    if (!container) return;
    if (this.builderRows.length === 0) {
      this.addNewBuilderRow();
    }
    let html = '';
    this.builderRows.forEach((row) => {
      // A row with nothing in it yet shows empty boxes rather than a line of
      // zeros that read like logged values.
      const blankRow = !(row.name || '').trim() && !row.kcal && !row.prot && !row.carb && !row.fat;
      html += `
        <div class="food-builder-row" id="${row.id}">
          <div class="food-search-top-line">
            <input type="text"
                   class="food-search-input-field"
                   placeholder="Search your foods or type a name"
                   aria-label="Food"
                   autocomplete="off"
                   autocorrect="off"
                   spellcheck="false"
                   enterkeyhint="search"
                   value="${this.escapeHTML(row.name)}"
                   oninput="app.updateRowName('${row.id}', this.value)"
                   onkeydown="app.handleFoodSearchKeydown('${row.id}', event)"
                   onfocus="app.handleFoodSearchInput('${row.id}', this.value)">
            <button class="scan-barcode-btn" title="Scan barcode" onclick="app.openBarcodeScanner('${row.id}')">
              ${SCAN_ICON_SVG}
            </button>
            <button class="trash-item-btn" title="Remove item" onclick="app.removeBuilderRow('${row.id}')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
            <div class="food-autocomplete-dropdown" id="dropdown-${row.id}"></div>
          </div>
          <div class="food-stat-boxes-row">
            <div class="stat-box-cell">
              <input type="number"
                     id="input-qty-${row.id}"
                     class="stat-box-input"
                     placeholder="0"
                     step="any"
                     inputmode="decimal"
                     aria-label="Amount, ${this.escapeHTML(unitInfo(unitOfEntry(row)).name.toLowerCase())}"
                     enterkeyhint="next"
                     value="${row.qty > 0 ? row.qty : ''}"
                     oninput="app.updateRowQty('${row.id}', this.value)"
                     onkeydown="app.handleQtyKeydown('${row.id}', event)">
              <span class="stat-box-lbl">${qtyLabelFor(unitOfEntry(row))}</span>
            </div>
            <div class="stat-box-cell">
              <input type="number" step="1" id="val-kcal-${row.id}"
                     class="stat-box-input stat-box-val kcal${row.overrides.kcal ? ' overridden' : ''}"
                     aria-label="Calories" placeholder="–"
                     value="${blankRow ? '' : row.kcal}"
                     oninput="app.updateRowMacro('${row.id}', 'kcal', this.value)">
              <span class="stat-box-lbl kcal">KCAL</span>
            </div>
            <div class="stat-box-cell">
              <input type="number" step="0.1" id="val-prot-${row.id}"
                     class="stat-box-input stat-box-val prot${row.overrides.prot ? ' overridden' : ''}"
                     aria-label="Protein, grams" placeholder="–"
                     value="${blankRow ? '' : row.prot}"
                     oninput="app.updateRowMacro('${row.id}', 'prot', this.value)">
              <span class="stat-box-lbl prot">PROT</span>
            </div>
            <div class="stat-box-cell">
              <input type="number" step="0.1" id="val-carb-${row.id}"
                     class="stat-box-input stat-box-val carb${row.overrides.carb ? ' overridden' : ''}"
                     aria-label="Carbs, grams" placeholder="–"
                     value="${blankRow ? '' : row.carb}"
                     oninput="app.updateRowMacro('${row.id}', 'carb', this.value)">
              <span class="stat-box-lbl carb">CARB</span>
            </div>
            <div class="stat-box-cell">
              <input type="number" step="0.1" id="val-fat-${row.id}"
                     class="stat-box-input stat-box-val fat${row.overrides.fat ? ' overridden' : ''}"
                     aria-label="Fat, grams" placeholder="–"
                     value="${blankRow ? '' : row.fat}"
                     oninput="app.updateRowMacro('${row.id}', 'fat', this.value)">
              <span class="stat-box-lbl fat">FAT</span>
            </div>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
    this.updateMealSubtotal();
    this.touchBuilder();
  }

  // Every structural change to the builder repaints, so this one hook covers
  // adding, removing, picking a food, loading a favourite and copying a meal.
  // Typing in a quantity or macro box does not repaint, so those call it too.
  touchBuilder() {
    this.refreshLogMealButton();
    // Mid-edit the rows on screen are a logged meal, not the builder draft -
    // what syncs is the stash, which is not changing.
    if (this.suppressBuilderSync || this.mealEdit) return;
    store.lastLocalBuilderChange = Date.now();
    clearTimeout(this.builderSyncTimer);
    // Long enough that typing a quantity is one write, not six.
    this.builderSyncTimer = setTimeout(() => store.syncBuilderDraft(), 1200);
  }

  // Painting rows that arrived from another device must not bounce straight
  // back out as a local change.
  renderBuilderRowsFromRemote() {
    this.suppressBuilderSync = true;
    try {
      this.renderBuilderRows();
    } finally {
      this.suppressBuilderSync = false;
    }
  }

  // Whatever is typed in the name box is the row's name straight away, so a
  // food typed by hand with its macros filled in counts and logs like any
  // other - no need to pick "Add to Log Only" from the list first.
  updateRowName(rowId, value) {
    const row = this.builderRows.find(r => r.id === rowId);
    if (row) {
      row.name = value || '';
      this.touchBuilder();
    }
    this.handleFoodSearchInput(rowId, value);
  }

  handleFoodSearchInput(rowId, query) {
    const dropdown = document.getElementById(`dropdown-${rowId}`);
    if (!dropdown) return;
    const rawQuery = (query || '').trim();
    const trimmed = rawQuery.toLowerCase();
    
    if (!trimmed) {
      this.closeRowDropdown(rowId);
      return;
    }

    if (!this.searchRequestCounters[rowId]) {
      this.searchRequestCounters[rowId] = 0;
    }
    const currentReqId = ++this.searchRequestCounters[rowId];

    // Keep the store filter across keystrokes, but any new query starts at
    // page 1 with the previously loaded pages discarded.
    const prev = this.searchState[rowId] || {};
    const state = this.searchState[rowId] = {
      query: rawQuery,
      brand: prev.brand || '',
      page: 1,
      extItems: [],
      count: 0,
      loading: trimmed.length >= 2,
      // Flat list of everything the arrow keys can land on, rebuilt on every
      // repaint, plus which entry is currently highlighted (-1 = none).
      options: [],
      activeIndex: -1
    };

    this.renderSearchDropdown(rowId);

    if (this.searchDebounceTimers[rowId]) {
      clearTimeout(this.searchDebounceTimers[rowId]);
    }

    if (trimmed.length >= 2) {
      this.searchDebounceTimers[rowId] = setTimeout(() => {
        this.runExternalSearch(rowId, currentReqId, false);
      }, 350);
    }
  }

  async runExternalSearch(rowId, reqId, append) {
    const state = this.searchState[rowId];
    if (!state) return;
    state.loading = true;
    this.renderSearchDropdown(rowId);

    const res = await this.searchExternalFoods(state.query, { page: state.page, brand: state.brand });
    // A newer keystroke has superseded this request.
    if (this.searchRequestCounters[rowId] !== reqId) return;

    const current = this.searchState[rowId];
    if (!current) return;
    current.extItems = append ? current.extItems.concat(res.items) : res.items;
    current.count = res.count;
    current.loading = false;
    this.renderSearchDropdown(rowId);
  }

  loadMoreSearchResults(rowId) {
    const state = this.searchState[rowId];
    if (!state || state.loading) return;
    state.page += 1;
    this.runExternalSearch(rowId, this.searchRequestCounters[rowId], true);
  }

  setStoreFilter(rowId, chipIndex) {
    const state = this.searchState[rowId];
    if (!state) return;
    const chip = this.storeChips[chipIndex];
    const value = chip ? chip.value : '';
    // Tapping the active chip clears the filter.
    state.brand = (state.brand === value) ? '' : value;
    state.page = 1;
    state.extItems = [];
    const reqId = ++this.searchRequestCounters[rowId];
    this.runExternalSearch(rowId, reqId, false);
  }

  renderSearchDropdown(rowId) {
    const dropdown = document.getElementById(`dropdown-${rowId}`);
    const state = this.searchState[rowId];
    if (!dropdown || !state) return;

    const trimmed = state.query.toLowerCase();
    const localMatches = store.foods
      .filter(f => (f.Item || f.name || '').toLowerCase().includes(trimmed))
      .slice(0, 6)
      .map(f => ({ ...f, source: 'db' }));

    // One flat, ordered list of everything the arrow keys can land on: the
    // foods first, then show-more, then the two footer actions. The index in
    // data-opt is the only thing the keyboard handler needs to act on an entry.
    const allItems = localMatches.concat(state.extItems);
    const shown = state.extItems.length;
    const hasMore = !state.loading && state.count > shown;
    const options = allItems.map(f => ({ kind: 'food', food: f }));
    const moreIdx = allItems.length;
    if (hasMore) options.push({ kind: 'more' });
    const logOnlyIdx = options.push({ kind: 'logOnly' }) - 1;
    const saveDbIdx = options.push({ kind: 'saveDb' }) - 1;
    state.options = options;
    // Results arriving under the cursor must not leave it pointing past the end.
    if (typeof state.activeIndex !== 'number' || state.activeIndex >= options.length) {
      state.activeIndex = -1;
    }
    const activeCls = (idx) => (state.activeIndex === idx ? ' kbd-active' : '');

    const renderItem = (f, optIdx) => {
      const name = f.Item || f.name || 'Food item';
      const source = f.source || 'db';
      const sourceLabel = source === 'openfood' ? 'OpenFood' : (source === 'usda' ? 'USDA' : 'My food');
      const kcal = f.Kcal !== undefined ? f.Kcal : (f.kcal || 0);
      const prot = f.Protein !== undefined ? f.Protein : (f.protein || 0);
      const carb = f.Carb !== undefined ? f.Carb : (f.carb || f.carbs || 0);
      const fat = f.Fat !== undefined ? f.Fat : (f.fat || 0);
      const safeFoodJSON = JSON.stringify(f).replace(/"/g, '&quot;');
      // Foods in the personal database can be quoted against any serving
      // size and type, so the macros above are per basisQty of its unit - not
      // always 100g.
      const unit = unitOfEntry(f);
      const basisQty = Number(f.Quantity || f.quantity) || unitInfo(unit).base;
      // Brand matters once results run deep - it is what separates Tesco Finest
      // from Tesco Everyday Value in a list of hundreds.
      const brandHTML = f.brand
        ? `<span class="autocomplete-brand">${this.escapeHTML(f.brand)}</span>`
        : '';
      // Save-to-database straight from the result, carrying that specific
      // food's macros across. Only for external hits - anything already in the
      // personal database has nothing to save.
      const saveHTML = source === 'db' ? '' : `
        <button type="button" class="autocomplete-save-btn" title="Save to my food list"
                onclick="event.stopPropagation(); app.saveSearchResultToDb('${rowId}', ${safeFoodJSON})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
        </button>
      `;
      return `
        <div class="autocomplete-option${activeCls(optIdx)}" data-opt="${optIdx}" onclick="app.selectFoodForRow('${rowId}', ${safeFoodJSON})">
          <div class="autocomplete-food-info">
            <div class="autocomplete-food-name-row">
              <span class="autocomplete-food-name">${this.escapeHTML(name)}</span>
              ${brandHTML}
              <span class="source-badge ${source}">${sourceLabel}</span>
            </div>
            <div class="autocomplete-macro-pills">
              ${kcal > 0 ? `<span class="macro-pill kcal">${kcal} kcal</span>` : ''}
              ${prot > 0 ? `<span class="macro-pill prot">P: ${prot}g</span>` : ''}
              ${carb > 0 ? `<span class="macro-pill carb">C: ${carb}g</span>` : ''}
              ${fat > 0 ? `<span class="macro-pill fat">F: ${fat}g</span>` : ''}
              ${(kcal + prot + carb + fat) === 0 ? '<span class="macro-pill">no macro data</span>' : ''}
              <span class="macro-per-qty${unit === 'g' && basisQty === 100 ? '' : ' custom-basis'}">(${formatAmount(basisQty, unit)})</span>
            </div>
          </div>
          ${saveHTML}
        </div>
      `;
    };

    const chipsHTML = `
      <div class="dropdown-store-chips">
        ${this.storeChips.map((c, i) => `
          <button type="button" class="store-chip${state.brand === c.value ? ' active' : ''}"
                  onclick="event.stopPropagation(); app.setStoreFilter('${rowId}', ${i})">${this.escapeHTML(c.label)}</button>
        `).join('')}
      </div>
    `;

    const escQ = this.escapeHTML(state.query);
    const safeQ = escQ.replace(/'/g, "\\'");
    const footerHTML = `
      <div class="dropdown-actions-footer">
        <div class="dropdown-action-btn log-only${activeCls(logOnlyIdx)}" data-opt="${logOnlyIdx}" onclick="app.addCustomToRowOnly('${rowId}', '${safeQ}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>Use "<strong>${escQ}</strong>" just this once</span>
        </div>
        <div class="dropdown-action-btn save-db${activeCls(saveDbIdx)}" data-opt="${saveDbIdx}" onclick="app.openSaveFoodFromRow('${rowId}', '${safeQ}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
          <span>Save "<strong>${escQ}</strong>" as a new food</span>
        </div>
      </div>
    `;

    const itemsHTML = allItems.map((f, idx) => renderItem(f, idx)).join('');

    let statusHTML = '';
    if (state.loading) {
      statusHTML = `<div class="autocomplete-no-match">Searching food database...</div>`;
    } else if (!itemsHTML) {
      statusHTML = `<div class="autocomplete-no-match">No foods found matching "${escQ}"</div>`;
    }

    // The remote count is what makes the depth visible - there are frequently
    // thousands of own-brand products behind a single page of results.
    let moreHTML = '';
    if (hasMore) {
      moreHTML = `
        <div class="dropdown-show-more${activeCls(moreIdx)}" data-opt="${moreIdx}" onclick="event.stopPropagation(); app.loadMoreSearchResults('${rowId}')">
          Show more &middot; ${shown} of ${state.count > 9999 ? '9999+' : state.count}
        </div>
      `;
    }

    dropdown.innerHTML = chipsHTML + itemsHTML + statusHTML + moreHTML + footerHTML;
    dropdown.classList.add('open');
  }

  // Arrow keys walk the open result list, Enter takes the highlighted entry and
  // Esc shuts the list without disturbing what has been typed.
  handleFoodSearchKeydown(rowId, e) {
    const key = e.key;
    if (key === 'Escape' || key === 'Esc') {
      // Only swallow Esc when there is actually a list to dismiss, so it still
      // reaches the dialog handler when nothing is open.
      if (this.searchState[rowId]) {
        e.preventDefault();
        e.stopPropagation();
        this.closeRowDropdown(rowId);
      }
      return;
    }
    const dropdown = document.getElementById(`dropdown-${rowId}`);
    if (!dropdown || !dropdown.classList.contains('open')) return;
    const state = this.searchState[rowId];
    const options = state && state.options;
    if (!options || !options.length) return;

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      // preventDefault, or the caret jumps to the start/end of the field.
      e.preventDefault();
      const n = options.length;
      const delta = key === 'ArrowDown' ? 1 : -1;
      state.activeIndex = state.activeIndex < 0
        ? (delta > 0 ? 0 : n - 1)
        : (state.activeIndex + delta + n) % n;
      this.applyDropdownActive(rowId);
    } else if (key === 'Enter') {
      e.preventDefault();
      // Nothing highlighted yet: Enter takes the top result, which is what the
      // list is offering anyway.
      this.activateDropdownOption(rowId, state.activeIndex >= 0 ? state.activeIndex : 0);
    }
  }

  // Moves the highlight without repainting the list - a full re-render would
  // reset the dropdown's scroll position on every keypress.
  applyDropdownActive(rowId) {
    const dropdown = document.getElementById(`dropdown-${rowId}`);
    const state = this.searchState[rowId];
    if (!dropdown || !state) return;
    dropdown.querySelectorAll('[data-opt]').forEach(el => {
      const on = Number(el.getAttribute('data-opt')) === state.activeIndex;
      el.classList.toggle('kbd-active', on);
      if (on) {
        try {
          el.scrollIntoView({ block: 'nearest' });
        } catch (err) { /* older engines */ }
      }
    });
  }

  activateDropdownOption(rowId, index) {
    const state = this.searchState[rowId];
    if (!state || !state.options) return;
    const opt = state.options[index];
    if (!opt) return;
    // Most branches below wipe the search state, so read what is needed first.
    const query = state.query;
    if (opt.kind === 'food') this.selectFoodForRow(rowId, opt.food);
    else if (opt.kind === 'more') this.loadMoreSearchResults(rowId);
    else if (opt.kind === 'logOnly') this.addCustomToRowOnly(rowId, query);
    else if (opt.kind === 'saveDb') this.openSaveFoodFromRow(rowId, query);
  }

  // Enter on a desktop keyboard, or Next on a phone, once the quantity is in:
  // move straight on to the next food's name field, adding a row if this was
  // the last one.
  handleQtyKeydown(rowId, e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    this.updateRowQty(rowId, e.target.value);
    this.focusNextFoodRow(rowId);
  }

  focusNextFoodRow(rowId) {
    const idx = this.builderRows.findIndex(r => r.id === rowId);
    if (idx === -1) return;
    let next = this.builderRows[idx + 1];
    if (!next) {
      this.addNewBuilderRow();
      next = this.builderRows[this.builderRows.length - 1];
      // Only repaint when a row was actually added - re-rendering over a row
      // that already exists drops the phone keyboard for nothing.
      this.renderBuilderRows();
    }
    const nextId = next.id;
    // The keyboard is already up here (this runs from Enter / Next), so a
    // short delay costs nothing and lets the keydown finish first.
    setTimeout(() => this.focusBuilderRowName(nextId), 50);
  }

  focusBuilderRowName(rowId) {
    const rowEl = document.getElementById(rowId);
    const input = rowEl ? rowEl.querySelector('.food-search-input-field') : null;
    if (!input) return;
    input.focus();
    input.select();
  }

  // Shared Open Food Facts -> internal food shape. Both the name search and the
  // barcode scanner go through here so the nutriment parsing lives in one place.
  mapOffProductToFood(p) {
    if (!p) return null;
    const pName = p.product_name || p.product_name_en || p.generic_name;
    if (!pName) return null;
    const nut = p.nutriments || {};
    const kcal = Math.round(nut['energy-kcal_100g'] || (nut['energy-kj_100g'] ? nut['energy-kj_100g'] / 4.184 : 0));
    const prot = Math.round((nut['proteins_100g'] || 0) * 10) / 10;
    const carb = Math.round((nut['carbohydrates_100g'] || 0) * 10) / 10;
    const fat = Math.round((nut['fat_100g'] || 0) * 10) / 10;
    // Drinks are quoted per 100 ml. Open Food Facts uses the same _100g keys
    // either way, but the pack size ("330 ml", "1 L") says which it is; the
    // serving size only counts when there is no pack size, since a jar of
    // honey can list its serving as "1 tbsp (15 ml)".
    const packText = String(p.quantity || p.serving_size || '');
    const liquid = /\d\s*(ml|cl|dl|l|litres?|liters?)\b/i.test(packText);
    return {
      id: 'off-' + (p.code || Math.random().toString(36).substr(2, 6)),
      Item: pName.substring(0, 50),
      Quantity: 100,
      Unit: liquid ? 'ml' : 'g',
      Kcal: kcal,
      Protein: prot,
      Carb: carb,
      Fat: fat,
      source: 'openfood',
      // Display-only extras. The builder ignores keys it does not know about.
      barcode: p.code || null,
      // The barcode API returns brands as a comma-separated string, the search
      // proxy returns it as an array. Both land here.
      brand: Array.isArray(p.brands)
        ? (p.brands[0] || '').trim()
        : (p.brands || '').split(',')[0].trim(),
      imageUrl: p.image_front_small_url || '',
      servingSize: p.serving_size || ''
    };
  }

  async searchExternalFoods(query, opts = {}) {
    const page = opts.page || 1;
    const brand = opts.brand || '';
    // Cache key must include page and brand, or paging would collide with a
    // cached first page and quietly serve stale results.
    const cacheKey = `${query}|${page}|${brand}`;
    const cached = this.foodSearchCache.get(cacheKey);
    if (cached) return cached;

    const results = [];
    let offCount = 0;
    // Goes through our own /api proxy rather than Open Food Facts directly:
    // their CORS-enabled search endpoints fail about half the time, and the
    // reliable one cannot be called from a browser. See api/off-search.js.
    const params = new URLSearchParams({ q: query, page: String(page) });
    if (brand) params.set('brand', brand);
    const openFoodPromise = fetch(`/api/off-search?${params.toString()}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.products)) {
          offCount = data.count || data.products.length;
          data.products.forEach(p => {
            const mapped = this.mapOffProductToFood(p);
            if (mapped) results.push(mapped);
          });
        }
      })
      .catch(() => {});

    // USDA only rides along on the first page - it is a supplement to the
    // Open Food Facts results, not something to paginate through.
    const usdaPromise = (page > 1 || brand) ? Promise.resolve() : fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${CONFIG.USDA_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, pageSize: 3, dataType: ["Branded", "SR Legacy", "Foundation Foods"] })
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.foods && data.foods.length > 0) {
          const f = data.foods[0];
          const getNut = (id) => {
            const found = (f.foodNutrients || []).find(n => n.nutrientId === id || n.nutrientNumber === id.toString());
            return found ? found.value : 0;
          };
          results.push({
            id: 'usda-' + f.fdcId,
            Item: f.description.substring(0, 50),
            Quantity: 100,
            Kcal: Math.round(getNut(1008)),
            Protein: Math.round(getNut(1003) * 10) / 10,
            Carb: Math.round(getNut(1005) * 10) / 10,
            Fat: Math.round(getNut(1004) * 10) / 10,
            source: 'usda'
          });
        }
      })
      .catch(() => {});

    await Promise.allSettled([openFoodPromise, usdaPromise]);
    const payload = { items: results, count: offCount };
    // Only worth remembering a query that actually produced something.
    if (results.length > 0) this.foodSearchCache.set(cacheKey, payload);
    return payload;
  }

  // ---------- Voice logging ----------
  // Uses the browser's built-in speech recognition: free, no key. Chrome sends
  // the audio to Google for recognition, so it needs a connection. Available on
  // Android Chrome and desktop Chrome/Edge; absent in Firefox.

  getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  isVoiceSupported() {
    return !!this.getSpeechRecognitionCtor();
  }

  openVoiceModal() {
    // Each opening starts a fresh list; within a session, speech appends.
    this.voiceItems = [];
    // Discard any speech left buffered from a previous session.
    this.voiceSegments = [];
    this.voiceListFrozen = false;
    if (this.voiceLiveTimer) { clearTimeout(this.voiceLiveTimer); this.voiceLiveTimer = null; }
    const transcriptEl = document.getElementById('voice-transcript');
    const statusEl = document.getElementById('voice-status');
    const resultsEl = document.getElementById('voice-results');
    const applyBtn = document.getElementById('voice-apply-btn');
    if (transcriptEl) transcriptEl.textContent = '';
    if (resultsEl) resultsEl.innerHTML = '';
    if (applyBtn) applyBtn.style.display = 'none';
    // Reset the status too, or the previous run's "Check these..." lingers.
    if (statusEl) statusEl.textContent = 'Starting microphone...';
    this.openModal('voice-log-modal');

    if (!this.isVoiceSupported()) {
      if (statusEl) statusEl.textContent = 'Voice input needs Chrome or Edge. Type the food name instead.';
      return;
    }
    this.startVoiceCapture();
  }

  // Tapping the mic toggles: it stays live until tapped again.
  toggleVoiceCapture() {
    if (this.voiceListening) this.stopVoiceCapture();
    else this.startVoiceCapture();
  }

  startVoiceCapture() {
    const Ctor = this.getSpeechRecognitionCtor();
    if (!Ctor) return;
    this.stopVoiceCapture();

    const statusEl = document.getElementById('voice-status');
    const transcriptEl = document.getElementById('voice-transcript');
    // Whatever a previous mic session produced is now settled: mark it kept so
    // this session's live recompute adds to it instead of replacing it.
    this.voiceItems.forEach(i => { i.source = 'kept'; });
    this.voiceSegments = [];
    this.voiceListFrozen = false;

    const rec = new Ctor();
    this.recognition = rec;
    rec.lang = 'en-US';
    rec.interimResults = true;
    // Continuous, so a pause between foods does not end the session.
    rec.continuous = true;
    // Ask for several hypotheses, not just the top one. The correct words are
    // frequently in alternative 2 or 3, and picking whichever resolves best
    // against the personal database is the closest thing to vocabulary biasing
    // still available - the Web Speech grammar API was removed from the spec.
    rec.maxAlternatives = 5;
    this.voiceListening = true;

    rec.onstart = () => {
      if (statusEl) statusEl.textContent = 'Listening... tap the mic again to stop';
      const btn = document.getElementById('voice-record-btn');
      if (btn) btn.classList.add('recording');
    };

    // How many final results this session has already consumed. event.resultIndex
    // is NOT safe for this: it marks the first *changed* result, and Chrome
    // re-fires on results that are already final, which appended the same food
    // over and over. Counting consumed finals makes each one process exactly once.
    rec._finalsConsumed = 0;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          if (i >= rec._finalsConsumed) {
            rec._finalsConsumed = i + 1;
            // Collect every hypothesis this engine offered, best-first.
            const alts = [];
            for (let a = 0; a < res.length; a++) {
              const t = res[a] && res[a].transcript ? res[a].transcript.trim() : '';
              if (t && !alts.includes(t)) alts.push(t);
            }
            if (alts.length) this.recordVoiceSegment(alts);
          }
        } else {
          interim += res[0].transcript;
        }
      }
      if (transcriptEl) transcriptEl.textContent = interim.trim();
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.voiceListening = false;
      const btn = document.getElementById('voice-record-btn');
      if (btn) btn.classList.remove('recording');
      if (statusEl) {
        statusEl.textContent = e.error === 'not-allowed'
          ? 'Microphone permission denied.'
          : 'Could not hear that. Tap the mic to try again.';
      }
    };

    rec.onend = () => {
      // Chrome ends the session on its own after a silence even in continuous
      // mode, so restart until the user actually asks it to stop.
      if (this.voiceListening && this.recognition === rec) {
        // A restart begins a fresh results list at index 0, so the consumed
        // count has to reset with it - otherwise the new session's first
        // utterances are skipped as though already handled.
        rec._finalsConsumed = 0;
        try { rec.start(); return; } catch (e) { /* fall through to stop */ }
      }
      this.voiceListening = false;
      const btn = document.getElementById('voice-record-btn');
      if (btn) btn.classList.remove('recording');
      if (statusEl && this.voiceItems.length > 0) {
        statusEl.textContent = 'Stopped. Check the list, then add to the builder.';
      }
    };

    try {
      rec.start();
    } catch (e) {
      this.voiceListening = false;
      if (statusEl) statusEl.textContent = 'Could not start the microphone.';
    }
  }

  stopVoiceCapture() {
    this.voiceListening = false;
    // Final recompute so the last words land even if the debounce had not fired.
    this.applySpeechToList();
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try { rec.abort(); } catch (e) { /* already stopped */ }
    }
    const btn = document.getElementById('voice-record-btn');
    if (btn) btn.classList.remove('recording');
  }

  // Local fallback for when the parsing API is unavailable or not configured.
  // Deliberately conservative: it only recognises an explicit amount, and
  // never invents one.
  // Splits a spoken meal into foods. Numbers act as the delimiter, so no
  // conjunctions are needed: "150 chicken 5 olive oil 90 basmati rice" parses
  // into three items. Conjunctions and commas still work when present.
  parseTranscriptLocally(transcript) {
    // Two separators have to work at once: explicit ones (commas, "and") and
    // implicit ones (a number starting the next food). Conjunctions become a
    // marker first, then each chunk is split again on its numbers.
    const marked = String(transcript || '')
      .replace(/[,;]/g, ' | ')
      .replace(/\b(and|with|then|plus)\b/gi, ' | ')
      .replace(/\bof\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!marked) return [];

    if (marked.includes('|')) {
      return marked
        .split('|')
        .flatMap(chunk => this.parseTranscriptLocally(chunk))
        .filter(it => it.name);
    }

    const cleaned = marked.replace(/^(a|an|some|the)\s+/i, '').trim();
    if (!cleaned) return [];

    const UNITS = /^(grams?|kgs?|kilograms?|mls?|millilitres?|milliliters?|l|litres?|liters?|oz|ounces?|g)$/i;
    const toGrams = (amount, unit) => {
      const u = (unit || 'g').toLowerCase();
      if (/^(kgs?|kilograms?|l|litres?|liters?)$/.test(u)) return amount * 1000;
      if (/^(oz|ounces?)$/.test(u)) return amount * 28;
      return amount; // grams and millilitres map 1:1
    };

    const tokens = cleaned.split(' ');
    const items = [];
    let current = null;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const asNum = parseFloat(tok);
      const isNumber = /^\d+(\.\d+)?$/.test(tok);

      if (isNumber) {
        // A number starts a new food. Push whatever was being built first.
        if (current && current.words.length) items.push(current);
        let unit = null;
        if (tokens[i + 1] && UNITS.test(tokens[i + 1])) {
          unit = tokens[i + 1];
          i++; // consume the unit token
        }
        // `measured`: the amount came with a weight or volume, rather than
        // being a bare count like "2 eggs".
        current = { grams: Math.round(toGrams(asNum, unit)), measured: !!unit, words: [] };
        continue;
      }

      // A number written joined to its unit, e.g. "150g".
      const joined = tok.match(/^(\d+(?:\.\d+)?)(grams?|kgs?|mls?|l|oz|g)$/i);
      if (joined) {
        if (current && current.words.length) items.push(current);
        current = { grams: Math.round(toGrams(parseFloat(joined[1]), joined[2])), measured: true, words: [] };
        continue;
      }

      if (!current) current = { grams: null, measured: false, words: [] };
      current.words.push(tok);
    }
    if (current && current.words.length) items.push(current);

    return items
      .map(it => ({
        name: it.words.join(' ').replace(/^(a|an|some|the)\s+/i, '').trim().slice(0, 60),
        grams: it.grams,
        measured: it.measured
      }))
      .filter(it => it.name);
  }

  // Picks the best of one segment's hypotheses by how well it resolves against
  // your database. Crucially this only ever returns text the engine actually
  // produced - combining hypotheses ACROSS segments invented strings like
  // "n250 n250 n250 ol", which then got parsed as food.
  pickBestSegmentText(alts) {
    if (!alts || alts.length === 0) return '';
    if (alts.length === 1) return alts[0];

    let bestText = alts[0];
    let bestScore = -1;
    alts.forEach(text => {
      const parsed = this.parseTranscriptLocally(text);
      if (!parsed.length) return;
      let matched = 0;
      let scoreSum = 0;
      parsed.forEach(p => {
        const f = this.findBestLocalFood(p.name);
        if (f) { matched++; scoreSum += f.matchScore; }
      });
      const ratio = matched / parsed.length;
      const avg = matched ? (scoreSum / matched) / 100 : 0;
      const score = ratio * avg;
      if (score > bestScore) { bestScore = score; bestText = text; }
    });
    return bestText;
  }

  // Accumulates the session's speech. Android emits a final result and then
  // REVISES it with a longer one covering the same audio ("breast", then
  // "breast chicken") - appending both is what produced two rows per food, so
  // a revision replaces its predecessor instead of adding to it.
  recordVoiceSegment(alts) {
    const text = this.pickBestSegmentText(alts).trim();
    if (!text) return;

    const prev = this.voiceSegments[this.voiceSegments.length - 1];
    if (prev) {
      const a = prev.toLowerCase();
      const b = text.toLowerCase();
      if (b.includes(a)) {            // revision of the previous segment
        this.voiceSegments[this.voiceSegments.length - 1] = text;
        return;
      }
      if (a.includes(b)) return;      // already covered by what we have
    }
    this.voiceSegments.push(text);
    this.scheduleVoiceLiveUpdate();
  }

  scheduleVoiceLiveUpdate() {
    if (this.voiceLiveTimer) clearTimeout(this.voiceLiveTimer);
    this.voiceLiveTimer = setTimeout(() => this.applySpeechToList(), 600);
  }

  // Recomputes the whole list from the full transcript instead of appending to
  // it. Because the result is derived fresh every time, repeats and revisions
  // cannot accumulate - which is what makes live updates safe here, where
  // appending on each result produced duplicates.
  async applySpeechToList() {
    if (this.voiceLiveTimer) {
      clearTimeout(this.voiceLiveTimer);
      this.voiceLiveTimer = null;
    }
    // Once you start correcting the list, speech stops rewriting it - nothing
    // should change under your hands mid-edit.
    if (this.voiceListFrozen) return;
    if (!this.voiceSegments.length) return;

    const transcript = this.voiceSegments.join(' ').replace(/\s+/g, ' ').trim();
    if (!transcript) return;

    const resolved = await this.resolveTranscript(transcript);
    if (!resolved) return;
    if (this.voiceListFrozen) return;   // may have been touched while resolving

    resolved.forEach(r => { r.source = 'speech'; });
    // Anything added by hand, or committed from an earlier mic session, is kept
    // and stays above the current session's foods so the list reads in the
    // order things were actually said.
    const kept = this.voiceItems.filter(i => i.source !== 'speech');
    this.voiceItems = kept.concat(resolved);
    this.renderParsedItems();

    const statusEl = document.getElementById('voice-status');
    if (statusEl) {
      statusEl.textContent = this.voiceListening
        ? 'Listening... tap the mic again to stop'
        : 'Check these, then add them to the builder.';
    }
  }

  // Transcript -> resolved items, or null when nothing could be parsed.
  async resolveTranscript(text) {
    let items = this.parseTranscriptLocally(text);
    if (items.length === 0) {
      try {
        const res = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'voice', transcript: text })
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.items)) items = data.items;
        }
      } catch (e) { /* nothing more to try */ }
    }
    if (items.length === 0) return null;
    return this.resolveParsedItems(items);
  }

  // Any hands-on change stops speech from rewriting the list for the rest of
  // the session.
  freezeVoiceList() {
    this.voiceListFrozen = true;
  }

  // Accepts either a single transcript or an array of the engine's ranked
  // hypotheses, best-first.
  async handleVoiceTranscript(transcript) {
    const statusEl = document.getElementById('voice-status');
    const text = String(transcript || '').trim();

    if (!text) {
      if (statusEl) statusEl.textContent = 'Nothing heard. Tap the mic to try again.';
      return;
    }

    // One transcript, one parse. Choosing between the engine's hypotheses now
    // happens per segment in pickBestSegmentText(), where the candidates are
    // real things the engine said rather than combinations of them.
    let items = this.parseTranscriptLocally(text);

    if (items.length === 0) {
      try {
        const res = await fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'voice', transcript: text })
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.items)) items = data.items;
        }
      } catch (e) { /* nothing more to try */ }
    }

    if (items.length === 0) {
      if (statusEl) statusEl.textContent = 'Could not pick out any foods. Tap the mic to try again.';
      return;
    }

    const resolved = await this.resolveParsedItems(items);
    // Append: tapping the mic again for a second batch adds to the list.
    this.voiceItems = this.voiceItems.concat(resolved);
    this.renderParsedItems();
    if (statusEl) {
      statusEl.textContent = this.voiceListening
        ? 'Listening... tap the mic again to stop'
        : 'Check these, then add them to the builder.';
    }
  }

  // Turns {name, grams} into a real food by running each name through the
  // it through the existing search pipeline. The database supplies the macros -
  // never the language model.
  async resolveParsedItems(items) {
    const resolved = [];
    for (const item of items) {
      const food = this.findBestLocalFood(item.name);
      // The parsing API only gives an amount when one was stated, always as
      // grams - so anything it returns counts as measured.
      const measured = item.measured !== undefined ? !!item.measured : item.grams != null;
      resolved.push({
        spoken: item.name,
        // The original transcript, kept so a later correction can be learned
        // against what was actually heard rather than the edited text.
        heard: item.name,
        grams: item.grams,
        measured,
        food,
        qty: this.spokenAmountFor(food, item.grams, measured)
      });
    }
    return resolved;
  }

  // What was said, in the matched food's own unit. Grams and millilitres go
  // straight across; kilograms and litres are a thousand of them; a count
  // ("2 eggs") is that many of a food counted in units - but a weight said
  // for one ("150 g of egg") cannot be turned into a count, so it is left
  // for you to fill in.
  spokenAmountFor(food, amount, measured) {
    const n = Number(amount);
    if (amount === null || amount === undefined || !isFinite(n) || n <= 0) return null;
    const unit = unitInfo(unitOfEntry(food));
    if (unit.id === 'kg' || unit.id === 'l') return Math.round((n / 1000) * 1000) / 1000;
    if (unit.count) return measured ? null : n;
    return n;
  }

  // Normalises a spoken food name for comparison: lowercase, punctuation out,
  // filler words dropped, and simple plurals folded so "olives" meets "olive".
  normaliseFoodName(str) {
    const STOP = new Set(['the', 'a', 'an', 'of', 'some', 'fresh', 'raw', 'plain', 'natural', 'organic']);
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !STOP.has(w))
      .map(w => (w.length > 3 && w.endsWith('es')) ? w.slice(0, -2)
              : (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1)
              : w);
  }

  // Levenshtein distance, capped in practice by the short strings involved.
  editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const curr = [i];
      for (let j = 1; j <= b.length; j++) {
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = curr;
    }
    return prev[b.length];
  }

  // Word-level similarity, 0..1. A spoken word counts as matching a database
  // word if it is identical, a prefix of it, or within a small edit distance -
  // which is what lets "chiken", "chicken breast" and "breast chicken" all
  // reach "Chicken Breast".
  // Soundex key. Speech errors are phonetic, not orthographic - edit distance
  // sees "whey" and "way" as far apart, while they sound identical. Collapses
  // cocoa/cacao -> C200, whey/way -> W000, chicken/chiken -> C250.
  soundex(word) {
    const s = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!s) return '';
    const code = (c) => {
      if ('BFPV'.includes(c)) return '1';
      if ('CGJKQSXZ'.includes(c)) return '2';
      if ('DT'.includes(c)) return '3';
      if (c === 'L') return '4';
      if ('MN'.includes(c)) return '5';
      if (c === 'R') return '6';
      return '';
    };
    let out = s[0];
    let prev = code(s[0]);
    for (let i = 1; i < s.length; i++) {
      const c = code(s[i]);
      // H and W do not break a run of the same code; vowels do.
      if (c && c !== prev) out += c;
      if (!'HW'.includes(s[i])) prev = c;
      if (out.length === 4) break;
    }
    return (out + '000').slice(0, 4);
  }

  // Similarity of two strings 0..1, by edit distance normalised to the longer.
  stringSimilarity(a, b) {
    if (!a || !b) return 0;
    const longer = Math.max(a.length, b.length);
    return 1 - (this.editDistance(a, b) / longer);
  }

  wordSimilarity(spokenWords, dbWords) {
    if (!spokenWords.length || !dbWords.length) return 0;

    // Graded rather than boolean, so a phonetic-only hit counts for real but
    // never outranks a genuine one.
    const matchStrength = (sw, dw) => {
      if (sw === dw) return 1;
      if (sw.length >= 4 && (dw.startsWith(sw) || sw.startsWith(dw))) return 1;
      const tolerance = sw.length <= 4 ? 1 : 2;
      if (this.editDistance(sw, dw) <= tolerance) return 0.9;
      // Only trust phonetics on words long enough to have a distinctive sound.
      if (sw.length >= 3 && dw.length >= 3 && this.soundex(sw) === this.soundex(dw)) return 0.8;
      return 0;
    };

    const best = (word, against) => against.reduce((m, w) => Math.max(m, matchStrength(word, w)), 0);

    // Weighted by word length: a long distinctive word like "cottage" carries
    // far more signal than a short filler like "bio", so matching it should
    // count for more than matching one of several short words.
    const weight = (w) => w.length;
    const spokenTotal = spokenWords.reduce((a, w) => a + weight(w), 0);
    const dbTotal = dbWords.reduce((a, w) => a + weight(w), 0);

    let spokenHit = 0;
    spokenWords.forEach(sw => { spokenHit += weight(sw) * best(sw, dbWords); });
    let dbHit = 0;
    dbWords.forEach(dw => { dbHit += weight(dw) * best(dw, spokenWords); });

    // Reward covering what was said, and lightly penalise database entries with
    // a lot of unmatched extra words so short exact names beat long ones.
    const coverage = spokenTotal ? spokenHit / spokenTotal : 0;
    const precision = dbTotal ? dbHit / dbTotal : 0;
    const wordScore = coverage * 0.75 + precision * 0.25;

    // Word-boundary errors are among the most common things a speech engine
    // makes - "Avonmore" comes back as "have on more". Comparing the strings
    // with the spaces removed survives that; the per-word pass cannot.
    const joinedScore = this.stringSimilarity(spokenWords.join(''), dbWords.join(''));

    // Only count the joined comparison when it is strong enough to actually
    // indicate a boundary error. Any two short strings share some characters,
    // so taking it unconditionally lifted every unrelated food off zero and
    // drowned out the gap between the right answer and the rest.
    return joinedScore >= 0.7 ? Math.max(wordScore, joinedScore) : wordScore;
  }

  // --- Learned corrections -------------------------------------------------
  // Fixing a mis-heard food in the popup used to be thrown away, so the same
  // brand was mangled the same way forever. Remembering the correction means
  // an awkward name needs fixing exactly once.

  getVoiceAliases() {
    try {
      const raw = localStorage.getItem('macroVoiceAliases');
      const parsed = raw ? JSON.parse(raw) : null;
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  setVoiceAlias(heard, foodItem) {
    const key = this.normaliseFoodName(heard).join(' ');
    if (!key || !foodItem) return;
    // Nothing to learn when the words already say the answer.
    if (key === this.normaliseFoodName(foodItem).join(' ')) return;
    try {
      const aliases = this.getVoiceAliases();
      aliases[key] = foodItem;
      const keys = Object.keys(aliases);
      // Keep the map bounded; oldest keys drop first.
      if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(k => delete aliases[k]);
      localStorage.setItem('macroVoiceAliases', JSON.stringify(aliases));
    } catch (e) { /* private mode */ }
  }

  clearVoiceAliases() {
    try { localStorage.removeItem('macroVoiceAliases'); } catch (e) { /* private mode */ }
    this.showToast('Learned voice corrections cleared', 'success');
  }

  // Best entry in the personal database for a spoken name, or null when
  // nothing is close enough to be trustworthy.
  findBestLocalFood(spokenName) {
    const spoken = this.normaliseFoodName(spokenName);
    if (!spoken.length) return null;
    const withMacros = (f) => f && (f.Kcal > 0 || f.Protein > 0 || f.Carb > 0 || f.Fat > 0);
    const spokenJoined = spoken.join(' ');

    // A correction you made previously is an exact answer - it beats any amount
    // of fuzzy scoring, so it is checked first.
    const aliasTarget = this.getVoiceAliases()[spokenJoined];
    if (aliasTarget) {
      const aliased = store.foods.find(f => (f.Item || f.name || '') === aliasTarget);
      if (aliased && withMacros(aliased)) {
        return { ...aliased, source: 'db', matchScore: 100, viaAlias: true };
      }
    }

    let best = null;
    let bestScore = 0;
    let runnerUp = 0;

    store.foods.forEach(f => {
      if (!withMacros(f)) return;
      const dbWords = this.normaliseFoodName(f.Item || f.name || '');
      if (!dbWords.length) return;
      const dbJoined = dbWords.join(' ');

      let score = this.wordSimilarity(spoken, dbWords);
      // Straight substring containment is a strong signal on its own.
      if (dbJoined === spokenJoined) score = 1;
      else if (dbJoined.includes(spokenJoined) || spokenJoined.includes(dbJoined)) {
        score = Math.max(score, 0.9);
      }

      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        best = { ...f, source: 'db', matchScore: Math.round(score * 100) };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    });

    // Confident on its own merits.
    if (bestScore >= 0.5) return best;
    // Or: a middling score that is nonetheless far ahead of everything else.
    // One clear front-runner is trustworthy even when the absolute score is
    // dragged down by extra words in the stored name ("cottage cheese" against
    // "light cottage germany"). A marginal score in a crowded field is not.
    // Relative, not absolute: with phonetic scoring every food now earns some
    // partial credit, so a fixed gap no longer separates a clear winner from a
    // crowded field. Being a third better than the next best does.
    if (bestScore >= 0.4 && bestScore >= runnerUp * 1.3) return best;
    return null;
  }

  renderParsedItems() {
    const listEl = document.getElementById('voice-results');
    const applyBtn = document.getElementById('voice-apply-btn');
    const items = this.voiceItems;
    if (!listEl) return;

    if (items.length === 0) {
      listEl.innerHTML = '';
      if (applyBtn) applyBtn.style.display = 'none';
      return;
    }

    // A datalist of your own foods gives the same pick-from-your-database
    // behaviour as the builder's search, without a second dropdown system.
    const optionsHTML = store.foods
      .map(f => `<option value="${this.escapeHTML(f.Item || f.name || '')}"></option>`)
      .join('');

    listEl.innerHTML = `<datalist id="voice-food-options">${optionsHTML}</datalist>` +
      items.map((it, i) => {
        const matched = !!it.food;
        const kcal = matched ? it.food.Kcal : 0;
        const shownName = matched ? (it.food.Item || it.food.name) : it.spoken;
        const unit = unitOfEntry(it.food);
        return `
          <div class="parsed-item">
            <div class="parsed-item-main">
              <input type="text" class="parsed-item-name-input" list="voice-food-options"
                     value="${this.escapeHTML(shownName)}"
                     oninput="app.updateParsedItemName(${i}, this.value)">
              <div class="parsed-item-sub">
                ${matched
                  ? `heard "${this.escapeHTML(it.heard || it.spoken)}" &middot; ${kcal} kcal ${this.escapeHTML(formatBasis(it.food.Quantity || unitInfo(unit).base, unit))}${
                      it.food.viaAlias
                        ? ' <span class="parsed-learned">learned</span>'
                        : (it.food.matchScore && it.food.matchScore < 100
                            ? ` <span class="parsed-approx">~${it.food.matchScore}% match</span>` : '')}`
                  : `heard "${this.escapeHTML(it.heard || it.spoken)}" &middot; <span class="parsed-unmatched">not in your food list</span>`}
              </div>
            </div>
            <input type="number" class="parsed-item-qty" step="any" inputmode="decimal"
                   placeholder="${this.escapeHTML(unitInfo(unit).plural || unitInfo(unit).label)}"
                   title="${this.escapeHTML(unitInfo(unit).name)}"
                   value="${it.qty !== null && it.qty !== undefined ? it.qty : ''}"
                   oninput="app.updateParsedItemQty(${i}, this.value)">
            <button type="button" class="pill-icon-btn danger parsed-item-del" title="Remove"
                    onclick="app.removeParsedItem(${i})">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        `;
      }).join('');

    if (applyBtn) applyBtn.style.display = '';
  }

  // Re-matches against the personal database as the name is edited, so a
  // mis-heard food can be corrected in place.
  updateParsedItemName(index, value) {
    const it = this.voiceItems[index];
    if (!it) return;
    this.freezeVoiceList();
    const name = String(value || '').trim();
    const match = this.findBestLocalFood(name);
    it.food = match;

    // Correcting the name teaches the mapping from what was originally heard to
    // the food you actually meant, so the same mishearing resolves next time.
    if (match && it.heard && it.heard !== name) {
      this.setVoiceAlias(it.heard, match.Item || match.name);
    }
    it.spoken = name;
    // The amount follows the new match's unit, unless it was typed by hand.
    if (!it.qtyEdited) it.qty = this.spokenAmountFor(match, it.grams, it.measured);

    // Only refresh the subtitle and the amount - re-rendering would steal
    // focus mid-typing.
    const sub = document.querySelectorAll('#voice-results .parsed-item')[index];
    const subEl = sub && sub.querySelector('.parsed-item-sub');
    const unit = unitOfEntry(match);
    if (subEl) {
      subEl.innerHTML = match
        ? `matched &middot; ${match.Kcal} kcal ${this.escapeHTML(formatBasis(match.Quantity || unitInfo(unit).base, unit))}`
        : `<span class="parsed-unmatched">not in your food list</span>`;
    }
    const qtyEl = sub && sub.querySelector('.parsed-item-qty');
    if (qtyEl) {
      qtyEl.placeholder = unitInfo(unit).plural || unitInfo(unit).label;
      qtyEl.title = unitInfo(unit).name;
      if (!it.qtyEdited) qtyEl.value = it.qty !== null && it.qty !== undefined ? it.qty : '';
    }
  }

  removeParsedItem(index) {
    this.freezeVoiceList();
    this.voiceItems.splice(index, 1);
    this.renderParsedItems();
  }

  // Manual row, for building the rest of the meal without speaking.
  addManualVoiceItem() {
    this.freezeVoiceList();
    this.voiceItems.push({ spoken: '', grams: null, measured: false, qty: null, food: null, source: 'manual' });
    this.renderParsedItems();
    setTimeout(() => {
      const inputs = document.querySelectorAll('#voice-results .parsed-item-name-input');
      const last = inputs[inputs.length - 1];
      if (last) last.focus();
    }, 50);
  }

  updateParsedItemQty(index, value) {
    this.freezeVoiceList();
    const items = this.voiceItems;
    if (!items[index]) return;
    const v = parseFloat(value);
    // In the matched food's own unit, as shown beside it.
    items[index].qty = isNaN(v) ? null : v;
    items[index].qtyEdited = true;
  }

  applyParsedItems() {
    const items = this.voiceItems;
    if (!items.length) return;

    // Drop a single empty starter row rather than leaving a blank above the
    // items just added.
    if (this.builderRows.length === 1 && !this.builderRows[0].name) {
      this.builderRows = [];
    }

    items.forEach(it => {
      this.addNewBuilderRow();
      const row = this.builderRows[this.builderRows.length - 1];
      if (it.food) {
        row.name = it.food.Item || it.food.name || it.spoken;
        row.unit = unitOfEntry(it.food);
        row.baseQty = it.food.Quantity || unitInfo(row.unit).base;
        row.baseKcal = it.food.Kcal || 0;
        row.baseProt = it.food.Protein || 0;
        row.baseCarb = it.food.Carb || 0;
        row.baseFat = it.food.Fat || 0;
      } else {
        row.name = it.spoken;
      }

      // Quantity and derived macros must be on the row BEFORE rendering. Doing
      // this afterwards left the QTY box blank: updateRowQty writes the macro
      // fields but never the quantity input, so the template's already-rendered
      // empty value stuck.
      const qty = Number(it.qty);
      if (Number.isFinite(qty) && qty > 0) {
        row.qty = qty;
        const ratio = row.baseQty > 0 ? qty / row.baseQty : 0;
        row.kcal = Math.round(row.baseKcal * ratio);
        row.prot = Math.round(row.baseProt * ratio * 10) / 10;
        row.carb = Math.round(row.baseCarb * ratio * 10) / 10;
        row.fat = Math.round(row.baseFat * ratio * 10) / 10;
      }
    });

    this.renderBuilderRows();

    this.closeModal('voice-log-modal');
    this.showToast(`Added ${items.length} item${items.length > 1 ? 's' : ''}`, 'success');
  }

  // ---------- Barcode scanning ----------
  // Uses the browser's native BarcodeDetector (Chrome on Android). No library,
  // no API key. Lookups hit Open Food Facts, which is free and unauthenticated.

  isBarcodeScanSupported() {
    return 'BarcodeDetector' in window &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // GS1 mod-10 check digit. A misread that flips a digit almost always fails
  // this, which is the cheapest way to throw out bad decodes.
  //
  // UPC-E is deliberately exempt: it is 8 digits but its check digit is
  // computed after expansion to UPC-A, so testing it as EAN-8 would reject
  // perfectly good codes.
  isValidBarcodeChecksum(code, format) {
    if (!/^\d+$/.test(code)) return false;
    if (format === 'upc_e') return true;
    if (![8, 12, 13, 14].includes(code.length)) return false;

    const digits = code.split('').map(Number);
    const check = digits.pop();
    digits.reverse();
    let sum = 0;
    digits.forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === check;
  }

  async getSupportedBarcodeFormats() {
    const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const usable = wanted.filter(f => supported.includes(f));
      return usable.length > 0 ? usable : null;
    } catch (e) {
      return wanted;
    }
  }

  // purpose 'database' is the Foods page's "Scan a barcode": the product ends
  // up in the save-food form rather than in a Meal Builder row.
  async openBarcodeScanner(rowId, purpose = 'builder') {
    this.scanTargetRowId = rowId || null;
    this.scanPurpose = purpose;
    if (rowId) this.closeRowDropdown(rowId);

    const manualInput = document.getElementById('manual-barcode-input');
    if (manualInput) manualInput.value = '';
    const statusEl = document.getElementById('barcode-scan-status');
    const torchBtn = document.getElementById('barcode-torch-btn');
    if (torchBtn) torchBtn.style.display = 'none';
    this.markViewfinder('reading', false);
    this.markViewfinder('no-camera', false);

    this.openModal('barcode-scanner-modal');

    if (!this.isBarcodeScanSupported()) {
      if (statusEl) statusEl.textContent = 'Live scanning needs Chrome on Android. Type the digits below instead.';
      this.markViewfinder('no-camera', true);
      return;
    }
    if (statusEl) statusEl.textContent = 'Starting camera...';

    try {
      const formats = await this.getSupportedBarcodeFormats();
      this.barcodeDetector = formats
        ? new window.BarcodeDetector({ formats })
        : new window.BarcodeDetector();

      await this.startCameraStream(this.getPreferredCameraId());

      if (statusEl) statusEl.textContent = 'Line the barcode up inside the box';
      this.scanActive = true;
      // Reset the confirmation state and start the warm-up clock, so autofocus
      // has time to settle before any decode is taken seriously.
      this.scanCandidate = null;
      this.scanCandidateCount = 0;
      this.scanStartedAt = performance.now();
      this.lastDetectAt = 0;
      this.runScanLoop();
    } catch (e) {
      console.warn('Camera start failed:', e);
      if (statusEl) statusEl.textContent = 'Could not open the camera. Type the digits below instead.';
      this.stopBarcodeCamera();
      this.markViewfinder('no-camera', true);
    }
  }

  // Flags on the scanner dialog: 'no-camera' swaps the black preview for a
  // short message, 'reading' turns the frame green while a code is confirmed.
  markViewfinder(flag, on) {
    const el = document.querySelector('.barcode-scanner-box');
    if (el) el.classList.toggle(flag, !!on);
  }

  syncTorchButton() {
    const btn = document.getElementById('barcode-torch-btn');
    if (btn) btn.setAttribute('aria-pressed', this.torchOn ? 'true' : 'false');
  }

  // A phone typically exposes several rear cameras and facingMode:'environment'
  // picks one arbitrarily. Landing on the ultra-wide (usually fixed focus,
  // sharp only past ~30cm) or the telephoto (minimum focus often 50cm+) means a
  // barcode held at arm's length can never come into focus, while a large one
  // across the room is perfectly sharp. Hence: pick the lens, and remember it.
  getPreferredCameraId() {
    try { return localStorage.getItem('macroScannerCameraId') || null; } catch (e) { return null; }
  }

  setPreferredCameraId(id) {
    try { localStorage.setItem('macroScannerCameraId', id); } catch (e) { /* private mode */ }
  }

  getSavedZoom() {
    try {
      const v = parseFloat(localStorage.getItem('macroScannerZoom'));
      return isNaN(v) ? null : v;
    } catch (e) { return null; }
  }

  setSavedZoom(v) {
    try { localStorage.setItem('macroScannerZoom', String(v)); } catch (e) { /* private mode */ }
  }

  // Stops the tracks without touching the modal or the scan loop, so the stream
  // can be swapped for a different camera mid-scan.
  releaseStream() {
    if (this.scanStream) {
      this.scanStream.getTracks().forEach(t => t.stop());
      this.scanStream = null;
    }
  }

  async startCameraStream(deviceId) {
    const base = {
      // 1080p so the preview downscales instead of upscaling. Anything less
      // gets stretched across a high-DPI phone screen and looks soft.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      // Hand over the camera's native mode rather than software-rescaling to
      // hit our numbers - that rescaler is itself a source of softness.
      resizeMode: 'none',
      // In `advanced` so an unsupported focusMode is ignored rather than
      // failing the whole request.
      advanced: [{ focusMode: 'continuous' }]
    };

    this.releaseStream();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { ...base, deviceId: { exact: deviceId } }
          : { ...base, facingMode: { ideal: 'environment' } }
      });
    } catch (e) {
      if (!deviceId) throw e;
      // A remembered camera can disappear between sessions - fall back rather
      // than leaving the scanner dead.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...base, facingMode: { ideal: 'environment' } }
      });
    }

    this.scanStream = stream;
    const video = document.getElementById('barcode-video');
    if (!video) {
      this.stopBarcodeCamera();
      return;
    }
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};

    const torchBtn = document.getElementById('barcode-torch-btn');
    if (torchBtn) torchBtn.style.display = (caps && 'torch' in caps) ? '' : 'none';
    this.torchOn = false;
    this.syncTorchButton();

    // Some devices only honour focusMode once the stream is already running.
    if (track && track.applyConstraints) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }

    this.applyVideoAspectRatio(video);
    this.setupZoomControl(track);
    await this.refreshCameraList();
    this.showCameraDiagnostics(track, video);
  }

  async refreshCameraList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      // Labels are only populated once permission has been granted, which by
      // this point it has. Fall back to every camera if none say "back".
      const back = cams.filter(d => /back|rear|environment/i.test(d.label || ''));
      this.cameraDevices = back.length > 0 ? back : cams;
    } catch (e) {
      this.cameraDevices = [];
    }
    const btn = document.getElementById('barcode-switch-cam-btn');
    if (btn) btn.style.display = (this.cameraDevices.length > 1) ? '' : 'none';
  }

  async switchCamera() {
    if (!this.cameraDevices || this.cameraDevices.length < 2) return;
    const track = this.scanStream && this.scanStream.getVideoTracks()[0];
    const currentId = track && track.getSettings ? track.getSettings().deviceId : null;
    let idx = this.cameraDevices.findIndex(d => d.deviceId === currentId);
    idx = (idx + 1) % this.cameraDevices.length;
    const next = this.cameraDevices[idx];

    try {
      await this.startCameraStream(next.deviceId);
      this.setPreferredCameraId(next.deviceId);
      this.showToast(`Camera ${idx + 1} of ${this.cameraDevices.length}`, 'success');
    } catch (e) {
      this.showToast('Could not switch camera', 'error');
      return;
    }
    // A new lens needs its own settling time, and any part-confirmed read from
    // the previous one is meaningless now.
    this.scanCandidate = null;
    this.scanCandidateCount = 0;
    this.scanStartedAt = performance.now();
    this.lastDetectAt = 0;
    this.markViewfinder('reading', false);
    const statusEl = document.getElementById('barcode-scan-status');
    if (statusEl) statusEl.textContent = 'Line the barcode up inside the box';
  }

  // Zoom is the escape hatch when a lens simply cannot focus close: stand
  // further back, where it can, and zoom until the barcode fills the box.
  setupZoomControl(track) {
    const row = document.getElementById('barcode-zoom-row');
    const slider = document.getElementById('barcode-zoom-slider');
    const caps = (track && track.getCapabilities) ? track.getCapabilities() : {};
    if (!row || !slider || !caps || !caps.zoom) {
      if (row) row.style.display = 'none';
      return;
    }
    row.style.display = '';
    slider.min = caps.zoom.min;
    slider.max = caps.zoom.max;
    slider.step = caps.zoom.step || 0.1;

    const saved = this.getSavedZoom();
    const settings = track.getSettings ? track.getSettings() : {};
    const start = (saved !== null && saved >= caps.zoom.min && saved <= caps.zoom.max)
      ? saved
      : (settings.zoom || caps.zoom.min);
    slider.value = start;
    this.applyZoom(start);
  }

  applyZoom(value) {
    const track = this.scanStream && this.scanStream.getVideoTracks()[0];
    const v = parseFloat(value);
    if (isNaN(v)) return;
    const out = document.getElementById('barcode-zoom-value');
    if (out) out.textContent = `${v.toFixed(1)}×`;
    if (!track || !track.applyConstraints) return;
    track.applyConstraints({ advanced: [{ zoom: v }] })
      .then(() => this.setSavedZoom(v))
      .catch(() => {});
  }

  // Tap the preview to aim autofocus at the barcode rather than whatever the
  // camera decided was the subject.
  async focusAtPoint(ev) {
    const track = this.scanStream && this.scanStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities || !track.applyConstraints) return;
    const caps = track.getCapabilities() || {};
    const video = document.getElementById('barcode-video');
    if (!video) return;

    const r = video.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));

    const advanced = [];
    if (caps.pointsOfInterest) advanced.push({ pointsOfInterest: [{ x, y }] });
    const modes = caps.focusMode || [];
    if (modes.includes && modes.includes('single-shot')) advanced.push({ focusMode: 'single-shot' });
    if (advanced.length === 0) return;

    try {
      await track.applyConstraints({ advanced });
      this.showToast('Refocusing...', 'success');
      // Hand control back once it has had a chance to lock.
      setTimeout(() => {
        if (modes.includes && modes.includes('continuous')) {
          track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }
      }, 1500);
    } catch (e) {
      return;
    }
    this.scanCandidate = null;
    this.scanCandidateCount = 0;
    this.scanStartedAt = performance.now();
    this.markViewfinder('reading', false);
  }

  // Sizes the preview box to the actual stream. Without this the box is fixed
  // at 4:3 while the camera sends 16:9, so object-fit discards a quarter of the
  // frame width and stretches the rest - which is what made the preview soft.
  // Matching the two also makes the reticle correspond 1:1 to the decoded crop.
  applyVideoAspectRatio(video) {
    const wrap = document.querySelector('.barcode-video-wrap');
    if (!wrap) return;
    const apply = () => {
      if (video.videoWidth && video.videoHeight) {
        wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      }
    };
    apply();
    // videoWidth is often still 0 immediately after play() resolves.
    video.addEventListener('loadedmetadata', apply, { once: true });
  }

  showCameraDiagnostics(track, video) {
    const el = document.getElementById('barcode-camera-info');
    if (!el) return;
    const update = () => {
      const s = track && track.getSettings ? track.getSettings() : {};
      const caps = (track && track.getCapabilities) ? track.getCapabilities() : {};
      const w = s.width || video.videoWidth || 0;
      const h = s.height || video.videoHeight || 0;

      const parts = [];
      if (w && h) parts.push(`${w}×${h}`);
      parts.push(s.focusMode ? `${s.focusMode} focus` : 'focus n/a');

      // Which of the phone's lenses are we actually on? This is the number that
      // matters when it will not focus close up.
      const list = this.cameraDevices || [];
      if (list.length > 1) {
        const idx = list.findIndex(d => d.deviceId === s.deviceId);
        parts.push(`cam ${idx >= 0 ? idx + 1 : '?'}/${list.length}`);
      }
      if (caps && caps.zoom) parts.push(`zoom ${caps.zoom.min}-${caps.zoom.max}`);

      el.textContent = parts.join(' · ');
    };
    update();
    video.addEventListener('loadedmetadata', update, { once: true });
  }

  // Crops the reticle region out of the video so only what the user has framed
  // is decoded. Without this the reticle is decorative and a barcode elsewhere
  // in shot can win the race.
  getReticleFrame(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // MUST stay in step with the .barcode-reticle box in styles.css (84% wide,
    // 28% tall). Changing one without the other silently makes the on-screen
    // box stop matching the region actually decoded.
    const cropW = Math.round(vw * 0.84);
    const cropH = Math.round(vh * 0.28);
    const cropX = Math.round((vw - cropW) / 2);
    const cropY = Math.round((vh - cropH) / 2);

    if (!this.scanCanvas) this.scanCanvas = document.createElement('canvas');
    this.scanCanvas.width = cropW;
    this.scanCanvas.height = cropH;
    // No willReadFrequently here: we never read pixels back, we hand the canvas
    // straight to detect(). That hint would force a slower CPU-backed canvas.
    const ctx = this.scanCanvas.getContext('2d');
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    return this.scanCanvas;
  }

  runScanLoop() {
    const video = document.getElementById('barcode-video');
    if (!this.scanActive || !video || !this.barcodeDetector) return;

    const WARMUP_MS = 700;      // let autofocus settle before trusting anything
    const DETECT_EVERY_MS = 120; // decoding every frame just feeds it motion blur
    const CONFIRMATIONS = 3;     // identical reads required before accepting

    const statusEl = document.getElementById('barcode-scan-status');

    const tick = async () => {
      if (!this.scanActive) return;

      const now = performance.now();
      const warmedUp = (now - this.scanStartedAt) >= WARMUP_MS;
      const due = (now - this.lastDetectAt) >= DETECT_EVERY_MS;

      if (warmedUp && due && video.readyState >= 2) {
        this.lastDetectAt = now;
        try {
          const target = this.getReticleFrame(video) || video;
          const codes = await this.barcodeDetector.detect(target);
          const hit = codes && codes.length > 0 ? codes[0] : null;
          const value = hit ? (hit.rawValue || '').trim() : '';

          if (value && this.isValidBarcodeChecksum(value, hit.format)) {
            if (value === this.scanCandidate) {
              this.scanCandidateCount++;
            } else {
              this.scanCandidate = value;
              this.scanCandidateCount = 1;
            }

            if (statusEl) {
              statusEl.textContent = `Reading ${value} ${'.'.repeat(this.scanCandidateCount)}`;
            }
            this.markViewfinder('reading', true);

            if (this.scanCandidateCount >= CONFIRMATIONS) {
              this.scanActive = false;
              this.closeBarcodeScanner();
              this.lookupBarcode(value);
              return;
            }
          } else if (value) {
            // Decoded something, but the check digit says it is garbage.
            this.scanCandidate = null;
            this.scanCandidateCount = 0;
            this.markViewfinder('reading', false);
          }
        } catch (e) {
          // A frame that fails to decode is the normal case between reads.
        }
      }
      this.scanRafId = requestAnimationFrame(tick);
    };
    this.scanRafId = requestAnimationFrame(tick);
  }

  toggleScannerTorch() {
    if (!this.scanStream) return;
    const track = this.scanStream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    this.torchOn = !this.torchOn;
    this.syncTorchButton();
    track.applyConstraints({ advanced: [{ torch: this.torchOn }] }).catch(() => {
      this.torchOn = false;
      this.syncTorchButton();
      this.showToast('Torch is not available on this camera', 'error');
    });
  }

  // Tears the camera down without touching the modal. closeModal and
  // closeAllModals both call this, so the camera stops no matter how the dialog
  // is dismissed - X button, backdrop click, or a completed scan.
  stopBarcodeCamera() {
    this.scanActive = false;
    if (this.scanRafId) {
      cancelAnimationFrame(this.scanRafId);
      this.scanRafId = null;
    }
    if (this.scanStream) {
      this.scanStream.getTracks().forEach(t => t.stop());
      this.scanStream = null;
    }
    const video = document.getElementById('barcode-video');
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    // Drop back to the placeholder shape so a reopen does not briefly show the
    // previous stream's dimensions.
    const wrap = document.querySelector('.barcode-video-wrap');
    if (wrap) wrap.style.aspectRatio = '';
    const info = document.getElementById('barcode-camera-info');
    if (info) info.textContent = '';
    this.torchOn = false;
    this.syncTorchButton();
    this.markViewfinder('reading', false);
  }

  closeBarcodeScanner() {
    this.stopBarcodeCamera();
    this.closeModal('barcode-scanner-modal');
  }

  handleManualBarcodeSubmit() {
    const input = document.getElementById('manual-barcode-input');
    const code = (input ? input.value : '').replace(/\D/g, '');
    if (!code) {
      this.showToast('Enter the digits printed under the barcode', 'error');
      return;
    }
    this.closeBarcodeScanner();
    this.lookupBarcode(code);
  }

  async lookupBarcode(code) {
    // Anything already saved against this barcode wins: instant, and it works
    // offline. This is what makes a one-time manual entry pay off forever.
    const local = store.foods.find(f => f.barcode && f.barcode === code);
    if (local) {
      if (this.scanPurpose === 'database') {
        // Nothing to add - open the saved food so it can be checked or fixed.
        this.showToast(`"${local.Item}" is already in your foods`, 'success');
        this.openEditFoodModal(local.id);
        return;
      }
      this.showBarcodeResult({ ...local, source: 'db', barcode: code });
      return;
    }

    this.showToast('Looking up barcode...', 'success');

    let product = null;
    try {
      const fields = 'product_name,product_name_en,generic_name,brands,quantity,serving_size,nutriments,image_front_small_url';
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.status === 1 && data.product) {
          product = this.mapOffProductToFood({ ...data.product, code });
        }
      }
    } catch (e) {
      console.warn('Barcode lookup failed:', e);
    }

    if (product) {
      if (this.scanPurpose === 'database') {
        // Straight into the save form with everything the pack gave us, ready
        // to check and save.
        this.openSaveFoodToDbModal(null, product.Item || '', product, product.barcode || code);
        return;
      }
      this.showBarcodeResult(product);
      return;
    }

    // Either a genuinely unknown product or a misread. Show the digits so the
    // two can be told apart, rather than silently assuming it needs adding.
    this.showBarcodeNotFound(code);
  }

  showBarcodeNotFound(code) {
    this.notFoundBarcode = code;
    const codeEl = document.getElementById('barcode-notfound-code');
    if (codeEl) codeEl.textContent = code;
    this.openModal('barcode-notfound-modal');
  }

  retryBarcodeScan() {
    this.closeModal('barcode-notfound-modal');
    this.openBarcodeScanner(this.scanTargetRowId, this.scanPurpose);
  }

  addNotFoundBarcodeManually() {
    const code = this.notFoundBarcode || '';
    this.closeModal('barcode-notfound-modal');
    this.openSaveFoodToDbModal(this.scanTargetRowId, '', null, code);
  }

  showBarcodeResult(food) {
    this.pendingScannedFood = food;
    const body = document.getElementById('barcode-result-body');
    if (!body) return;

    const isLocal = food.source === 'db';
    const name = food.Item || food.name || 'Food item';
    const img = food.imageUrl
      ? `<img class="barcode-result-img" src="${this.escapeHTML(food.imageUrl)}" alt="">`
      : '<div class="barcode-result-img placeholder"></div>';
    const brand = food.brand
      ? `<div class="barcode-result-brand">${this.escapeHTML(food.brand)}</div>`
      : '';
    const serving = food.servingSize
      ? `<div class="barcode-result-serving">Serving on pack: ${this.escapeHTML(food.servingSize)}</div>`
      : '';

    body.innerHTML = `
      <div class="barcode-result-head">
        ${img}
        <div class="barcode-result-titles">
          <div class="barcode-result-name">${this.escapeHTML(name)}</div>
          ${brand}
          <span class="source-badge ${isLocal ? 'db' : 'openfood'}">${isLocal ? 'My DB' : 'OpenFood'}</span>
        </div>
      </div>
      <div class="autocomplete-macro-pills barcode-result-pills">
        <span class="macro-pill kcal">${food.Kcal} kcal</span>
        <span class="macro-pill prot">P: ${food.Protein}g</span>
        <span class="macro-pill carb">C: ${food.Carb}g</span>
        <span class="macro-pill fat">F: ${food.Fat}g</span>
        <span class="macro-per-qty">(${formatBasis(food.Quantity || unitInfo(unitOfEntry(food)).base, unitOfEntry(food))})</span>
      </div>
      ${serving}
      <div class="barcode-result-code">Barcode: ${this.escapeHTML(food.barcode || '')}</div>
    `;

    const saveBtn = document.getElementById('barcode-save-db-btn');
    if (saveBtn) saveBtn.style.display = isLocal ? 'none' : '';
    this.openModal('barcode-result-modal');
  }

  addScannedFoodToBuilder() {
    const food = this.pendingScannedFood;
    if (!food) return;
    let rowId = this.scanTargetRowId;
    if (!rowId || !this.builderRows.find(r => r.id === rowId)) {
      this.addNewBuilderRow();
      rowId = this.builderRows[this.builderRows.length - 1].id;
      this.renderBuilderRows();
    }
    this.closeModal('barcode-result-modal');
    // Reuses the existing dropdown-selection path: sets the base macros, zeroes
    // the quantity and focuses the QTY box ready for the weight to be typed.
    this.selectFoodForRow(rowId, food);
  }

  saveScannedFoodToDb() {
    const food = this.pendingScannedFood;
    if (!food) return;
    this.closeModal('barcode-result-modal');
    this.openSaveFoodToDbModal(this.scanTargetRowId, food.Item || '', food, food.barcode || '');
  }

  addCustomToRowOnly(rowId, customName) {
    const row = this.builderRows.find(r => r.id === rowId);
    if (!row) return;
    row.name = customName;
    row.unit = 'g';
    row.baseQty = 100;
    row.baseKcal = 0;
    row.baseProt = 0;
    row.baseCarb = 0;
    row.baseFat = 0;
    row.qty = 0;
    row.kcal = 0;
    row.prot = 0;
    row.carb = 0;
    row.fat = 0;
    this.closeRowDropdown(rowId);
    this.renderBuilderRows();
    setTimeout(() => {
      const qtyInput = document.getElementById(`input-qty-${rowId}`);
      if (qtyInput) {
        qtyInput.focus();
        qtyInput.select();
      }
    }, 50);
    this.showToast(`Added "${customName}"`, 'success');
  }

  // Save a specific search result into the personal database, macros and all.
  // Previously the only route was the dropdown footer, which knew the typed
  // text but not which food was meant - so every field had to be retyped.
  saveSearchResultToDb(rowId, food) {
    if (!food) return;
    this.openSaveFoodToDbModal(
      rowId,
      food.Item || food.name || '',
      food,
      food.barcode || ''
    );
  }

  // The dropdown footer's save action. If the row already holds a food picked
  // from a search result, carry its macros over instead of opening a blank form.
  openSaveFoodFromRow(rowId, defaultName) {
    const row = this.builderRows.find(r => r.id === rowId);
    const hasMacros = row && (row.baseKcal > 0 || row.baseProt > 0 || row.baseCarb > 0 || row.baseFat > 0);
    const prefill = hasMacros ? {
      Quantity: row.baseQty,
      Unit: unitOfEntry(row),
      Kcal: row.baseKcal,
      Protein: row.baseProt,
      Carb: row.baseCarb,
      Fat: row.baseFat
    } : null;
    this.openSaveFoodToDbModal(rowId, (hasMacros && row.name) ? row.name : defaultName, prefill, '');
  }

  // prefill and barcode are only passed by the barcode scanner. Existing
  // callers pass neither and get the same blank form as before.
  openSaveFoodToDbModal(rowId, defaultName, prefill = null, barcode = '') {
    // Clear the edit id, or an add started right after an edit would silently
    // overwrite the food that was last edited.
    this.setFoodDialogMode(null);
    const rowIdInput = document.getElementById('save-food-row-id');
    const barcodeInput = document.getElementById('save-food-barcode');
    const nameInput = document.getElementById('save-food-name-input');
    const qtyInput = document.getElementById('save-food-base-qty-input');
    const kcalInput = document.getElementById('save-food-kcal-input');
    const protInput = document.getElementById('save-food-prot-input');
    const carbInput = document.getElementById('save-food-carb-input');
    const fatInput = document.getElementById('save-food-fat-input');
    const hint = document.getElementById('save-food-barcode-hint');

    const val = (key) => (prefill && prefill[key] !== undefined && prefill[key] !== null) ? prefill[key] : '';

    if (rowIdInput) rowIdInput.value = rowId || '';
    if (barcodeInput) barcodeInput.value = barcode || '';
    if (nameInput) nameInput.value = defaultName || '';
    const unit = prefill ? unitOfEntry(prefill) : 'g';
    this.setFoodUnitField(unit);
    if (qtyInput) qtyInput.value = val('Quantity') || String(unitInfo(unit).base);
    this.refreshServingHint();
    if (kcalInput) kcalInput.value = val('Kcal');
    if (protInput) protInput.value = val('Protein');
    if (carbInput) carbInput.value = val('Carb');
    if (fatInput) fatInput.value = val('Fat');

    if (hint) {
      hint.textContent = barcode ? `Saving against barcode ${barcode} - future scans will find it instantly.` : '';
      hint.style.display = barcode ? '' : 'none';
    }

    // Opened from the Foods page there is no builder row to "use" it in.
    const submitBtn = document.getElementById('save-food-submit-btn');
    if (submitBtn && !rowId) submitBtn.textContent = 'Save food';

    if (rowId) this.closeRowDropdown(rowId);
    this.openModal('save-food-db-modal');
  }

  // The food dialog's serving type. The options are built from FOOD_UNITS the
  // first time, so the list lives in one place.
  setFoodUnitField(unit) {
    const select = document.getElementById('save-food-unit-select');
    if (!select) return;
    if (!select.options.length) {
      select.innerHTML = FOOD_UNITS
        .map(u => `<option value="${u.id}">${this.escapeHTML(u.name)}</option>`)
        .join('');
    }
    select.value = unitInfo(unit).id;
    select.dataset.prev = select.value;
  }

  // Switching to a unit with a different usual serving moves the serving
  // size along - 100 g becomes 1 slice - unless it was changed by hand.
  handleFoodUnitChange(unit) {
    const select = document.getElementById('save-food-unit-select');
    const qtyInput = document.getElementById('save-food-base-qty-input');
    const prev = unitInfo(select ? select.dataset.prev : 'g');
    const next = unitInfo(unit);
    if (qtyInput) {
      const current = parseFloat(qtyInput.value);
      if (!qtyInput.value || current === prev.base) qtyInput.value = String(next.base);
    }
    if (select) select.dataset.prev = next.id;
    this.refreshServingHint();
  }

  refreshServingHint() {
    const hint = document.getElementById('save-food-serving-hint');
    const select = document.getElementById('save-food-unit-select');
    const qtyInput = document.getElementById('save-food-base-qty-input');
    if (!hint) return;
    const unit = select ? select.value : 'g';
    const qty = parseFloat(qtyInput ? qtyInput.value : '') || unitInfo(unit).base;
    hint.textContent = `The kcal and macros below are ${formatBasis(qty, unit)}.`;
  }

  // One dialog, two jobs. Passing a food id switches it to editing that food.
  setFoodDialogMode(editId) {
    const editIdInput = document.getElementById('save-food-edit-id');
    const title = document.getElementById('save-food-modal-title');
    const submitBtn = document.getElementById('save-food-submit-btn');
    if (editIdInput) editIdInput.value = editId || '';
    if (title) title.textContent = editId ? 'Edit food' : 'New food';
    if (submitBtn) submitBtn.textContent = editId ? 'Save changes' : 'Save & add to meal';
  }

  openEditFoodModal(foodId) {
    const food = store.foods.find(f => f.id === foodId);
    if (!food) return;
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val === undefined || val === null ? '' : val;
    };
    set('save-food-row-id', '');
    set('save-food-barcode', food.barcode || '');
    set('save-food-name-input', food.Item || '');
    this.setFoodUnitField(unitOfEntry(food));
    set('save-food-base-qty-input', food.Quantity || unitInfo(unitOfEntry(food)).base);
    this.refreshServingHint();
    set('save-food-kcal-input', food.Kcal || 0);
    set('save-food-prot-input', food.Protein || 0);
    set('save-food-carb-input', food.Carb || 0);
    set('save-food-fat-input', food.Fat || 0);
    const hint = document.getElementById('save-food-barcode-hint');
    if (hint) {
      hint.textContent = food.barcode ? `Scanning barcode ${food.barcode} will find this food.` : '';
      hint.style.display = food.barcode ? '' : 'none';
    }
    this.setFoodDialogMode(foodId);
    this.openModal('save-food-db-modal');
  }

  async handleSaveFoodToDbSubmit() {
    const editIdEl = document.getElementById('save-food-edit-id');
    const editId = editIdEl ? editIdEl.value.trim() : '';
    const rowId = document.getElementById('save-food-row-id').value;
    const barcodeEl = document.getElementById('save-food-barcode');
    const barcode = barcodeEl ? barcodeEl.value.trim() : '';
    const name = document.getElementById('save-food-name-input').value.trim();
    const unitSelect = document.getElementById('save-food-unit-select');
    const unit = unitOfEntry({ Unit: unitSelect ? unitSelect.value : 'g' });
    const baseQty = parseFloat(document.getElementById('save-food-base-qty-input').value) || unitInfo(unit).base;
    const kcal = parseFloat(document.getElementById('save-food-kcal-input').value) || 0;
    const prot = parseFloat(document.getElementById('save-food-prot-input').value) || 0;
    const carb = parseFloat(document.getElementById('save-food-carb-input').value) || 0;
    const fat = parseFloat(document.getElementById('save-food-fat-input').value) || 0;

    if (!name) {
      this.showToast('Please provide a food name', 'error');
      return;
    }

    const newFoodObj = {
      Item: name,
      Quantity: baseQty,
      Unit: unit,
      Kcal: kcal,
      Protein: prot,
      Carb: carb,
      Fat: fat,
      source: 'db'
    };
    if (barcode) newFoodObj.barcode = barcode;

    if (editId) {
      const res = await store.updateFoodInDatabase(editId, {
        Item: name,
        Quantity: baseQty,
        Unit: unit,
        Kcal: kcal,
        Protein: prot,
        Carb: carb,
        Fat: fat
      });
      this.closeModal('save-food-db-modal');
      this.renderFoodsList();
      if (res && res.success === false) {
        this.showToast(`Could not save "${name}": ${res.error}`, 'error');
      } else {
        this.showToast(`Updated "${name}"`, 'success');
      }
      return;
    }

    const res = await store.addFoodToDatabase(newFoodObj);
    if (rowId) {
      this.selectFoodForRow(rowId, newFoodObj);
    }
    this.closeModal('save-food-db-modal');
    this.renderFoodsList();
    if (res && res.duplicate) {
      this.showToast(`"${name}" is already in your food list`, 'error');
    } else {
      this.showToast(`Saved "${name}" to your Food List!`, 'success');
    }
  }

  // Shuts a row's dropdown for good. Removing the class alone was not enough:
  // a debounced search already in flight would resolve a moment later and
  // re-open it, which is why the list stayed up after tapping a food.
  closeRowDropdown(rowId) {
    if (this.searchDebounceTimers[rowId]) {
      clearTimeout(this.searchDebounceTimers[rowId]);
      delete this.searchDebounceTimers[rowId];
    }
    // Invalidates any request still awaiting a response.
    this.searchRequestCounters[rowId] = (this.searchRequestCounters[rowId] || 0) + 1;
    delete this.searchState[rowId];
    const dropdown = document.getElementById(`dropdown-${rowId}`);
    if (dropdown) {
      dropdown.classList.remove('open');
      dropdown.innerHTML = '';
    }
  }

  selectFoodForRow(rowId, food) {
    const row = this.builderRows.find(r => r.id === rowId);
    if (!row) return;
    // A new food invalidates any hand-typed macros from the previous one.
    row.overrides = {};
    row.name = food.Item || food.name;
    row.unit = unitOfEntry(food);
    row.baseQty = food.Quantity || food.quantity || unitInfo(row.unit).base;
    row.baseKcal = food.Kcal !== undefined ? food.Kcal : (food.kcal || 0);
    row.baseProt = food.Protein !== undefined ? food.Protein : (food.protein || 0);
    row.baseCarb = food.Carb !== undefined ? food.Carb : (food.carb || food.carbs || 0);
    row.baseFat = food.Fat !== undefined ? food.Fat : (food.fat || 0);
    
    // Counted in slices or scoops, it starts at one serving - selected, so
    // typing replaces it. Weighed or measured, the box waits for the amount.
    const startQty = unitInfo(row.unit).count ? row.baseQty : 0;
    const ratio = startQty > 0 && row.baseQty > 0 ? startQty / row.baseQty : 0;
    row.qty = startQty;
    row.kcal = Math.round(row.baseKcal * ratio);
    row.prot = Math.round(row.baseProt * ratio * 10) / 10;
    row.carb = Math.round(row.baseCarb * ratio * 10) / 10;
    row.fat = Math.round(row.baseFat * ratio * 10) / 10;

    this.closeRowDropdown(rowId);
    this.renderBuilderRows();
    setTimeout(() => {
      const qtyInput = document.getElementById(`input-qty-${rowId}`);
      if (qtyInput) {
        qtyInput.focus();
        qtyInput.select();
      }
    }, 50);
  }

  updateRowQty(rowId, qtyStr) {
    const row = this.builderRows.find(r => r.id === rowId);
    if (!row) return;
    const numQty = parseFloat(qtyStr) || 0;
    row.qty = numQty;
    const ratio = numQty > 0 && row.baseQty > 0 ? (numQty / row.baseQty) : 0;

    // A macro the user has typed by hand stays put - rescaling it would throw
    // away the correction they just made.
    if (!row.overrides.kcal) row.kcal = numQty > 0 ? Math.round(row.baseKcal * ratio) : 0;
    if (!row.overrides.prot) row.prot = numQty > 0 ? Math.round(row.baseProt * ratio * 10) / 10 : 0;
    if (!row.overrides.carb) row.carb = numQty > 0 ? Math.round(row.baseCarb * ratio * 10) / 10 : 0;
    if (!row.overrides.fat) row.fat = numQty > 0 ? Math.round(row.baseFat * ratio * 10) / 10 : 0;

    const set = (key, val) => {
      const el = document.getElementById(`val-${key}-${rowId}`);
      // Never write back into a field being typed in, or the caret jumps.
      if (el && !row.overrides[key] && document.activeElement !== el) el.value = val;
    };
    set('kcal', row.kcal);
    set('prot', row.prot);
    set('carb', row.carb);
    set('fat', row.fat);

    this.updateMealSubtotal();
    this.touchBuilder();
  }

  // Manual macro override. Once a field is typed into, quantity changes stop
  // rescaling it; clearing the field hands control back to the calculation.
  updateRowMacro(rowId, key, value) {
    const row = this.builderRows.find(r => r.id === rowId);
    if (!row) return;
    const raw = (value === null || value === undefined) ? '' : String(value).trim();

    if (raw === '') {
      delete row.overrides[key];
      const ratio = row.qty > 0 && row.baseQty > 0 ? (row.qty / row.baseQty) : 0;
      const base = { kcal: row.baseKcal, prot: row.baseProt, carb: row.baseCarb, fat: row.baseFat }[key];
      row[key] = key === 'kcal' ? Math.round(base * ratio) : Math.round(base * ratio * 10) / 10;
    } else {
      const num = parseFloat(raw);
      if (isNaN(num)) return;
      row.overrides[key] = true;
      row[key] = key === 'kcal' ? Math.round(num) : Math.round(num * 10) / 10;
    }

    const el = document.getElementById(`val-${key}-${rowId}`);
    if (el) el.classList.toggle('overridden', !!row.overrides[key]);
    this.updateMealSubtotal();
    this.touchBuilder();
  }

  // Anything dropped into the builder joins what is already there. The blank
  // row renderBuilderRows() seeds is consumed rather than left stranded above
  // whatever was just added.
  dropEmptyBuilderRows() {
    this.builderRows = this.builderRows.filter(builderRowHasContent);
  }

  removeBuilderRow(rowId) {
    this.builderRows = this.builderRows.filter(r => r.id !== rowId);
    if (this.builderRows.length === 0) {
      this.addNewBuilderRow();
    }
    this.renderBuilderRows();
  }

  updateMealSubtotal() {
    let mealKcal = 0, mealProt = 0, mealCarb = 0, mealFat = 0;
    this.builderRows.forEach(r => {
      mealKcal += r.kcal || 0;
      mealProt += r.prot || 0;
      mealCarb += r.carb || 0;
      mealFat += r.fat || 0;
    });

    mealKcal = Math.round(mealKcal);
    mealProt = Math.round(mealProt * 10) / 10;
    mealCarb = Math.round(mealCarb * 10) / 10;
    mealFat = Math.round(mealFat * 10) / 10;

    const subKcal = document.getElementById('meal-subtotal-val-kcal');
    const subProt = document.getElementById('meal-subtotal-val-prot');
    const subCarb = document.getElementById('meal-subtotal-val-carb');
    const subFat = document.getElementById('meal-subtotal-val-fat');

    if (subKcal) subKcal.textContent = `${mealKcal.toLocaleString()} kcal`;
    if (subProt) subProt.textContent = `P: ${mealProt.toFixed(1)}g`;
    if (subCarb) subCarb.textContent = `C: ${mealCarb.toFixed(1)}g`;
    if (subFat) subFat.textContent = `F: ${mealFat.toFixed(1)}g`;

    // Nothing to add up, nothing to show; and Log meal only once there is a
    // food to log, so it never looks ready when it is not.
    const bar = document.querySelector('.meal-subtotal-bar');
    if (bar) bar.hidden = !(mealKcal || mealProt || mealCarb || mealFat);
    this.refreshLogMealButton();
  }

  refreshLogMealButton() {
    const btn = document.getElementById('log-meal-submit-btn');
    if (!btn) return;
    const ready = this.builderRows.some(r => this.isLoggableRow(r));
    btn.disabled = !ready;
    btn.title = ready ? (this.mealEdit ? 'Save the changes to this meal' : "Add this meal to Today's Log") : 'Add a food and its amount first';
  }

  // A row counts once it has a name and either a quantity or some macros -
  // a food typed by hand with its kcal filled in is as real as a picked one.
  isLoggableRow(r) {
    return !!(r && (r.name || '').trim() &&
      (r.qty > 0 || r.kcal > 0 || r.prot > 0 || r.carb > 0 || r.fat > 0));
  }

  // The builder's rows as logged items, plus their totals.
  builderItemsForLog() {
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    const items = this.builderRows.filter(r => this.isLoggableRow(r)).map(r => {
      totals.kcal += r.kcal || 0;
      totals.protein += r.prot || 0;
      totals.carbs += r.carb || 0;
      totals.fat += r.fat || 0;
      return {
        id: Date.now() + Math.random(),
        name: r.name.trim(),
        qty: r.qty,
        // Only written when it is not grams, so older items and new ones in
        // grams look the same.
        ...(unitOfEntry(r) !== 'g' ? { unit: unitOfEntry(r) } : {}),
        kcal: r.kcal,
        protein: r.prot,
        carbs: r.carb,
        fat: r.fat
      };
    });
    totals.kcal = Math.round(totals.kcal);
    totals.protein = Math.round(totals.protein * 10) / 10;
    totals.carbs = Math.round(totals.carbs * 10) / 10;
    totals.fat = Math.round(totals.fat * 10) / 10;
    return { items, totals };
  }

  async handleLogMeal() {
    // While a logged meal is loaded for editing, the same button saves it.
    if (this.mealEdit) {
      await this.saveMealEdit();
      return;
    }

    const { items, totals: mealTotals } = this.builderItemsForLog();
    if (items.length === 0) {
      this.showToast('Give each food a name and a quantity or its macros', 'error');
      return;
    }

    const mealNumber = store.todayMeals.length + 1;
    const now = new Date();
    const hours = now.getHours();
    const minutes = pad2(now.getMinutes());
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours % 12 || 12;
    const timeStr = `${pad2(h12)}:${minutes} ${ampm}`;
    const mealName = `Meal ${mealNumber} (${timeStr})`;

    const newMeal = {
      id: 'meal-' + Date.now(),
      name: mealName,
      category: 'Meal',
      items: items,
      totals: mealTotals
    };

    this.builderRows = [];
    this.addNewBuilderRow();
    // renderAll() below cannot announce this, so clear the synced draft here
    // or the meal just logged would reappear in the builder on every device.
    this.touchBuilder();

    // Await the cloud write before declaring success, so a failed save shows
    // its own error toast instead of a false "Logged!" confirmation.
    await store.addMealToToday(newMeal);
    this.renderAll();

    this.showToast(`Logged "${mealName}" (${mealTotals.kcal} kcal)!`, 'success');
  }

  // Today's Log holds every meal not yet filed into the history. Today's
  // own come last, under the total in the header; any left over from an
  // earlier day sit above them with a note and one tap to file them away -
  // they already count on their own day, never on today's.
  renderTodaysLogs() {
    const container = document.getElementById('todays-logged-meals-list');
    const todayKey = new Date().toDateString();
    const dayOf = m => mealLoggedDay(m) || todayKey;
    const todays = store.todayMeals.filter(m => dayOf(m) === todayKey);
    const earlier = store.todayMeals.filter(m => dayOf(m) !== todayKey);

    const totalEl = document.getElementById('todays-log-total');
    if (totalEl) {
      totalEl.textContent = `${store.totalsOfMeals(todays).kcal.toLocaleString()} kcal`;
      totalEl.hidden = todays.length === 0;
    }
    const finishBtn = document.getElementById('finish-day-btn');
    if (finishBtn) finishBtn.hidden = todays.length === 0;

    if (!container) return;

    if (store.todayMeals.length === 0) {
      container.innerHTML = `
        <div class="empty-log-box">
          <div class="empty-title">Nothing logged yet today</div>
          <div class="empty-desc">Add foods in the Meal Builder above, then tap Log meal.</div>
        </div>
      `;
      return;
    }

    const groups = new Map();
    earlier.forEach(m => {
      const k = dayOf(m);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    });
    const earlierHTML = [...groups.entries()]
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .map(([k, meals]) => {
        const label = new Date(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        const short = new Date(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        const n = meals.length;
        return `
          <div class="unfiled-notice" role="status">
            <div class="unfiled-notice-text">
              <strong>${n} ${n === 1 ? 'meal' : 'meals'} from ${this.escapeHTML(label)}</strong>
              ${n === 1 ? 'is' : 'are'} still here. ${n === 1 ? 'It counts' : 'They count'} towards that day, not today.
            </div>
            <button type="button" class="unfiled-file-btn" onclick="app.fileEarlierMeals('${this.escapeHTML(k)}')">File under ${this.escapeHTML(short)}</button>
          </div>
          ${meals.map(m => this.todayMealHTML(m)).join('')}
        `;
      }).join('');

    let todayHTML = '';
    if (todays.length) {
      todayHTML = (earlier.length ? '<div class="todays-log-subhead">Today</div>' : '')
        + todays.map(m => this.todayMealHTML(m)).join('');
    } else {
      todayHTML = '<div class="todays-log-subhead">Today</div><div class="todays-log-none">Nothing logged yet today.</div>';
    }
    container.innerHTML = earlierHTML + todayHTML;
  }

  // One meal in Today's Log: its heading (name, time, total) and, opened,
  // its foods - each with its own edit and remove.
  todayMealHTML(m) {
    return `
      <div class="history-meal-group today-meal-group${this.openTodayMeals.has(m.id) ? ' open' : ''}${this.isMealBeingEdited('today', m.id) ? ' being-edited' : ''}" id="today-meal-${m.id}">
        <div class="history-meal-group-title today-meal-title">
          <button type="button" class="today-meal-toggle" onclick="app.toggleTodayMeal('${m.id}')" aria-expanded="${this.openTodayMeals.has(m.id)}">
            ${this.mealHeadingHTML(m.name, m.totals)}
          </button>
          <div class="today-meal-head-actions">
            ${this.mealMenuButtonHTML('today', m.id)}
          </div>
        </div>
        <div class="today-meal-body">
          <div class="today-food-rows">
            ${(m.items || []).map((i, itemIdx) => this.loggedFoodRowHTML(i, `
              <div class="today-food-actions">
                <button type="button" class="pill-icon-btn" title="Edit this food" aria-label="Edit ${this.escapeHTML(i.name || 'this food')}"
                  onclick="app.openEditTodayItemModal('${m.id}', ${itemIdx})">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button type="button" class="pill-icon-btn danger" title="Remove this food" aria-label="Remove ${this.escapeHTML(i.name || 'this food')}"
                  onclick="app.confirmDeleteTodayItem('${m.id}', ${itemIdx})">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>
            `)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // A meal's heading, shared by Today's Log and logged days: the arrow, the
  // name with its time set apart ("Meal 2" · 01:05 PM), the macros under it
  // and the kcal on the right - so a closed meal still says what was in it.
  mealHeadingHTML(name, totals, q = '') {
    const m = /^(.*\S)\s*\((\d{1,2}:\d{2}\s*[AP]M)\)$/i.exec(String(name || ''));
    const main = m ? m[1] : (name || 'Meal');
    const time = m ? m[2] : '';
    const r = v => Math.round(Number(v) || 0);
    const t = totals || null;
    return `
      <span class="today-meal-arrow" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </span>
      <span class="meal-head-text">
        <span class="meal-head-line">
          <span class="history-meal-name-text">${q ? this.highlightQuery(main, q) : this.escapeHTML(main)}</span>
          ${time ? `<span class="meal-time">${this.escapeHTML(time)}</span>` : ''}
        </span>
        ${t ? `<span class="meal-head-macros"><span class="prot">P ${r(t.protein)}g</span><span class="carb">C ${r(t.carbs)}g</span><span class="fat">F ${r(t.fat)}g</span></span>` : ''}
      </span>
      ${t ? `<span class="meal-head-kcal">${r(t.kcal).toLocaleString()} kcal</span>` : ''}
    `;
  }

  // Files the meals left over from an earlier day under that day - joined
  // to whatever is already logged for it.
  async fileEarlierMeals(dayKey) {
    const todayKey = new Date().toDateString();
    const meals = store.todayMeals.filter(m => (mealLoggedDay(m) || todayKey) === dayKey);
    if (!meals.length) return;
    const date = new Date(dayKey);
    const label = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const existing = this.pastLogsByDay().get(dayKey) || [];
    const res = await store.finishAndArchiveDay(toISODateLocal(date), existing.length ? existing[0].id : null, meals);
    this.renderAll();
    if (res && res.success) {
      this.showToast(`Filed ${meals.length} ${meals.length === 1 ? 'meal' : 'meals'} under ${label}`, 'success');
    } else {
      this.showToast(`Could not file those meals: ${(res && res.error) || 'please try again'}`, 'error');
    }
  }

  toggleHistoryMeal(logId, mealIdx) {
    const card = document.getElementById(`hist-meal-${logId}-${mealIdx}`);
    if (!card) return;
    const isOpen = card.classList.toggle('open');
    const key = `${logId}:${mealIdx}`;
    // Remembered so re-opening the day, or a sync repaint, keeps your place.
    if (isOpen) this.openHistoryMeals.add(key);
    else this.openHistoryMeals.delete(key);
  }

  toggleTodayMeal(mealId) {
    const card = document.getElementById(`today-meal-${mealId}`);
    if (!card) return;
    const isOpen = card.classList.toggle('open');
    // Remembered so a background sync repaint does not snap open meals shut.
    if (isOpen) this.openTodayMeals.add(mealId);
    else this.openTodayMeals.delete(mealId);
  }

  // "Quantity (g)", "Quantity (slices)" - an edit dialog's amount, named in
  // the unit the food was logged in.
  setQtyFieldLabel(inputId, unitId) {
    const label = document.querySelector(`label[for="${inputId}"]`);
    const u = unitInfo(unitId);
    if (label) label.textContent = `Quantity (${u.count ? (u.plural || u.label) : u.label})`;
  }

  // Per-food edit inside today's log, mirroring the Past History item editor.
  openEditTodayItemModal(mealId, itemIdx) {
    const meal = store.todayMeals.find(m => m.id === mealId);
    const item = meal && meal.items ? meal.items[itemIdx] : null;
    if (!item) return;
    this.editingTodayItem = { mealId, itemIdx };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('edit-today-item-name', item.name || '');
    set('edit-today-item-qty', item.qty || 0);
    this.setQtyFieldLabel('edit-today-item-qty', unitOfEntry(item));
    set('edit-today-item-kcal', Math.round(item.kcal || 0));
    set('edit-today-item-prot', item.protein ?? 0);
    set('edit-today-item-carb', item.carbs ?? 0);
    set('edit-today-item-fat', item.fat ?? 0);

    // Rescale the macros as the quantity changes, anchored to the values the
    // item had when the dialog opened - same behaviour as the history editor.
    const base = {
      qty: Number(item.qty) || 0,
      kcal: Number(item.kcal) || 0,
      protein: Number(item.protein) || 0,
      carbs: Number(item.carbs) || 0,
      fat: Number(item.fat) || 0
    };
    const qtyInput = document.getElementById('edit-today-item-qty');
    if (qtyInput) {
      qtyInput.oninput = () => {
        const newQty = parseFloat(qtyInput.value);
        if (!base.qty || isNaN(newQty)) return;
        const ratio = newQty / base.qty;
        set('edit-today-item-kcal', Math.round(base.kcal * ratio));
        set('edit-today-item-prot', Math.round(base.protein * ratio * 10) / 10);
        set('edit-today-item-carb', Math.round(base.carbs * ratio * 10) / 10);
        set('edit-today-item-fat', Math.round(base.fat * ratio * 10) / 10);
      };
    }

    this.openModal('edit-today-item-modal');
  }

  async handleSaveEditedTodayItem() {
    const ref = this.editingTodayItem;
    if (!ref) return;
    const meal = store.todayMeals.find(m => m.id === ref.mealId);
    if (!meal || !meal.items[ref.itemIdx]) return;

    const num = (id) => parseFloat(document.getElementById(id).value) || 0;
    const name = document.getElementById('edit-today-item-name').value.trim();
    if (!name) {
      this.showToast('Food name cannot be empty', 'error');
      return;
    }

    // Keys must match what handleLogMeal writes and updateTodayMeal sums:
    // protein/carbs, not prot/carb.
    const items = meal.items.map((it, i) => i !== ref.itemIdx ? it : {
      ...it,
      name,
      qty: num('edit-today-item-qty'),
      kcal: num('edit-today-item-kcal'),
      protein: num('edit-today-item-prot'),
      carbs: num('edit-today-item-carb'),
      fat: num('edit-today-item-fat')
    });

    await store.updateTodayMeal(ref.mealId, meal.name, items);
    this.closeModal('edit-today-item-modal');
    this.renderAll();
    this.showToast('Food updated', 'success');
  }

  confirmDeleteTodayItem(mealId, itemIdx) {
    const meal = store.todayMeals.find(m => m.id === mealId);
    if (!meal) return;
    this.confirmDelete(async () => {
      const items = meal.items.filter((_, i) => i !== itemIdx);
      if (items.length === 0) {
        // Removing the last food removes the meal itself.
        await store.deleteTodayMeal(mealId);
      } else {
        await store.updateTodayMeal(mealId, meal.name, items);
      }
      this.renderAll();
      this.showToast('Food removed', 'success');
    }, 'Remove this food from the meal?');
  }

  confirmDeleteTodayMeal(mealId) {
    this.confirmDelete(async () => {
      this.renderAll();
      await store.deleteTodayMeal(mealId);
      this.renderAll();
      this.showToast('Meal removed from today', 'success');
    }, 'Are you sure you want to delete this meal from today\'s log?');
  }

  openEditTodayMealModal(mealId) {
    const meal = store.todayMeals.find(m => m.id === mealId);
    if (!meal) return;
    document.getElementById('edit-today-meal-id').value = meal.id;
    document.getElementById('edit-today-meal-name').value = meal.name;
    const itemsContainer = document.getElementById('edit-today-meal-items-container');
    itemsContainer.innerHTML = meal.items.map((item, idx) => `
      <div style="background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:8px 10px; display:flex; align-items:center; gap:8px;">
        <input type="text" class="form-input" style="flex:2;" value="${this.escapeHTML(item.name)}" id="edit-item-name-${idx}">
        <div class="qty-with-unit">
          <input type="number" class="form-input" value="${item.qty}" id="edit-item-qty-${idx}" step="any" inputmode="decimal"
                 aria-label="Amount of ${this.escapeHTML(item.name)}, ${this.escapeHTML(unitInfo(unitOfEntry(item)).name.toLowerCase())}">
          <span class="qty-unit">${this.escapeHTML(unitInfo(unitOfEntry(item)).count ? (unitInfo(unitOfEntry(item)).plural || unitInfo(unitOfEntry(item)).label) : unitInfo(unitOfEntry(item)).label)}</span>
        </div>
      </div>
    `).join('');
    this.openModal('edit-today-meal-modal');
  }

  async handleSaveEditedTodayMeal() {
    const mealId = document.getElementById('edit-today-meal-id').value;
    const mealName = document.getElementById('edit-today-meal-name').value.trim();
    const meal = store.todayMeals.find(m => m.id === mealId);
    if (!meal) return;
    const newItems = meal.items.map((item, idx) => {
      const nameInput = document.getElementById(`edit-item-name-${idx}`);
      const qtyInput = document.getElementById(`edit-item-qty-${idx}`);
      const newQty = parseFloat(qtyInput ? qtyInput.value : item.qty) || item.qty;
      const ratio = item.qty > 0 ? (newQty / item.qty) : 1;
      return {
        ...item,
        name: nameInput ? nameInput.value.trim() : item.name,
        qty: newQty,
        kcal: Math.round(item.kcal * ratio),
        protein: Math.round(item.protein * ratio * 10) / 10,
        carbs: Math.round(item.carbs * ratio * 10) / 10,
        fat: Math.round(item.fat * ratio * 10) / 10
      };
    });
    this.closeModal('edit-today-meal-modal');
    this.renderAll();
    await store.updateTodayMeal(mealId, mealName, newItems);
    this.renderAll();
    this.showToast('Meal updated successfully!', 'success');
  }

  // Today's own meals - any left over from an earlier day have their own
  // "File under" button, so they are not swept into today by this.
  mealsLoggedToday() {
    const todayKey = new Date().toDateString();
    return store.todayMeals.filter(m => (mealLoggedDay(m) || todayKey) === todayKey);
  }

  openLogDayModal() {
    const meals = this.mealsLoggedToday();
    if (meals.length === 0) {
      this.showToast('Nothing logged today yet', 'error');
      return;
    }
    const totals = store.totalsOfMeals(meals);
    const datePicker = document.getElementById('log-day-date-picker');
    if (datePicker) {
      datePicker.value = toISODateLocal(new Date());
    }
    const totalsEl = document.getElementById('log-day-modal-totals');
    if (totalsEl) {
      totalsEl.innerHTML = `<span class="kcal">${totals.kcal.toLocaleString()} kcal</span>`
        + `<span class="prot">P ${totals.protein}g</span><span class="carb">C ${totals.carbs}g</span><span class="fat">F ${totals.fat}g</span>`;
    }
    const summaryEl = document.getElementById('log-day-modal-meals-summary');
    if (summaryEl) {
      const names = meals.map(m => (m.name || 'Meal').replace(/\s*\((\d{1,2}:\d{2}\s*[AP]M)\)$/i, ' at $1'));
      summaryEl.textContent = `${meals.length} ${meals.length === 1 ? 'meal' : 'meals'}: ${names.join(', ')}`;
    }
    this.openModal('log-day-modal');
  }

  async handleLogDaySubmit() {
    const datePicker = document.getElementById('log-day-date-picker');
    const chosenDate = datePicker ? datePicker.value : null;

    let targetDateFormatted = formatDateDMY(new Date());
    if (chosenDate) {
      const parts = chosenDate.split('-');
      if (parts.length === 3) {
        const dObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        targetDateFormatted = formatDateDMY(dObj);
      }
    }

    // A day already in the history takes these meals in alongside its own.
    // Separate logs for one date are merged on the next sync anyway, so
    // asking first only ever offered a choice that did not stick.
    const existingLog = store.pastLogs.find(l => {
      const logDateStr = (l['Log Session'] || '').split(' - ')[0].trim();
      return logDateStr === targetDateFormatted;
    });

    const result = await store.finishAndArchiveDay(chosenDate, existingLog ? existingLog.id : null, this.mealsLoggedToday());

    if (result && result.success) {
      this.closeModal('log-day-modal');
      this.renderAll();
      const n = result.count || 0;
      this.showToast(`Day finished - ${n} ${n === 1 ? 'meal' : 'meals'} moved to your history`, 'success');
    } else {
      this.showToast(`Could not finish the day: ${result?.error || 'please try again'}`, 'error');
    }
  }

  renderHistoryList() {
    const container = document.getElementById('past-history-logs-container');
    if (!container) return;

    if (store.pastLogs.length === 0) {
      const summaryEl = document.getElementById('history-search-summary');
      if (summaryEl) summaryEl.style.display = 'none';
      container.innerHTML = `
        <div class="empty-log-box">
          <div class="empty-title">No logged days yet</div>
          <div class="empty-desc">Days you finish show up here, newest first.</div>
        </div>
      `;
      return;
    }

    // Sort strictly newest first
    const sortedLogs = [...store.pastLogs].sort((a, b) => {
      const dateA = parseAnyDate(a['Log Session'] || '');
      const dateB = parseAnyDate(b['Log Session'] || '');
      return dateB.getTime() - dateA.getTime();
    });

    const q = this.historyQuery();
    const matchingLogs = q
      ? sortedLogs.filter(l => this.historySearchIndex(l).includes(q))
      : sortedLogs;

    // The summary sits outside the list so it survives an empty result.
    const summaryEl = document.getElementById('history-search-summary');
    const clearBtn = document.getElementById('history-search-clear');
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
    if (summaryEl) {
      summaryEl.style.display = q ? 'block' : 'none';
      if (q) {
        const verb = matchingLogs.length === 1 ? 'day contains' : 'days contain';
        summaryEl.textContent = matchingLogs.length === 0
          ? `No logged day contains "${this.historySearchQuery.trim()}"`
          : `${matchingLogs.length} of ${sortedLogs.length} ${verb} "${this.historySearchQuery.trim()}"`;
      }
    }

    if (matchingLogs.length === 0) {
      container.innerHTML = `
        <div class="empty-log-box">
          <div class="empty-title">No matching days</div>
          <div class="empty-desc">Nothing in your history matches that. Try part of a food name, like &quot;chick&quot;.</div>
        </div>
      `;
      return;
    }

    const visibleLogs = matchingLogs.slice(0, this.historyVisibleCount);
    const moreHTML = this.listPagerHTML('showMoreHistory', visibleLogs.length, matchingLogs.length);

    container.innerHTML = visibleLogs.map(log => {
      // "Tue 6 October 2026": the day, as everywhere else in the app.
      const logDate = parseAnyDate(log['Log Session']);
      const formattedSession = isNaN(logDate.getTime())
        ? formatDateTimeDMY(log['Log Session'])
        : logDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
      // A day that matched opens itself - the point of the search is to see
      // the food, not to be handed a closed card that contains it.
      const openClass = (q || this.openHistoryCards.has(log.id)) ? ' open' : '';
      return `
        <div class="history-session-card${openClass}" id="history-card-${log.id}">
          <button type="button" class="history-card-header-btn" onclick="app.toggleHistoryCard('${log.id}')">
            <div class="history-card-header-left">
              <span class="history-dropdown-arrow">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </span>
              <div class="history-session-date">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                <span>${this.escapeHTML(formattedSession)}</span>
              </div>
            </div>
            <div class="history-card-header-right">
              <span class="history-total-kcal">${(Number(log['Total Kcal']) || 0).toLocaleString()} kcal</span>
            </div>
          </button>

          ${this.historyCardBodyHTML(log, { openDay: true })}
        </div>
      `;
    }).join('') + moreHTML;
  }

  // The inside of one logged day: its macro totals, its meals and the
  // edit and delete actions. Shared by the search list and the day view.
  // openDay adds the jump from a search result to that day on the strip.
  historyCardBodyHTML(log, { openDay = false } = {}) {
    // The day view has the summary card right above with these same totals,
    // so the macro line is only for search results.
    return `
      <div class="history-card-body">
        ${openDay ? `<div class="history-macros-row">
          <span>Protein: <strong style="color:var(--protein);">${log['Total Protein']}g</strong></span>
          <span>Carbs: <strong style="color:var(--carbs);">${log['Total Carbs']}g</strong></span>
          <span>Fat: <strong style="color:var(--fat);">${log['Total Fat']}g</strong></span>
        </div>` : ''}
        <div class="history-items-formatted-list">
          ${this.parseHistoryItemsHTML(log['Items Logged'] || '', log.id)}
        </div>
        <div class="history-card-footer">
          ${openDay ? `
          <button type="button" class="edit-entry-btn history-open-day-btn" style="width:auto; padding:4px 10px; font-size:0.75rem; gap:4px;" onclick="app.openDayFromHistory('${log.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            Open day
          </button>` : ''}
          <button type="button" class="edit-entry-btn" style="width:auto; padding:4px 10px; font-size:0.75rem; gap:4px;" onclick="app.openEditHistoryLogModal('${log.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Edit day
          </button>
          <button type="button" class="delete-entry-btn" style="width:auto; padding:4px 10px; font-size:0.75rem; gap:4px;" onclick="app.confirmDeleteHistoryLog('${log.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            Delete
          </button>
        </div>
      </div>
    `;
  }

  handleHistorySearch(value) {
    this.historySearchQuery = value || '';
    // A new search starts at the top of its own result list.
    this.historyVisibleCount = 10;
    this.renderHistoryList();
  }

  clearHistorySearch() {
    const input = document.getElementById('history-search-input');
    if (input) input.value = '';
    this.handleHistorySearch('');
    if (input) input.focus();
  }

  // A logged day reduced to the text worth matching on: its meal names and
  // the name of every food inside them. Legacy plain-text logs have no
  // structure to walk, so the raw string is the index.
  historySearchIndex(log) {
    const raw = log['Items Logged'] || '';
    const cached = this.historyIndexCache.get(log.id);
    if (cached && cached.raw === raw) return cached.text;

    let text = raw;
    if (raw.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          text = parsed.map(m => [
            m.name || '',
            ...(m.items || []).map(i => (i && i.name) || '')
          ].join(' ')).join(' ');
        }
      } catch (e) { /* fall back to the raw string */ }
    }
    text = text.toLowerCase();
    this.historyIndexCache.set(log.id, { raw, text });
    return text;
  }

  // The query, lowercased and trimmed, or '' when nothing is being searched.
  historyQuery() {
    return (this.historySearchQuery || '').trim().toLowerCase();
  }

  // Escapes first, then marks the hit, so a query containing < or & cannot
  // inject markup and the offsets still line up on both sides.
  highlightQuery(text, query) {
    const safe = this.escapeHTML(text == null ? '' : String(text));
    if (!query) return safe;
    const needle = this.escapeHTML(query);
    const idx = safe.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return safe;
    return safe.slice(0, idx) +
      '<mark class="search-hit">' + safe.slice(idx, idx + needle.length) + '</mark>' +
      safe.slice(idx + needle.length);
  }

  showMoreHistory(step = 'more') {
    this.historyVisibleCount = this.nextVisibleCount(this.historyVisibleCount, step);
    this.renderHistoryList();
  }

  // "Today", "Yesterday", "Wed 7 Oct", or with the year once it is not this
  // one - a date as you would say it, in place of 07/10/26.
  friendlyDate(value) {
    const d = parseAnyDate(value);
    if (isNaN(d.getTime())) return String(value || '');
    const days = Math.round((this.startOfDay(new Date()) - this.startOfDay(d)) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-GB', opts).replace(',', '');
  }

  showMoreWeights(step = 'more') {
    this.weightVisibleCount = this.nextVisibleCount(this.weightVisibleCount, step);
    this.renderWeightChart();
  }

  // FOOD LIST TAB
  // Renders only while its panel is on screen - renderAll() runs on every cloud
  // sync, and the list can be hundreds of rows.
  renderFoodsList() {
    const container = document.getElementById('foods-list-container');
    const countEl = document.getElementById('foods-count-badge');
    if (!container) return;

    const query = (this.foodsSearchQuery || '').trim().toLowerCase();
    const sort = this.foodsSortOption();
    const sortLabel = document.getElementById('foods-sort-label');
    if (sortLabel) sortLabel.textContent = sort.short;
    const byName = (a, b) => (a.Item || '').localeCompare(b.Item || '', undefined, { sensitivity: 'base' });
    // Ranked by the number the row shows, ties falling back to the name so
    // the order never shuffles between renders.
    const all = store.foods.slice().sort((a, b) => {
      if (!sort.field) return byName(a, b) * sort.dir;
      return ((Number(a[sort.field]) || 0) - (Number(b[sort.field]) || 0)) * sort.dir || byName(a, b);
    });
    const matches = query
      ? all.filter(f => (f.Item || '').toLowerCase().includes(query))
      : all;

    if (countEl) {
      countEl.textContent = query
        ? `${matches.length} of ${all.length}`
        : `${all.length} food${all.length === 1 ? '' : 's'}`;
    }

    if (all.length === 0) {
      container.innerHTML = `
        <div class="empty-log-box">
          <svg class="empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
          <div class="empty-title">Your food list is empty.</div>
          <div class="empty-desc">Save foods from the Meal Builder, or add one here.</div>
        </div>
      `;
      return;
    }

    if (matches.length === 0) {
      container.innerHTML = `
        <div class="empty-log-box">
          <div class="empty-title">No foods matching "${this.escapeHTML(this.foodsSearchQuery)}"</div>
          <div class="empty-desc">Try a shorter search, or add it as a new food.</div>
        </div>
      `;
      return;
    }

    const visible = matches.slice(0, this.foodsVisibleCount);
    const rowsHTML = visible.map(f => {
      // Name on top, one quiet line of numbers under it, and just two
      // buttons: the add everyone reaches for, and ⋮ for the rest. Every
      // macro is always shown - a zero is information too - and the serving
      // they are quoted against leads the line, lit up when it is not 100g.
      const unit = unitOfEntry(f);
      const basis = Number(f.Quantity) || unitInfo(unit).base;
      const usualBasis = unit === 'g' && basis === 100;
      const kcal = f.Kcal || 0;
      const prot = f.Protein || 0;
      const carb = f.Carb || 0;
      const fat = f.Fat || 0;
      const name = this.escapeHTML(f.Item || 'Food item');
      return `
        <div class="food-db-row">
          <div class="food-db-info">
            <span class="food-db-name">${name}${f.barcode ? ` <span class="food-db-barcode-flag" title="Has a saved barcode" aria-label="Has a saved barcode">${SCAN_ICON_SVG}</span>` : ''}</span>
            <div class="food-db-macros">
              <span class="food-db-basis${usualBasis ? '' : ' custom-basis'}" title="Macros are ${formatBasis(basis, unit)}">${formatAmount(basis, unit)}</span>
              <span class="food-db-macro kcal">${kcal} kcal</span>
              <span class="food-db-macro prot">P ${prot}g</span>
              <span class="food-db-macro carb">C ${carb}g</span>
              <span class="food-db-macro fat">F ${fat}g</span>
            </div>
          </div>
          <button type="button" class="food-db-icon-btn food-db-add-btn" title="Add to Meal Builder"
                  aria-label="Add ${name} to the Meal Builder" onclick="app.addFoodToBuilderFromDb('${f.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          <button type="button" class="food-db-icon-btn menu-trigger" title="Food options" aria-label="Options for ${name}"
                  aria-haspopup="menu" aria-expanded="false" onclick="app.openFoodMenu(this, '${f.id}')">
            ${MENU_DOTS_SVG}
          </button>
        </div>
      `;
    }).join('');

    container.innerHTML = rowsHTML + this.listPagerHTML('showMoreFoods', visible.length, matches.length);
  }

  foodsSortOption() {
    return FOOD_SORTS.find(s => s.id === this.foodsSort) || FOOD_SORTS[0];
  }

  openFoodsSortMenu(anchor) {
    const current = this.foodsSortOption();
    this.openActionMenu(anchor, FOOD_SORTS.map(s => ({
      label: s.label,
      // The tick marks the order in use; the rest keep its width so the
      // labels still line up.
      icon: s.id === current.id ? MENU_ICONS.check : '<span class="menu-icon-spacer"></span>',
      active: s.id === current.id,
      action: () => this.setFoodsSort(s.id)
    })));
  }

  setFoodsSort(id) {
    this.foodsSort = id;
    try { localStorage.setItem('macroFoodsSort', id); } catch (e) { /* private mode */ }
    this.renderFoodsList();
  }

  // The foot of a paged list: ten more on one half, the whole list on the
  // other. With ten or fewer left both would do the same thing, so it is a
  // single button, and once everything is open it folds the list back.
  listPagerHTML(method, shown, total) {
    if (total <= 10) return '';
    if (shown >= total) {
      return `<button type="button" class="view-more-btn" onclick="app.${method}('less')">Show less</button>`;
    }
    const left = total - shown;
    if (left <= 10) {
      return `
        <button type="button" class="view-more-btn" onclick="app.${method}('all')">
          View ${left} more &middot; ${shown} of ${total}
        </button>
      `;
    }
    return `
      <div class="view-more-split">
        <button type="button" class="view-more-btn" onclick="app.${method}('more')">View 10 more</button>
        <button type="button" class="view-more-btn" onclick="app.${method}('all')">Show all &middot; ${total}</button>
      </div>
    `;
  }

  // 'more' opens ten more rows, 'all' the rest of the list, 'less' goes back
  // to the first ten.
  nextVisibleCount(current, step) {
    if (step === 'all') return Infinity;
    if (step === 'less') return 10;
    return current + 10;
  }

  handleFoodsSearch(value) {
    this.foodsSearchQuery = value || '';
    // A new search starts at the top of its own result list.
    this.foodsVisibleCount = 10;
    this.renderFoodsList();
  }

  addFoodToBuilderFromDb(foodId) {
    const food = store.foods.find(f => f.id === foodId);
    if (!food) return;
    this.dropEmptyBuilderRows();
    this.addNewBuilderRow(food);
    this.renderBuilderRows();
    this.showTodayView();
    this.switchView('dashboard');
    this.showToast(`Added "${food.Item}" to the Meal Builder`, 'success');
    // Land on the quantity box of the row just added, the same way picking a
    // food out of the search results does.
    const newRowId = this.builderRows[this.builderRows.length - 1].id;
    setTimeout(() => {
      const qtyInput = document.getElementById(`input-qty-${newRowId}`);
      if (qtyInput) {
        qtyInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
        qtyInput.focus();
        qtyInput.select();
      }
    }, 80);
  }

  openAddFoodModal() {
    this.openSaveFoodToDbModal('', '', null, '');
  }

  confirmDeleteFood(foodId) {
    const food = store.foods.find(f => f.id === foodId);
    if (!food) return;
    const name = food.Item || 'this food';
    this.confirmDelete(async () => {
      const res = await store.deleteFoodFromDatabase(foodId);
      this.renderFoodsList();
      if (res && res.success === false) {
        this.showToast(`Could not delete "${name}": ${res.error}`, 'error');
      } else {
        this.showToast(`Removed "${name}" from your food list`, 'success');
      }
    }, `Delete "${name}" from your food list? Meals you have already logged keep their numbers.`);
  }

  showMoreFoods(step = 'more') {
    this.foodsVisibleCount = this.nextVisibleCount(this.foodsVisibleCount, step);
    this.renderFoodsList();
  }

  toggleHistoryCard(logId) {
    const card = document.getElementById(`history-card-${logId}`);
    if (card) {
      const isOpen = card.classList.toggle('open');
      // Remembered so a background sync repaint re-opens what you had open
      // instead of snapping every card shut.
      if (isOpen) this.openHistoryCards.add(logId);
      else this.openHistoryCards.delete(logId);
    }
  }

  parseHistoryItemsHTML(rawString, logId) {
    if (!rawString) return '<span style="color:var(--text-dim); font-size:0.75rem;">No items recorded</span>';
    const q = this.historyQuery();

    // Structured (JSON) logs support editing one food at a time, because every
    // item carries its own macros. Legacy plain-text logs never stored per-item
    // macros, so they fall through to the read-only renderer below.
    if (rawString.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(rawString);
        // Same treatment as Today's Log: one food per line inside a meal that
        // collapses, rather than inline pills that wrap mid-value on a phone.
        return parsed.map((m, mealIdx) => {
          const key = `${logId}:${mealIdx}`;
          // Only the meal holding the hit unfolds; the rest of the day stays
          // collapsed so one match does not dump the whole day on screen.
          const mealHit = !!q && (
            (m.name || '').toLowerCase().includes(q) ||
            (m.items || []).some(i => ((i && i.name) || '').toLowerCase().includes(q))
          );
          const open = (mealHit || this.openHistoryMeals.has(key)) ? ' open' : '';
          return `
          <div class="history-meal-group today-meal-group${open}${this.isMealBeingEdited('history', logId, mealIdx) ? ' being-edited' : ''}" id="hist-meal-${this.escapeHTML(logId)}-${mealIdx}">
            <div class="history-meal-group-title today-meal-title">
              <button type="button" class="today-meal-toggle" onclick="app.toggleHistoryMeal('${logId}', ${mealIdx})">
                ${this.mealHeadingHTML(m.name || 'Meal', m.totals, q)}
              </button>
              <div class="today-meal-head-actions">
                ${this.mealMenuButtonHTML('history', logId, mealIdx)}
              </div>
            </div>
            <div class="today-meal-body">
              <div class="today-food-rows">
                ${(m.items || []).map((i, itemIdx) => this.loggedFoodRowHTML(i, `
                  <div class="today-food-actions">
                    <button type="button" class="pill-icon-btn" title="Copy this food into the Meal Builder"
                      onclick="app.copyFoodToBuilder('history', '${logId}', ${mealIdx}, ${itemIdx})">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                    <button type="button" class="pill-icon-btn" title="Edit this food"
                      onclick="app.openEditHistoryItemModal('${logId}', ${mealIdx}, ${itemIdx})">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    </button>
                    <button type="button" class="pill-icon-btn danger" title="Remove this food"
                      onclick="app.confirmDeleteHistoryItem('${logId}', ${mealIdx}, ${itemIdx})">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </button>
                  </div>
                `, q)).join('')}
              </div>
            </div>
          </div>
        `;
        }).join('');
      } catch (e) {}
    }

    const meals = rawString.split('|');
    return meals.map(mealStr => {
      const trimmed = mealStr.trim();
      if (!trimmed) return '';
      let title = 'Meal';
      let itemsStr = '';
      
      const closeParenColonIdx = trimmed.indexOf('):');
      if (closeParenColonIdx !== -1) {
        title = trimmed.substring(0, closeParenColonIdx + 1).trim();
        itemsStr = trimmed.substring(closeParenColonIdx + 2).trim();
      } else {
        const colonMatch = trimmed.match(/^([^:]+):\s*(.*)$/s);
        if (colonMatch) {
          title = colonMatch[1].trim();
          itemsStr = colonMatch[2].trim();
        } else {
          itemsStr = trimmed;
        }
      }

      const rawItems = itemsStr.split(/,\s*(?=[0-9]+g|[A-Za-z])/).map(i => i.trim()).filter(Boolean);
      const items = rawItems.length > 0 ? rawItems : itemsStr.split(',').map(i => i.trim()).filter(Boolean);
      
      return `
        <div class="history-meal-group">
          <div class="history-meal-group-title">
            <span class="history-meal-name-text">${this.highlightQuery(title, q)}</span>
          </div>
          <div class="history-food-pills-wrap">
            ${items.map(item => {
              const qtyMatch = item.match(/^(\d+(?:\.\d+)?g?)\s+(.*)$/);
              if (qtyMatch) {
                return `<span class="history-food-pill"><strong style="color:var(--accent); margin-right:4px;">${this.escapeHTML(qtyMatch[1])}</strong> ${this.highlightQuery(qtyMatch[2], q)}</span>`;
              }
              return `<span class="history-food-pill">${this.highlightQuery(item, q)}</span>`;
            }).join('')}
          </div>
        </div>
      `;
    }).filter(Boolean).join('');
  }

  confirmDeleteHistoryLog(logId) {
    this.confirmDelete(() => {
      store.deletePastLog(logId);
      this.renderAll();
      this.showToast('History log deleted', 'success');
    }, 'Are you sure you want to permanently delete this past history log?');
  }

  openEditHistoryLogModal(logId) {
    const log = store.pastLogs.find(l => l.id === logId);
    if (!log) return;
    document.getElementById('edit-history-log-id').value = log.id;
    document.getElementById('edit-history-session-date').value = log['Log Session'] || '';
    document.getElementById('edit-history-total-kcal').value = log['Total Kcal'] || 0;
    document.getElementById('edit-history-prot').value = log['Total Protein'] || 0;
    document.getElementById('edit-history-carb').value = log['Total Carbs'] || 0;
    document.getElementById('edit-history-fat').value = log['Total Fat'] || 0;

    // For structured logs the raw JSON must not be hand-edited - one stray
    // character silently destroys the whole food breakdown. Show the per-item
    // route instead and hide the textarea.
    const structuredMeals = store.getPastLogMeals(logId);
    const textGroup = document.getElementById('edit-history-items-text-group');
    const structuredNote = document.getElementById('edit-history-items-structured-note');
    const textArea = document.getElementById('edit-history-items-text');
    if (structuredMeals) {
      if (textGroup) textGroup.style.display = 'none';
      if (structuredNote) structuredNote.style.display = 'block';
      if (textArea) textArea.value = '';
    } else {
      if (textGroup) textGroup.style.display = '';
      if (structuredNote) structuredNote.style.display = 'none';
      if (textArea) textArea.value = log['Items Logged'] || '';
    }
    this.openModal('edit-history-log-modal');
  }

  async handleSaveEditedHistoryLog() {
    const logId = document.getElementById('edit-history-log-id').value;
    const sessionDate = document.getElementById('edit-history-session-date').value.trim();
    const kcal = parseInt(document.getElementById('edit-history-total-kcal').value, 10) || 0;
    const prot = parseFloat(document.getElementById('edit-history-prot').value) || 0;
    const carb = parseFloat(document.getElementById('edit-history-carb').value) || 0;
    const fat = parseFloat(document.getElementById('edit-history-fat').value) || 0;

    const fields = {
      "Log Session": sessionDate,
      "Total Kcal": kcal,
      "Total Protein": prot,
      "Total Carbs": carb,
      "Total Fat": fat
    };
    // Only legacy text logs write the description back; structured logs keep
    // their JSON breakdown untouched by this dialog.
    if (!store.getPastLogMeals(logId)) {
      fields["Items Logged"] = document.getElementById('edit-history-items-text').value.trim();
    }

    this.closeModal('edit-history-log-modal');
    const res = await store.updatePastLog(logId, fields);
    this.renderAll();
    if (res && res.success === false) {
      this.showToast(`Could not save log: ${res.error}`, 'error');
    } else {
      this.showToast('Past history log updated!', 'success');
    }
  }

  openEditHistoryItemModal(logId, mealIdx, itemIdx) {
    const meals = store.getPastLogMeals(logId);
    if (!meals || !meals[mealIdx] || !meals[mealIdx].items[itemIdx]) return;
    const meal = meals[mealIdx];
    const item = meal.items[itemIdx];
    const log = store.pastLogs.find(l => l.id === logId);

    document.getElementById('edit-hist-item-log-id').value = logId;
    document.getElementById('edit-hist-item-meal-idx').value = mealIdx;
    document.getElementById('edit-hist-item-idx').value = itemIdx;
    document.getElementById('edit-hist-item-name').value = item.name || '';
    document.getElementById('edit-hist-item-qty').value = item.qty ?? 0;
    this.setQtyFieldLabel('edit-hist-item-qty', unitOfEntry(item));
    document.getElementById('edit-hist-item-kcal').value = Math.round(item.kcal || 0);
    document.getElementById('edit-hist-item-prot').value = item.protein ?? 0;
    document.getElementById('edit-hist-item-carb').value = item.carbs ?? 0;
    document.getElementById('edit-hist-item-fat').value = item.fat ?? 0;

    const ctx = document.getElementById('edit-hist-item-context');
    if (ctx) {
      ctx.textContent = `${formatDateTimeDMY(log ? log['Log Session'] : '')} · ${meal.name || 'Meal'}`;
    }

    // Rescale macros proportionally as the quantity changes, anchored to the
    // values the item had when the dialog opened.
    const base = {
      qty: Number(item.qty) || 0,
      kcal: Number(item.kcal) || 0,
      protein: Number(item.protein) || 0,
      carbs: Number(item.carbs) || 0,
      fat: Number(item.fat) || 0
    };
    const qtyInput = document.getElementById('edit-hist-item-qty');
    qtyInput.oninput = () => {
      const newQty = parseFloat(qtyInput.value);
      if (!base.qty || isNaN(newQty)) return;
      const ratio = newQty / base.qty;
      document.getElementById('edit-hist-item-kcal').value = Math.round(base.kcal * ratio);
      document.getElementById('edit-hist-item-prot').value = Math.round(base.protein * ratio * 10) / 10;
      document.getElementById('edit-hist-item-carb').value = Math.round(base.carbs * ratio * 10) / 10;
      document.getElementById('edit-hist-item-fat').value = Math.round(base.fat * ratio * 10) / 10;
    };

    this.openModal('edit-history-item-modal');
  }

  async handleSaveEditedHistoryItem() {
    const logId = document.getElementById('edit-hist-item-log-id').value;
    const mealIdx = parseInt(document.getElementById('edit-hist-item-meal-idx').value, 10);
    const itemIdx = parseInt(document.getElementById('edit-hist-item-idx').value, 10);

    const meals = store.getPastLogMeals(logId);
    if (!meals || !meals[mealIdx] || !meals[mealIdx].items[itemIdx]) {
      this.closeModal('edit-history-item-modal');
      this.showToast('That food is no longer available to edit', 'error');
      return;
    }

    meals[mealIdx].items[itemIdx] = {
      ...meals[mealIdx].items[itemIdx],
      name: document.getElementById('edit-hist-item-name').value.trim(),
      qty: parseFloat(document.getElementById('edit-hist-item-qty').value) || 0,
      kcal: parseFloat(document.getElementById('edit-hist-item-kcal').value) || 0,
      protein: parseFloat(document.getElementById('edit-hist-item-prot').value) || 0,
      carbs: parseFloat(document.getElementById('edit-hist-item-carb').value) || 0,
      fat: parseFloat(document.getElementById('edit-hist-item-fat').value) || 0
    };

    this.closeModal('edit-history-item-modal');
    const res = await store.savePastLogMeals(logId, meals);
    this.renderAll();
    if (res && res.success === false) {
      this.showToast(`Could not save food: ${res.error}`, 'error');
    } else {
      this.showToast('Food updated & day totals recalculated', 'success');
    }
  }

  confirmDeleteHistoryItem(logId, mealIdx, itemIdx) {
    const meals = store.getPastLogMeals(logId);
    if (!meals || !meals[mealIdx] || !meals[mealIdx].items[itemIdx]) return;
    const itemName = meals[mealIdx].items[itemIdx].name || 'this food';

    this.confirmDelete(async () => {
      const fresh = store.getPastLogMeals(logId);
      if (!fresh || !fresh[mealIdx] || !fresh[mealIdx].items[itemIdx]) return;
      fresh[mealIdx].items.splice(itemIdx, 1);
      const res = await store.savePastLogMeals(logId, fresh);
      this.renderAll();
      if (res && res.success === false) {
        this.showToast(`Could not remove food: ${res.error}`, 'error');
      } else {
        this.showToast('Food removed & day totals recalculated', 'success');
      }
    }, `Remove "${itemName}" from this day? The day's totals will be recalculated.`);
  }

  // A logged meal can be sent back to the Meal Builder or kept as a favourite.
  // Today's Log addresses a meal by id; a past-history log addresses one by log
  // id plus its index inside that day. Everything downstream is identical, so it
  // all funnels through these three helpers.
  mealSourceFor(kind, a, b) {
    if (kind === 'today') {
      const meal = store.todayMeals.find(m => m.id === a);
      return meal ? { name: meal.name || 'Meal', items: meal.items || [] } : null;
    }
    const log = store.pastLogs.find(l => l.id === a);
    if (!log) return null;
    let parsed = [];
    try {
      parsed = JSON.parse(log['Items Logged']);
    } catch (e) {
      return null;
    }
    const meal = Array.isArray(parsed) ? parsed[b] : null;
    return meal ? { name: meal.name || 'Meal', items: meal.items || [] } : null;
  }

  // A logged item's macros are already scaled to the amount eaten, so that amount
  // is also the basis they are quoted against. Recording it that way keeps the
  // numbers exact on the way back in, and still lets the quantity be edited
  // afterwards without the macros drifting.
  mealItemsAsFoods(items) {
    return (items || [])
      .filter(i => i && i.name)
      .map(i => {
        const qty = Number(i.qty) || 0;
        return {
          Item: i.name,
          Quantity: qty > 0 ? qty : 100,
          Unit: unitOfEntry(i),
          Kcal: Number(i.kcal) || 0,
          Protein: Number(i.protein ?? i.prot) || 0,
          Carb: Number(i.carbs ?? i.carb) || 0,
          Fat: Number(i.fat) || 0,
          userQty: qty,
          fixedMacros: qty <= 0
        };
      });
  }

  // The ⋮ button on a logged meal. Everything it can do lives in the menu, so
  // the meal heading carries one quiet button instead of a row of icons.
  mealMenuButtonHTML(kind, a, b) {
    const args = kind === 'today' ? `'today', '${a}'` : `'history', '${a}', ${b}`;
    return `
      <button type="button" class="pill-icon-btn menu-trigger" title="Meal options" aria-label="Meal options"
              aria-haspopup="menu" aria-expanded="false"
              onclick="event.stopPropagation(); app.openMealMenu(this, ${args})">
        ${MENU_DOTS_SVG}
      </button>
    `;
  }

  // ACTION MENUS
  // One floating menu, filled for whichever ⋮ was tapped and placed beside
  // it. Items are { label, icon, action, danger, active }. It closes on a pick, a tap
  // anywhere else, Esc, or the page scrolling out from under it.
  openActionMenu(anchor, items) {
    const reopening = this.actionMenu && this.actionMenu.anchor === anchor;
    this.closeActionMenu();
    if (reopening || !anchor) return;

    const menu = document.createElement('div');
    menu.className = 'action-menu';
    menu.setAttribute('role', 'menu');
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'header-menu-item' + (item.danger ? ' danger' : '') + (item.active ? ' active' : '');
      btn.setAttribute('role', 'menuitem');
      btn.innerHTML = `${item.icon || ''}<span>${this.escapeHTML(item.label)}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeActionMenu();
        item.action();
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);

    // Right-aligned under the button, flipped above it when there is no room
    // below, and always kept on screen.
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    anchor.setAttribute('aria-expanded', 'true');
    this.actionMenu = { el: menu, anchor };
  }

  closeActionMenu() {
    if (!this.actionMenu) return;
    this.actionMenu.el.remove();
    this.actionMenu.anchor.setAttribute('aria-expanded', 'false');
    this.actionMenu = null;
  }

  openMealMenu(anchor, kind, a, b) {
    const items = [
      { label: 'Edit in Meal Builder', icon: MENU_ICONS.edit, action: () => this.startMealEdit(kind, a, b) },
      { label: 'Copy to Meal Builder', icon: MENU_ICONS.copy, action: () => this.copyMealToBuilder(kind, a, b) },
      { label: 'Save as favourite', icon: MENU_ICONS.star, action: () => this.saveMealAsFavorite(kind, a, b) },
      {
        label: 'Delete meal',
        icon: MENU_ICONS.trash,
        danger: true,
        action: () => (kind === 'today' ? this.confirmDeleteTodayMeal(a) : this.confirmDeleteHistoryMeal(a, b))
      }
    ];
    this.openActionMenu(anchor, items);
  }

  // Adding sits on the row itself as the "+"; the menu holds the rest.
  openFoodMenu(anchor, foodId) {
    this.openActionMenu(anchor, [
      { label: 'Edit food', icon: MENU_ICONS.edit, action: () => this.openEditFoodModal(foodId) },
      { label: 'Delete food', icon: MENU_ICONS.trash, danger: true, action: () => this.confirmDeleteFood(foodId) }
    ]);
  }

  openAddFoodMenu(anchor) {
    this.openActionMenu(anchor, [
      { label: 'Enter it manually', icon: MENU_ICONS.edit, action: () => this.openAddFoodModal() },
      { label: 'Scan a barcode', icon: SCAN_ICON_SVG, action: () => this.openBarcodeScanner(null, 'database') }
    ]);
  }

  // A past day's meal, removed from its logged day. The last meal takes the
  // whole day with it, since an empty logged day would only be clutter.
  confirmDeleteHistoryMeal(logId, mealIdx) {
    const meals = store.getPastLogMeals(logId);
    if (!meals || !meals[mealIdx]) {
      this.showToast('That meal could not be found', 'error');
      return;
    }
    const name = meals[mealIdx].name || 'this meal';
    const lastOne = meals.length === 1;
    this.confirmDelete(async () => {
      if (lastOne) {
        store.deletePastLog(logId);
        this.renderAll();
        this.showToast('Meal and its logged day deleted', 'success');
        return;
      }
      const fresh = store.getPastLogMeals(logId) || [];
      fresh.splice(mealIdx, 1);
      this.renderAll();
      const res = await store.savePastLogMeals(logId, fresh);
      this.renderAll();
      if (res && res.success === false) {
        this.showToast(`Could not delete the meal: ${res.error}`, 'error');
      } else {
        this.showToast(`Deleted "${name}"`, 'success');
      }
    }, lastOne
      ? `"${name}" is the only meal on this logged day, so the whole day will be deleted.`
      : `Delete "${name}" from this logged day?`);
  }

  // EDITING A LOGGED MEAL IN THE MEAL BUILDER
  // The meal's foods load into the builder, where they can be changed like
  // any other rows, and Log Meal becomes Save Changes. Whatever was already
  // in the builder is set aside (store.builderStash) rather than lost, and
  // comes back when the edit is saved or cancelled. A past day's meal gets
  // the builder on that day, for as long as the edit lasts.
  startMealEdit(kind, a, b) {
    const src = this.mealSourceFor(kind, a, b);
    if (!src) {
      this.showToast('That meal could not be found', 'error');
      return;
    }
    const begin = () => this.beginMealEdit(kind, a, b, src);

    if (this.mealEdit) {
      const same = this.mealEdit.kind === kind &&
        (kind === 'today' ? this.mealEdit.mealId === a : (this.mealEdit.logId === a && this.mealEdit.mealIdx === b));
      if (same) {
        this.scrollBuilderIntoView();
        return;
      }
      this.confirmAction({
        title: 'Edit another meal?',
        message: `You're still editing "${this.mealEdit.name}". Its unsaved changes will be dropped.`,
        confirmLabel: 'Edit this meal',
        onConfirm: () => {
          this.endMealEdit();
          begin();
        }
      });
      return;
    }

    const waiting = store.meaningfulBuilderRows().length;
    if (waiting > 0) {
      const foods = waiting === 1 ? '1 food' : `${waiting} foods`;
      const they = waiting === 1 ? 'It' : 'They';
      this.confirmAction({
        title: 'Edit meal',
        message: `Your Meal Builder has ${foods} in it. ${they}'ll be set aside while you edit "${src.name}", and put back when you save or cancel.`,
        confirmLabel: 'Edit meal',
        onConfirm: begin
      });
      return;
    }
    begin();
  }

  beginMealEdit(kind, a, b, src) {
    const log = kind === 'history' ? store.pastLogs.find(l => l.id === a) : null;
    if (kind === 'history' && !log) {
      this.showToast('That meal could not be found', 'error');
      return;
    }

    store.builderStash = store.meaningfulBuilderRows().map(r => ({ ...r, overrides: { ...(r.overrides || {}) } }));
    this.mealEdit = {
      kind,
      mealId: kind === 'today' ? a : null,
      logId: kind === 'history' ? a : null,
      mealIdx: kind === 'history' ? b : null,
      name: src.name,
      dayDate: log ? parseAnyDate(log['Log Session']) : null
    };
    this.builderRows = [];
    this.mealItemsAsFoods(src.items).forEach(f => this.addNewBuilderRow(f));

    this.closeHistorySearch();
    this.switchView('dashboard');
    if (log) this.selectDay(this.mealEdit.dayDate);
    else if (!this.isViewingToday() || this.stripWeek) this.goToToday();

    this.renderBuilderRows();
    this.applyMealEditState();
    this.renderTodaysLogs();
    this.renderDayLogs();
    this.scrollBuilderIntoView();
  }

  setMealEditName(value) {
    if (this.mealEdit) this.mealEdit.name = value;
  }

  // Puts the builder's own rows back and leaves edit mode. Nothing is saved.
  endMealEdit() {
    const stash = store.builderStash || [];
    store.builderStash = null;
    this.mealEdit = null;
    this.builderRows = stash;
    this.renderBuilderRows();
    this.applyMealEditState();
  }

  cancelMealEdit() {
    if (!this.mealEdit) return;
    this.endMealEdit();
    this.renderAll();
  }

  async saveMealEdit() {
    const edit = this.mealEdit;
    if (!edit) return;
    const { items, totals } = this.builderItemsForLog();
    if (items.length === 0) {
      this.showToast('Add at least one food, or delete the meal from its ⋮ menu instead', 'error');
      return;
    }
    const name = (edit.name || '').trim() || 'Meal';

    let res = null;
    if (edit.kind === 'today') {
      if (!store.todayMeals.find(m => m.id === edit.mealId)) {
        this.showToast('That meal is no longer in Today\'s Log', 'error');
        return;
      }
      this.endMealEdit();
      this.renderAll();
      await store.updateTodayMeal(edit.mealId, name, items);
    } else {
      const meals = store.getPastLogMeals(edit.logId);
      if (!meals || !meals[edit.mealIdx]) {
        this.showToast('That meal is no longer on its logged day', 'error');
        return;
      }
      meals[edit.mealIdx] = { ...meals[edit.mealIdx], name, items };
      this.endMealEdit();
      res = await store.savePastLogMeals(edit.logId, meals);
    }

    this.renderAll();
    if (res && res.success === false) {
      this.showToast(`Could not save "${name}": ${res.error}`, 'error');
    } else {
      this.showToast(`Updated "${name}" (${totals.kcal} kcal)`, 'success');
    }
  }

  // Edit mode on screen: the banner naming the meal, the builder shown even
  // on a past day, and Log Meal reading Save Changes.
  applyMealEditState() {
    const edit = this.mealEdit;
    const panel = document.getElementById('panel-dashboard');
    if (panel) panel.classList.toggle('editing-meal', !!edit);

    const nameInput = document.getElementById('meal-edit-name-input');
    if (nameInput && edit && document.activeElement !== nameInput) nameInput.value = edit.name || '';

    const dayEl = document.getElementById('meal-edit-banner-day');
    if (dayEl) {
      let day = '';
      if (edit && edit.dayDate) {
        day = ' · ' + edit.dayDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
      } else if (edit) {
        day = ' · Today';
      }
      dayEl.textContent = day;
    }

    const logBtn = document.getElementById('log-meal-submit-btn');
    if (logBtn) {
      const label = logBtn.querySelector('span');
      if (label) label.textContent = edit ? 'Save changes' : 'Log meal';
    }
    this.refreshLogMealButton();
  }

  // The meal being edited, for marking it in Today's Log or a past day.
  isMealBeingEdited(kind, a, b) {
    const edit = this.mealEdit;
    if (!edit || edit.kind !== kind) return false;
    return kind === 'today' ? edit.mealId === a : (edit.logId === a && edit.mealIdx === b);
  }

  scrollBuilderIntoView() {
    setTimeout(() => {
      const card = document.querySelector('.meal-builder-card');
      if (!card) return;
      try {
        card.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (e) { /* older engines */ }
    }, 60);
  }

  // Shared by the whole-meal copy and the single-food copy below.
  // Joins whatever is already in the builder rather than replacing it.
  appendFoodsToBuilder(foods, message) {
    this.dropEmptyBuilderRows();
    foods.forEach(f => this.addNewBuilderRow(f));
    this.renderBuilderRows();
    this.showTodayView();
    this.switchView('dashboard');
    this.showToast(message, 'success');
    setTimeout(() => {
      const card = document.querySelector('.meal-builder-card');
      if (card) {
        try {
          card.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } catch (e) { /* older engines */ }
      }
    }, 60);
  }

  copyMealToBuilder(kind, a, b) {
    const src = this.mealSourceFor(kind, a, b);
    const foods = src ? this.mealItemsAsFoods(src.items) : [];
    if (foods.length === 0) {
      this.showToast('That meal has no foods to copy', 'error');
      return;
    }
    this.appendFoodsToBuilder(foods, `Copied "${src.name}" into the Meal Builder`);
  }

  // One food out of a logged meal, for the times a whole meal is more than
  // you want back. Same item shape, so the macros land exactly as logged.
  copyFoodToBuilder(kind, a, b, itemIdx) {
    const src = this.mealSourceFor(kind, a, b);
    const item = src && Array.isArray(src.items) ? src.items[itemIdx] : null;
    const foods = this.mealItemsAsFoods(item ? [item] : []);
    if (foods.length === 0) {
      this.showToast('That food could not be copied', 'error');
      return;
    }
    this.appendFoodsToBuilder(foods, `Added "${foods[0].Item}" to the Meal Builder`);
  }

  saveMealAsFavorite(kind, a, b) {
    const src = this.mealSourceFor(kind, a, b);
    const foods = src ? this.mealItemsAsFoods(src.items) : [];
    if (foods.length === 0) {
      this.showToast('That meal has no foods to save', 'error');
      return;
    }
    // Basis and eaten amount are the same here, so the scaled figures a
    // favourite carries are just the base ones.
    const items = foods.map(f => ({
      ...f,
      kcal: f.Kcal,
      prot: f.Protein,
      carb: f.Carb,
      fat: f.Fat,
      overrides: {}
    }));
    this.openSaveFavoriteModal(items, src.name);
  }

  // One food inside a logged meal. Shared by Today's Log and Past History, which
  // had been carrying two copies of this markup.
  loggedFoodRowHTML(item, actionsHTML, query) {
    const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
    const kcal = Math.round(Number(item.kcal) || 0);
    return `
      <div class="today-food-row">
        <div class="today-food-main">
          <span class="today-food-qty">${this.escapeHTML(formatAmount(item.qty, unitOfEntry(item)))}</span>
          <span class="today-food-name">${this.highlightQuery(item.name, query)}</span>
          ${actionsHTML}
        </div>
        <div class="today-food-macros">
          <span class="kcal">${kcal.toLocaleString()} kcal</span>
          <span class="prot">P ${r1(item.protein ?? item.prot)}g</span>
          <span class="carb">C ${r1(item.carbs ?? item.carb)}g</span>
          <span class="fat">F ${r1(item.fat)}g</span>
        </div>
      </div>
    `;
  }

  // Favorites are stored as JSON, and the shape has drifted over the life of
  // the app. Everything ends up here as one builder row so an old favorite
  // rescales exactly like a new one.
  //
  //  - current shape: Quantity/Kcal/... is the basis the macros are quoted
  //    against, userQty is how much was actually eaten
  //  - raw builder rows: baseQty/baseKcal/... plus qty
  //  - flat legacy rows: one quantity with the macros already scaled to it,
  //    which is both the basis and the amount eaten
  normalizeFavoriteItem(item) {
    if (!item || typeof item !== 'object') return null;
    const num = (v, fallback = 0) => {
      const n = Number(v);
      return isFinite(n) ? n : fallback;
    };
    const name = (item.name || item.Item || '').toString().trim();
    if (!name) return null;

    let baseQty, baseKcal, baseProt, baseCarb, baseFat, qty;
    if (item.userQty !== undefined) {
      baseQty = num(item.Quantity, 100) || 100;
      baseKcal = num(item.Kcal);
      baseProt = num(item.Protein);
      baseCarb = num(item.Carb ?? item.Carbs);
      baseFat = num(item.Fat);
      qty = num(item.userQty);
    } else if (item.baseQty !== undefined || item.baseKcal !== undefined) {
      baseQty = num(item.baseQty, 100) || 100;
      baseKcal = num(item.baseKcal);
      baseProt = num(item.baseProt);
      baseCarb = num(item.baseCarb);
      baseFat = num(item.baseFat);
      qty = num(item.qty);
    } else {
      // Flat legacy row. The macros are already scaled to the one quantity it
      // carries, so treat that quantity as the basis - which keeps the numbers
      // right on load and makes editing the quantity scale from the truth.
      qty = num(item.Quantity ?? item.quantity ?? item.qty, 0);
      baseQty = qty > 0 ? qty : 100;
      baseKcal = num(item.Kcal ?? item.kcal);
      baseProt = num(item.Protein ?? item.protein ?? item.prot);
      baseCarb = num(item.Carb ?? item.Carbs ?? item.carb ?? item.carbs);
      baseFat = num(item.Fat ?? item.fat);
    }

    const overrides = (item.overrides && typeof item.overrides === 'object')
      ? { ...item.overrides }
      : {};
    return {
      name,
      unit: unitOfEntry(item),
      baseQty,
      baseKcal,
      baseProt,
      baseCarb,
      baseFat,
      qty,
      overrides,
      // Only consulted for macros the user typed by hand, which must survive
      // the round trip untouched by the ratio.
      savedKcal: num(item.kcal),
      savedProt: num(item.prot),
      savedCarb: num(item.carb),
      savedFat: num(item.fat)
    };
  }

  // What actually gets written to the favorites table: the per-serving basis
  // and the amount eaten, kept as separate fields. Saving only the scaled
  // macros is what made a loaded favorite drift the moment its quantity was
  // edited - the scaled value was being read back as if it were the basis.
  buildFavoriteItems() {
    return this.builderRows
      .filter(r => r.name.trim() && r.qty > 0)
      .map(r => ({
        Item: r.name.trim(),
        Quantity: r.baseQty,
        Unit: unitOfEntry(r),
        Kcal: r.baseKcal,
        Protein: r.baseProt,
        Carb: r.baseCarb,
        Fat: r.baseFat,
        userQty: r.qty,
        kcal: r.kcal,
        prot: r.prot,
        carb: r.carb,
        fat: r.fat,
        overrides: { ...r.overrides }
      }));
  }

  favoriteItemsOf(fav) {
    let items = [];
    try {
      items = JSON.parse(fav.Items);
    } catch (e) { /* a malformed row reads as empty */ }
    if (!Array.isArray(items)) return [];
    return items.map(i => this.normalizeFavoriteItem(i)).filter(Boolean);
  }

  // Called with no arguments from the Meal Builder, and with a logged meal
  // from Today's Log or Past History.
  openSaveFavoriteModal(items = null, defaultName = '') {
    const favItems = items || this.buildFavoriteItems();
    if (favItems.length === 0) {
      this.showToast('Add ingredients to your meal before saving as favorite', 'error');
      return;
    }
    // Held only for a dialog opened from a logged meal. Left null, the submit
    // handler re-reads the builder, so an edit made while the dialog is open
    // still counts.
    this.pendingFavoriteItems = items ? favItems : null;

    const nameInput = document.getElementById('save-favorite-name-input');
    const summaryEl = document.getElementById('save-favorite-items-summary');

    if (nameInput) nameInput.value = defaultName || '';
    if (summaryEl) {
      summaryEl.textContent = favItems.map(i => `${formatAmount(i.userQty, unitOfEntry(i))} ${i.Item}`).join(' • ');
    }
    this.openModal('save-favorite-modal');
  }

  handleSaveFavoriteSubmit() {
    const items = this.pendingFavoriteItems || this.buildFavoriteItems();
    this.pendingFavoriteItems = null;
    if (items.length === 0) {
      this.showToast('Add ingredients to your meal before saving as favorite', 'error');
      return;
    }

    const nameInput = document.getElementById('save-favorite-name-input');
    const mealName = (nameInput && nameInput.value.trim()) || 'Favorite Combo';

    store.saveFavorite(mealName, items);
    this.closeModal('save-favorite-modal');
    this.showToast(`Saved "${mealName}" to Favorites!`, 'success');
  }

  openFavoritesModal() {
    const container = document.getElementById('favorites-list-modal-body');
    if (!container) return;
    if (store.favorites.length === 0) {
      container.innerHTML = `<div style="text-align:center; color:var(--text-dim); padding:20px;">No favorite meals saved yet. Click "Save Favorite" in the meal builder to save one!</div>`;
      return;
    }
    container.innerHTML = store.favorites.map(f => {
      const items = this.favoriteItemsOf(f);
      const summary = items.length
        ? items.map(i => `${this.escapeHTML(formatAmount(i.qty, i.unit))} ${this.escapeHTML(i.name)}`).join(' &bull; ')
        : 'No items saved';
      return `
        <div style="background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:10px 12px; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong style="color:var(--text-main); font-size:0.9rem;">${this.escapeHTML(f.Name)}</strong>
            <div style="font-size:0.75rem; color:var(--text-dim); margin-top:2px;">
              ${summary}
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="btn-primary" style="font-size:0.75rem; padding:4px 10px;" onclick="app.loadFavoriteIntoBuilder('${f.id}')">Load</button>
            <button type="button" class="delete-entry-btn" onclick="app.confirmDeleteFavorite('${f.id}')">✕</button>
          </div>
        </div>
      `;
    }).join('');
  }

  loadFavoriteIntoBuilder(favId) {
    const fav = store.favorites.find(f => f.id === favId);
    if (!fav) return;
    const items = this.favoriteItemsOf(fav);
    if (items.length === 0) {
      this.showToast('That favorite has no usable items saved', 'error');
      return;
    }

    const stamp = Date.now();
    this.dropEmptyBuilderRows();
    const loadedRows = items.map((it, idx) => {
      const ratio = it.qty > 0 && it.baseQty > 0 ? (it.qty / it.baseQty) : 0;
      const scaled = (base, dp) => {
        const v = base * ratio;
        return dp === 0 ? Math.round(v) : Math.round(v * 10) / 10;
      };
      return {
        id: `row-${stamp}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
        name: it.name,
        unit: it.unit,
        baseQty: it.baseQty,
        baseKcal: it.baseKcal,
        baseProt: it.baseProt,
        baseCarb: it.baseCarb,
        baseFat: it.baseFat,
        qty: it.qty,
        // A hand-typed macro comes back exactly as it was saved; everything
        // else is recomputed from the basis, so editing the quantity later
        // scales from the right number.
        kcal: it.overrides.kcal ? Math.round(it.savedKcal) : scaled(it.baseKcal, 0),
        prot: it.overrides.prot ? Math.round(it.savedProt * 10) / 10 : scaled(it.baseProt, 1),
        carb: it.overrides.carb ? Math.round(it.savedCarb * 10) / 10 : scaled(it.baseCarb, 1),
        fat: it.overrides.fat ? Math.round(it.savedFat * 10) / 10 : scaled(it.baseFat, 1),
        overrides: it.overrides
      };
    });
    this.builderRows = this.builderRows.concat(loadedRows);
    this.renderBuilderRows();
    this.closeModal('favorites-modal');
    this.showToast(`Added "${fav.Name}" to Builder`, 'success');
  }

  confirmDeleteFavorite(favId) {
    this.confirmDelete(() => {
      store.deleteFavorite(favId);
      this.openFavoritesModal();
      this.showToast('Favorite removed', 'success');
    }, 'Are you sure you want to remove this favorite combination?');
  }

  // Protein and carbs bring 4 kcal a gram, fat 9: what the three targets
  // add up to, so a calorie target and macros that disagree are caught here
  // rather than in a day that cannot hit both.
  refreshTargetsCheck() {
    const el = document.getElementById('targets-check');
    if (!el) return;
    const v = id => parseFloat((document.getElementById(id) || {}).value) || 0;
    const kcal = v('target-kcal-input');
    const fromMacros = Math.round(v('target-prot-input') * 4 + v('target-carb-input') * 4 + v('target-fat-input') * 9);
    if (!fromMacros) {
      el.textContent = '';
      return;
    }
    const diff = fromMacros - kcal;
    const close = Math.abs(diff) <= Math.max(25, kcal * 0.02);
    el.classList.toggle('ok', close);
    el.textContent = !kcal ? `Your macros add up to ${fromMacros.toLocaleString()} kcal.`
      : close ? `Your macros add up to ${fromMacros.toLocaleString()} kcal - in line with your calorie target.`
      : `Your macros add up to ${fromMacros.toLocaleString()} kcal, ${Math.abs(diff).toLocaleString()} ${diff > 0 ? 'more' : 'less'} than your calorie target.`;
  }

  async handleTargetsSubmit() {
    const kcal = parseInt(document.getElementById('target-kcal-input').value, 10);
    const prot = parseFloat(document.getElementById('target-prot-input').value);
    const carb = parseFloat(document.getElementById('target-carb-input').value);
    const fat = parseFloat(document.getElementById('target-fat-input').value);

    const targetId = store.targets.id || 1;
    store.targets = { id: targetId, kcal, protein: prot, carbs: carb, fat };

    if (store.supabase) {
      try {
        // macro_targets.id is a GENERATED ALWAYS identity column - Postgres
        // rejects any insert/upsert that supplies an explicit id, so this
        // has to be a plain update against the single existing targets row.
        const { error } = await store.supabase
          .from('macro_targets')
          .update({ kcal, protein: prot, carbs: carb, fat })
          .eq('id', targetId);
        if (error) throw error;
      } catch (e) {
        this.showToast(`Could not save targets to cloud: ${e.message || e}`, 'error');
        this.closeModal('targets-modal');
        this.renderAll();
        return;
      }
    }

    this.showToast('Macro targets updated!', 'success');
    this.closeModal('targets-modal');
    this.renderAll();
  }

  async handleWeightSubmit() {
    const dInput = document.getElementById('weight-date-input');
    const wInput = document.getElementById('weight-num-input');
    const bInput = document.getElementById('weight-bf-input');
    if (!dInput || !wInput) return;
    const dateVal = dInput.value;
    const numVal = parseFloat(wInput.value);
    if (!dateVal || isNaN(numVal)) return;
    const bfRaw = bInput ? bInput.value.trim() : '';
    const bfVal = bfRaw === '' ? null : parseFloat(bfRaw);
    if (bfVal !== null && (isNaN(bfVal) || bfVal < 0 || bfVal > 100)) {
      this.showToast('Body fat must be a percentage between 0 and 100', 'error');
      return;
    }

    const newWeight = {
      id: generateUUID(),
      date: dateVal,
      weight: numVal,
      bf: bfVal
    };

    store.weights.push(newWeight);
    store.weights.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const res = await store.writeWeightRow('insert', newWeight.id, newWeight);
    store.saveLocalMirror();

    wInput.value = '';
    if (bInput) bInput.value = '';
    this.renderWeightChart();
    if (res && res.success === false) {
      this.showToast(`Weight not saved to cloud: ${res.error}`, 'error');
    } else if (res && res.bfColumnMissing) {
      this.showToast('Saved, but this database has no bf column yet - body fat was dropped', 'error');
    } else {
      this.showToast(`Logged ${numVal} kg${bfVal !== null ? ` · ${bfVal}% BF` : ''}`, 'success');
    }
  }

  // Pure generic drag logic that always works everywhere for the weight chart
  setupWeightChartDragging(canvas, dataPoints) {
    const wrapper = document.getElementById('weight-chart-wrapper');
    if (!wrapper || !this.weightChart || wrapper._weightDragInitialized) return;
    wrapper._weightDragInitialized = true;
    
    let isDragging = false;
    let startX = 0;
    let initialMinX = 0;
    let initialMaxX = 0;
    let initialTouchDist = 0;
    let initialPinchMin = 0;
    let initialPinchMax = 0;

    const onStart = (x) => {
      if (!this.weightChart) return;
      isDragging = true;
      startX = x;
      wrapper.classList.add('dragging');
      initialMinX = this.weightChart.scales.x.min;
      initialMaxX = this.weightChart.scales.x.max;
    };
    
    const onMove = (x) => {
      if (!isDragging || !this.weightChart) return;
      const deltaPx = x - startX;
      const rect = wrapper.getBoundingClientRect();
      if (rect.width <= 0) return;
      const currentRange = initialMaxX - initialMinX;
      const timeShift = (deltaPx / rect.width) * currentRange;
      this.weightChart.options.scales.x.min = initialMinX - timeShift;
      this.weightChart.options.scales.x.max = initialMaxX - timeShift;
      this.weightChart.update('none');
    };
    
    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      wrapper.classList.remove('dragging');
    };

    wrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.weightChart) return;
      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
      this.zoomWeightChart(zoomFactor);
    }, { passive: false });

    wrapper.ontouchstart = (e) => {
      if (e.touches.length === 2) {
        isDragging = false;
        initialTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (this.weightChart) {
          initialPinchMin = this.weightChart.scales.x.min;
          initialPinchMax = this.weightChart.scales.x.max;
        }
      } else if (e.touches.length === 1) {
        onStart(e.touches[0].clientX);
      }
    };

    wrapper.ontouchmove = (e) => {
      if (e.touches.length === 2 && initialTouchDist > 0 && this.weightChart) {
        const currentDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (currentDist > 5) {
          const pinchFactor = initialTouchDist / currentDist;
          const currentRange = initialPinchMax - initialPinchMin;
          const center = (initialPinchMin + initialPinchMax) / 2;
          const newRange = currentRange * pinchFactor;
          if (newRange >= 12 * 60 * 60 * 1000) {
            this.weightChart.options.scales.x.min = center - newRange / 2;
            this.weightChart.options.scales.x.max = center + newRange / 2;
            this.weightChart.update('none');
          }
        }
      } else if (e.touches.length === 1) {
        onMove(e.touches[0].clientX);
      }
    };

    wrapper.ontouchend = (e) => {
      if (e.touches.length === 0) {
        initialTouchDist = 0;
        onEnd();
      }
    };
    wrapper.ontouchcancel = onEnd;

    wrapper.onmousedown = (e) => { if (e.button === 0) onStart(e.clientX); };
    wrapper.onmousemove = (e) => onMove(e.clientX);
    wrapper.onmouseup = onEnd;
    wrapper.onmouseleave = onEnd;
  }

  zoomWeightChart(factor) {
    if (!this.weightChart) return;
    const scaleX = this.weightChart.scales.x;
    const currentMin = scaleX.min;
    const currentMax = scaleX.max;
    const currentSpan = currentMax - currentMin;
    const center = (currentMin + currentMax) / 2;
    const newSpan = currentSpan * factor;
    this.weightChart.options.scales.x.min = center - newSpan / 2;
    this.weightChart.options.scales.x.max = center + newSpan / 2;
    this.weightChart.update('none');
  }

  resetWeightChartPan() {
    this.renderWeightChart();
    this.showToast('Timeline reset', 'success');
  }

  renderWeightChart() {
    const canvas = document.getElementById('weight-chart-canvas');
    if (!canvas) return;

    const sortedWeights = [...store.weights].sort((a, b) => parseAnyDate(a.date).getTime() - parseAnyDate(b.date).getTime());
    const hasAnyBf = sortedWeights.some(w => w.bf !== null && w.bf !== undefined);

    // Body fat is optional, so its buttons are only worth showing once there is
    // something to plot.
    const modeWrap = document.getElementById('weight-mode-toggle');
    if (modeWrap) {
      modeWrap.style.display = hasAnyBf ? 'flex' : 'none';
      modeWrap.querySelectorAll('.weight-mode-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-mode') === this.weightChartMode);
      });
    }
    if (!hasAnyBf) this.weightChartMode = 'weight';

    const tableEl = document.getElementById('weight-entries-table');
    if (tableEl) {
      const all = [...sortedWeights].reverse();
      const rev = all.slice(0, this.weightVisibleCount);
      const moreHTML = this.listPagerHTML('showMoreWeights', rev.length, all.length);
      tableEl.innerHTML = rev.map(w => `
        <div class="weight-entry-row">
          <span class="weight-entry-date">${this.escapeHTML(this.friendlyDate(w.date))}</span>
          ${(w.bf !== null && w.bf !== undefined)
            ? `<span class="weight-entry-bf">${w.bf}%<span class="bf-suffix"> BF</span></span>`
            : '<span class="weight-entry-bf is-empty"></span>'}
          <strong class="weight-entry-kg">${w.weight} kg</strong>
          <div class="weight-entry-actions">
            <button type="button" class="pill-icon-btn" title="Edit this entry" onclick="app.openEditWeightModal('${w.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button type="button" class="pill-icon-btn danger" title="Delete this entry" onclick="app.confirmDeleteWeight('${w.id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </div>
        </div>
      `).join('') + moreHTML;
    }

    if (this.weightChart) {
      this.weightChart.destroy();
    }

    if (sortedWeights.length === 0) return;

    const mode = this.weightChartMode || 'weight';
    const weightPoints = sortedWeights.map(w => ({ x: parseAnyDate(w.date).getTime(), y: w.weight, rawDate: w.date }));
    const bfPoints = sortedWeights
      .filter(w => w.bf !== null && w.bf !== undefined)
      .map(w => ({ x: parseAnyDate(w.date).getTime(), y: w.bf, rawDate: w.date }));

    // Panning and zooming work off the timeline, which is shared by both series.
    const dataPoints = weightPoints;
    const minTime = dataPoints[0].x;
    const maxTime = dataPoints[dataPoints.length - 1].x;
    const dayMs = 24 * 60 * 60 * 1000;
    const timeSpan = maxTime - minTime;
    const paddingTime = timeSpan > 0 ? Math.max(dayMs, timeSpan * 0.05) : dayMs * 3;

    // Default view shows the most recent three months. Zoom and pan still reach
    // everything either side - this only sets where the window starts.
    const THREE_MONTHS_MS = 92 * dayMs;
    const fullMin = minTime - paddingTime;
    const fullMax = maxTime + paddingTime;
    const viewMax = fullMax;
    const viewMin = (fullMax - fullMin) > THREE_MONTHS_MS
      ? fullMax - THREE_MONTHS_MS
      : fullMin;

    // A padded range around whatever is plotted, so a flat line does not sit on
    // the floor of the chart.
    const rangeFor = (points, pad) => {
      if (points.length === 0) return { min: 0, max: 1 };
      const vals = points.map(p => p.y);
      return {
        min: Math.max(0, Math.floor(Math.min(...vals) - pad)),
        max: Math.ceil(Math.max(...vals) + pad)
      };
    };
    const wRange = rangeFor(weightPoints, 1.5);
    const bRange = rangeFor(bfPoints, 1.5);

    const ctx = canvas.getContext('2d');
    const fillHeight = (canvas.parentElement && canvas.parentElement.clientHeight) || 240;
    const gradient = (rgb) => {
      const g = ctx.createLinearGradient(0, 0, 0, fillHeight);
      g.addColorStop(0, `rgba(${rgb}, 0.30)`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      return g;
    };

    const AMBER = '245, 166, 35';
    const CYAN = '6, 182, 212';

    const lineFor = (label, points, colorRgb, axisId, filled) => ({
      label,
      data: points,
      yAxisID: axisId,
      borderColor: `rgb(${colorRgb})`,
      backgroundColor: filled ? gradient(colorRgb) : 'transparent',
      fill: filled,
      tension: 0.25,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: `rgb(${colorRgb})`,
      pointBorderColor: '#0c0e12',
      pointBorderWidth: 2,
      borderWidth: 2.5,
      spanGaps: true
    });

    const datasets = [];
    const scales = {
      x: {
        type: 'linear',
        min: viewMin,
        max: viewMax,
        ticks: {
          color: '#9ca3af',
          font: { family: 'Inter', size: 10 },
          maxTicksLimit: 6,
          callback: (val) => formatDateDMYShort(new Date(val))
        }
      }
    };

    if (mode === 'bf') {
      datasets.push(lineFor('Body fat (%)', bfPoints, CYAN, 'y', true));
      scales.y = {
        min: bRange.min,
        max: bRange.max,
        ticks: { color: '#9ca3af', font: { family: 'Inter', size: 10 }, callback: (v) => `${v}%` }
      };
    } else if (mode === 'both') {
      // Two axes rather than one: kilograms and percent share no scale, and
      // forcing them onto one would flatten whichever has the smaller range.
      datasets.push(lineFor('Weight (kg)', weightPoints, AMBER, 'y', true));
      datasets.push(lineFor('Body fat (%)', bfPoints, CYAN, 'y1', false));
      scales.y = {
        position: 'left',
        min: wRange.min,
        max: wRange.max,
        ticks: { color: '#f5a623', font: { family: 'Inter', size: 10 }, callback: (v) => `${v} kg` }
      };
      scales.y1 = {
        position: 'right',
        min: bRange.min,
        max: bRange.max,
        grid: { drawOnChartArea: false },
        ticks: { color: '#06b6d4', font: { family: 'Inter', size: 10 }, callback: (v) => `${v}%` }
      };
    } else {
      datasets.push(lineFor('Weight (kg)', weightPoints, AMBER, 'y', true));
      scales.y = {
        min: wRange.min,
        max: wRange.max,
        ticks: { color: '#9ca3af', font: { family: 'Inter', size: 10 }, callback: (v) => `${v} kg` }
      };
    }

    this.weightChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          // With two series the reader needs to know which line is which.
          legend: {
            display: mode === 'both',
            labels: { color: '#9ca3af', boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { family: 'Inter', size: 11 } }
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items || items.length === 0) return '';
                const raw = items[0].raw;
                const d = raw && raw.x ? new Date(raw.x) : new Date();
                return formatDateDMYShort(d);
              },
              label: (item) => {
                const unit = item.dataset.yAxisID === 'y1' || mode === 'bf' ? '%' : ' kg';
                return `${item.dataset.label}: ${item.parsed.y}${unit}`;
              }
            }
          }
        },
        scales
      }
    });

    this.setupWeightChartDragging(canvas, dataPoints);
  }

  setWeightChartMode(mode) {
    this.weightChartMode = mode;
    this.renderWeightChart();
  }

  openEditWeightModal(id) {
    const entry = store.weights.find(w => w.id === id);
    if (!entry) return;
    const set = (elId, v) => {
      const el = document.getElementById(elId);
      if (el) el.value = (v === null || v === undefined) ? '' : v;
    };
    set('edit-weight-id', entry.id);
    // The date input needs ISO; entries can carry either shape.
    const d = parseAnyDate(entry.date);
    set('edit-weight-date', toISODateLocal(d));
    set('edit-weight-kg', entry.weight);
    set('edit-weight-bf', entry.bf);
    this.openModal('edit-weight-modal');
  }

  async handleEditWeightSubmit() {
    const id = document.getElementById('edit-weight-id').value;
    const dateVal = document.getElementById('edit-weight-date').value;
    const kg = parseFloat(document.getElementById('edit-weight-kg').value);
    const bfRaw = document.getElementById('edit-weight-bf').value.trim();
    const bf = bfRaw === '' ? null : parseFloat(bfRaw);

    if (!dateVal || isNaN(kg)) {
      this.showToast('A date and a weight are required', 'error');
      return;
    }
    if (bf !== null && (isNaN(bf) || bf < 0 || bf > 100)) {
      this.showToast('Body fat must be a percentage between 0 and 100', 'error');
      return;
    }

    const res = await store.updateWeight(id, { date: dateVal, weight: kg, bf });
    this.closeModal('edit-weight-modal');
    this.renderWeightChart();
    if (res && res.success === false) {
      this.showToast(`Could not save: ${res.error}`, 'error');
    } else {
      this.showToast('Weight entry updated', 'success');
    }
  }


  confirmDeleteWeight(wtId) {
    this.confirmDelete(() => {
      store.deleteWeight(wtId);
      this.renderWeightChart();
      this.showToast('Weight entry removed', 'success');
    }, 'Are you sure you want to delete this weight log entry?');
  }

  async triggerCloudSync() {
    await store.fetchCloudData();
    this.showToast(store.syncState === 'error' ? 'Could not sync - see the details' : 'Synced', store.syncState === 'error' ? 'error' : 'success');
  }

  // The sync dialog in words: the state the header dot is showing, who is
  // signed in and when the data last came down. The sign-in form only
  // shows while signed out.
  refreshSyncDialog() {
    const modal = document.getElementById('auth-login-modal');
    if (!modal || !modal.classList.contains('active')) return;
    const state = store.syncState || (navigator.onLine ? 'synced' : 'offline');
    const signedIn = !!(store.session && store.session.active);
    const dot = document.getElementById('modal-sync-dot');
    const title = document.getElementById('modal-sync-title');
    const sub = document.getElementById('modal-sync-subtitle');
    const form = document.getElementById('supabase-auth-form');
    const syncBtn = document.getElementById('modal-sync-now-btn');
    const colour = { synced: 'var(--success)', syncing: 'var(--accent)', offline: 'var(--text-muted)', error: 'var(--danger)' }[state] || 'var(--success)';
    if (dot) {
      dot.style.background = colour;
      dot.style.boxShadow = `0 0 6px ${colour}`;
    }
    if (title) {
      title.textContent = !signedIn ? 'Not signed in'
        : state === 'syncing' ? 'Syncing…'
        : state === 'offline' ? "You're offline"
        : state === 'error' ? 'Sync problem'
        : 'Everything is synced';
    }
    if (sub) {
      const parts = [];
      if (signedIn && store.session.email) parts.push(`Signed in as ${store.session.email}`);
      if (state === 'offline') parts.push('What you log stays on this device and syncs when you reconnect.');
      if (state === 'error' && store.syncError) parts.push(store.syncError);
      if (store.lastSyncedAt && state !== 'syncing') {
        parts.push(`Last synced at ${new Date(store.lastSyncedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
      }
      if (!signedIn) parts.push('Sign in to sync your data across devices.');
      sub.textContent = parts.join(' · ');
    }
    if (form) form.hidden = signedIn;
    if (syncBtn) syncBtn.hidden = !signedIn;
  }

  async handleModalSignUp() {
    const email = (document.getElementById('auth-email-input').value || '').trim();
    const password = document.getElementById('auth-password-input').value;
    if (!password || password.length < 6) {
      this.showToast('Password must have at least 6 characters.', 'error');
      return;
    }
    const res = await store.signUp(email, password);
    if (res.error) {
      this.showToast(`Supabase: ${res.error.message}`, 'error');
    } else if (store.session.active) {
      this.checkAuth();
      this.showToast(`Account created & synced!`, 'success');
      this.closeModal('auth-login-modal');
    } else {
      this.showToast('Account created! Check your email to confirm it, then sign in.', 'success');
      this.closeModal('auth-login-modal');
    }
  }

  saveCustomSupabaseConfig() {
    const urlInput = document.getElementById('config-supabase-url');
    const keyInput = document.getElementById('config-supabase-key');
    if (!urlInput || !keyInput) return;
    const url = urlInput.value.trim();
    const key = keyInput.value.trim();
    if (!url || !key) {
      this.showToast('Please provide both URL and Key', 'error');
      return;
    }
    CONFIG.SUPABASE_URL = url;
    CONFIG.SUPABASE_ANON_KEY = key;
    store.initSupabase();
    this.showToast('Supabase config updated!', 'success');
  }

  async testSupabaseConnection() {
    const resultsContainer = document.getElementById('supabase-diagnostics-results');
    const dot = document.getElementById('modal-sync-dot');
    const title = document.getElementById('modal-sync-title');
    if (resultsContainer) {
      resultsContainer.style.display = 'flex';
      resultsContainer.innerHTML = '<span style="color:var(--text-muted);">Testing live access to tables...</span>';
    }
    if (!store.supabase) {
      if (resultsContainer) resultsContainer.innerHTML = '<span style="color:var(--danger);">Supabase client not initialized</span>';
      return;
    }
    const tables = ['macro_daily_logs', 'macro_weight_tracker', 'macro_targets', 'macro_food_database', 'macro_tracker_favorites'];
    let html = '';
    let hasError = false;
    for (const table of tables) {
      try {
        const { data, error } = await store.supabase.from(table).select('*').limit(1);
        if (error) {
          hasError = true;
          html += `<div style="display:flex; justify-content:space-between; color:var(--danger);"><span><code>${table}</code></span><span>${error.message}</span></div>`;
        } else {
          html += `<div style="display:flex; justify-content:space-between; color:var(--success);"><span><code>${table}</code></span><span>Accessible (${data ? data.length : 0} rows probed)</span></div>`;
        }
      } catch (err) {
        hasError = true;
        html += `<div style="display:flex; justify-content:space-between; color:var(--danger);"><span><code>${table}</code></span><span>Error</span></div>`;
      }
    }
    if (resultsContainer) resultsContainer.innerHTML = html;
    if (dot) dot.style.background = hasError ? 'var(--danger)' : 'var(--success)';
    if (title) title.textContent = hasError ? 'Supabase Notice' : 'Supabase Connected & Verified';
  }

  openModal(modalId) {
    if (modalId === 'targets-modal') {
      document.getElementById('target-kcal-input').value = store.targets.kcal;
      document.getElementById('target-prot-input').value = store.targets.protein;
      document.getElementById('target-carb-input').value = store.targets.carbs;
      document.getElementById('target-fat-input').value = store.targets.fat;
      this.refreshTargetsCheck();
    }
    if (modalId === 'favorites-modal') {
      this.openFavoritesModal();
    }
    if (modalId === 'auth-login-modal') {
      const urlIn = document.getElementById('config-supabase-url');
      const keyIn = document.getElementById('config-supabase-key');
      const urlDisp = document.getElementById('modal-project-url-display');
      if (urlIn) urlIn.value = CONFIG.SUPABASE_URL;
      if (keyIn) keyIn.value = CONFIG.SUPABASE_ANON_KEY;
      if (urlDisp) urlDisp.textContent = CONFIG.SUPABASE_URL.replace('https://', '');
    }
    const m = document.getElementById(modalId);
    if (m) {
      m.classList.add('active');
      if (modalId === 'auth-login-modal') this.refreshSyncDialog();
      // Drop anything that was closed behind our back, so the depth below
      // is an honest count of what is actually on screen.
      this.getTopModal();
      this.modalStack = this.modalStack.filter(id => id !== modalId);
      this.modalStack.push(modalId);
      // Every overlay shares one z-index in the stylesheet, so a dialog
      // opened from another dialog was painting behind whichever sits later
      // in the document - the delete confirmation was there, just buried.
      m.style.zIndex = String(1000 + this.modalStack.length * 10);
      // Remember where focus was so it can be handed back on close, and move it
      // into the dialog so a keyboard user is not stranded behind the overlay.
      if (this.modalStack.length === 1) {
        this.focusBeforeModal = document.activeElement;
      }
      setTimeout(() => {
        const box = m.querySelector('.modal-box');
        const items = this.focusablesIn(box);
        // data-no-autofocus keeps a text field from being focused on open.
        // On a phone that would raise the software keyboard over a dialog
        // whose point is the camera preview behind it.
        const target = items.find(n =>
          !n.hasAttribute('data-modal-close') && !n.hasAttribute('data-no-autofocus')
        ) || items[0] || box;
        if (target && target.focus) {
          try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
        }
      }, 30);
    }
    this.syncBodyScrollLock();
    this.syncModalHistory();
  }

  // Locks the page behind any open dialog, so scrolling a modal does not drag
  // the page underneath it.
  syncBodyScrollLock() {
    const anyOpen = !!document.querySelector('.modal-overlay.active');
    document.body.classList.toggle('modal-open', anyOpen);
  }

  // Everything focusable inside a dialog, in tab order.
  focusablesIn(el) {
    if (!el) return [];
    const sel = [
      'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    return [...el.querySelectorAll(sel)].filter(n => n.offsetParent !== null || n === document.activeElement);
  }

  // Tab must not wander onto the page behind an open dialog.
  handleModalTab(e) {
    if (e.key !== 'Tab') return;
    const top = this.getTopModal();
    if (!top) return;
    const box = document.querySelector(`#${top} .modal-box`);
    const items = this.focusablesIn(box);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const inside = box.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  // The dialog on top, with anything that was closed behind our back dropped
  // from the stack first.
  getTopModal() {
    this.modalStack = this.modalStack.filter(id => {
      const el = document.getElementById(id);
      return el && el.classList.contains('active');
    });
    return this.modalStack[this.modalStack.length - 1] || null;
  }

  // Keeps exactly one history entry alive for as long as any dialog is open.
  // Deferred by a tick on purpose: flows that close one dialog and open the
  // next in the same breath would otherwise push and pop against each other.
  syncModalHistory() {
    clearTimeout(this.modalHistoryTimer);
    this.modalHistoryTimer = setTimeout(() => {
      const wanted = this.getTopModal() ? 1 : 0;
      if (wanted === this.modalHistoryGuard) return;
      if (wanted === 1) {
        this.modalHistoryGuard = 1;
        try {
          history.pushState({ macroModal: true }, '');
        } catch (err) {
          this.modalHistoryGuard = 0;
        }
        return;
      }
      // Dialog closed from within the app - take our own entry back off the
      // stack so the next back press is a real one.
      this.modalHistoryGuard = 0;
      this.ignoreNextPop = true;
      clearTimeout(this.ignorePopTimer);
      // If the event never arrives, do not go on swallowing a genuine back.
      this.ignorePopTimer = setTimeout(() => { this.ignoreNextPop = false; }, 500);
      try {
        history.back();
      } catch (err) {
        this.ignoreNextPop = false;
      }
    }, 0);
  }

  handleHistoryPop() {
    if (this.ignoreNextPop) {
      this.ignoreNextPop = false;
      clearTimeout(this.ignorePopTimer);
      return;
    }
    const top = this.getTopModal();
    if (!top) return;
    // The entry just popped was our guard, so it is already gone. closeModal
    // pushes a fresh one if another dialog is still open underneath.
    this.modalHistoryGuard = 0;
    this.closeModal(top);
  }

  closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) {
      m.classList.remove('active');
      m.style.zIndex = '';
    }
    this.modalStack = this.modalStack.filter(id => id !== modalId);
    if (modalId === 'barcode-scanner-modal') this.stopBarcodeCamera();
    if (modalId === 'voice-log-modal') this.stopVoiceCapture();
    this.syncBodyScrollLock();
    this.syncModalHistory();
    this.restoreFocusAfterModals();
    this.flushPendingRender();
  }

  // Once the last dialog is gone, focus belongs back on whatever opened it.
  restoreFocusAfterModals() {
    if (this.getTopModal()) return;
    const el = this.focusBeforeModal;
    this.focusBeforeModal = null;
    if (el && el.focus && document.contains(el)) {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    }
  }

  closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => {
      m.classList.remove('active');
      m.style.zIndex = '';
    });
    // Covers the X button and backdrop clicks, which both route through here.
    this.stopBarcodeCamera();
    this.stopVoiceCapture();
    this.pendingDeleteCallback = null;
    this.modalStack = [];
    this.syncBodyScrollLock();
    this.syncModalHistory();
    this.restoreFocusAfterModals();
    this.flushPendingRender();
  }

  // Apply any repaint that arrived from the cloud while a dialog was open.
  flushPendingRender() {
    if (this.pendingRender && !document.querySelector('.modal-overlay.active')) {
      this.renderAll();
    }
  }

  showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 200);
    }, 2800);
  }

  escapeHTML(str) {
    if (!str) return '';
    return str.toString().replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }
}

const app = new MacroApp();
window.app = app;
document.addEventListener('DOMContentLoaded', () => {
  // init() re-runs checkAuth()/renderAll() against the now-built DOM, which
  // also covers the case where initSupabase() resolved before this fired.
  app.init();
});

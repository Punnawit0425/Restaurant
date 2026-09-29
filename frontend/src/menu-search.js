// ค้นหาเมนู — the forgiving search behind the staff รับออเดอร์ tab.
//
// The rule it exists to keep: however you type it, you find it. Staff key
// dishes one-handed on a tablet mid-service, so a search that only matches an
// exact substring of the Thai name is a search that fails all night. Every
// query and every menu field therefore goes through the SAME normalisation —
// tone marks, sara marks, spaces and punctuation removed — before anything is
// compared, so "ข้าวผัด", "ขาวผด" and "khao pad" all land on the same dish.
//
// It searches the WHOLE menu: day and night, food and drink, no category
// needed. Ranking (not filtering) is what keeps the good match on top.

// Thai marks that ride above/below a consonant: mai han akat, the sara
// i/ii/ue/uue/u/uu group, and the tone marks + thanthakhat + nikhahit. None of
// them survive normalisation, so a mistyped tone can never hide a dish.
const THAI_MARKS = /[ัิ-ฺ็-๎]/g;
// ๆ (repeat) and ฯ (abbreviation) are typed inconsistently — dropped as well.
const THAI_SIGNS = /[ฯๆ]/g;

// One string, stripped down to the letters and digits that actually identify
// it. Latin accents go through NFD; Thai marks are removed outright.
export function normalizeSearch(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // é -> e
    .normalize('NFC')
    .toLowerCase()
    .replace(THAI_MARKS, '')
    .replace(THAI_SIGNS, '')
    .replace(/[^\p{L}\p{N}]+/gu, ''); // spaces, dashes, brackets, emoji
}

// A query split into words, each normalised. Words are matched independently
// and in any order, so "ผัด ทะเล" finds ผัดซีอิ๊ว(ทะเล) even though the menu
// never writes those two next to each other.
export function searchTerms(query) {
  return String(query || '')
    .trim()
    .split(/\s+/)
    .map(normalizeSearch)
    .filter(Boolean);
}

// Words that make a shift or a group searchable by what staff call it out
// loud — typing "กลางคืน" or "เครื่องดื่ม" should narrow the list.
const SHIFT_WORDS = {
  day: 'กลางวัน day เช้า กลางวัน',
  night: 'กลางคืน night เย็น ดึก เรือนเก่า',
  both: 'กลางวัน กลางคืน ทุกช่วง both',
};
const GROUP_WORDS = {
  food: 'อาหาร ของกิน food',
  drink: 'เครื่องดื่ม ดื่ม น้ำ drink',
};

// Human labels for the same two axes, reused by the UI badges so the words you
// can search for are the words you can see.
export const SHIFT_LABELS = { day: 'กลางวัน', night: 'กลางคืน', both: 'ทุกช่วง' };
export const GROUP_LABELS = { food: 'อาหาร', drink: 'เครื่องดื่ม' };

// Normalised copies of one dish's searchable fields. Cached per menu object:
// the menu array is replaced wholesale on every sync, so a WeakMap entry dies
// with the item it describes.
const fieldCache = new WeakMap();

function fieldsFor(item) {
  const hit = fieldCache.get(item);
  if (hit) return hit;
  const options = (item.options || []).map((o) =>
    normalizeSearch(`${o.name || ''} ${o.nameEn || ''}`)
  );
  const fields = {
    name: normalizeSearch(item.name),
    nameEn: normalizeSearch(item.nameEn),
    options,
    category: normalizeSearch(`${item.category || ''} ${item.categoryEn || ''}`),
    // Everything else worth a low-confidence hit: the shift, the group, the
    // description, and the prices (typing "70" pulls up the ฿70 dishes).
    extra: normalizeSearch(
      [
        item.desc,
        SHIFT_WORDS[item.theme] || '',
        GROUP_WORDS[item.group] || '',
        item.price,
        ...(item.options || []).map((o) => o.price),
      ].join(' ')
    ),
  };
  fieldCache.set(item, fields);
  return fields;
}

// Do the characters of `term` appear in `text` in order? The last-resort pass:
// it forgives a dropped or swapped letter ("กระเพา" -> "กระเพรา") when nothing
// stricter matched at all.
function isSubsequence(term, text) {
  if (term.length < 2) return false;
  let i = 0;
  for (let j = 0; j < text.length && i < term.length; j++) {
    if (text[j] === term[i]) i++;
  }
  return i === term.length;
}

// How well one word matches one dish. Higher = more confident; 0 = no match.
// The tiers are what keeps a name hit above a "the price contains 70" hit.
function scoreTerm(term, f) {
  if (f.name === term) return 100;
  if (f.name.startsWith(term)) return 80;
  if (f.name.includes(term)) return 60;
  if (f.nameEn.startsWith(term)) return 46;
  if (f.nameEn.includes(term)) return 40;
  if (f.options.some((o) => o.includes(term))) return 30;
  if (f.category.includes(term)) return 20;
  if (f.extra.includes(term)) return 10;
  return 0;
}

// Subsequence forgives characters the typist LEFT OUT. Dropping one character
// from the term first also forgives one they added or got wrong — which is the
// common Thai slip: กะเพรา typed as กระเพา.
function looseHit(term, text) {
  if (!text) return false;
  if (isSubsequence(term, text)) return true;
  if (term.length < 4) return false;
  for (let i = 0; i < term.length; i++) {
    if (isSubsequence(term.slice(0, i) + term.slice(i + 1), text)) return true;
  }
  return false;
}

// Same tiering as scoreTerm, but allowing dropped/typo'd characters. Only
// consulted once the strict passes have come up empty for the whole menu.
function fuzzyScoreTerm(term, f) {
  if (looseHit(term, f.name)) return 8;
  if (looseHit(term, f.nameEn)) return 6;
  if (f.options.some((o) => looseHit(term, o))) return 4;
  if (looseHit(term, f.category)) return 3;
  return 0;
}

function rank(menu, terms, score, requireAll) {
  const out = [];
  for (const item of menu) {
    const f = fieldsFor(item);
    let total = 0;
    let matched = 0;
    for (const term of terms) {
      const s = score(term, f);
      if (s) {
        total += s;
        matched++;
      } else if (requireAll) {
        total = 0;
        break;
      }
    }
    if (matched && total) out.push({ item, score: total, matched });
  }
  out.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      (b.item.available ? 1 : 0) - (a.item.available ? 1 : 0) ||
      String(a.item.name).localeCompare(String(b.item.name), 'th')
  );
  return out.map((r) => r.item);
}

// Shorten each word to the longest prefix that still matches something on the
// menu. Thai runs words together — "เบียร์ช้าง" is typed as one word but named
// as two — so cutting from the end is what turns a dead query into "here is
// every เบียร์". Words that match nothing even at two characters are dropped.
function prefixTerms(menu, terms) {
  const kept = [];
  for (const term of terms) {
    for (let len = term.length - 1; len >= 2; len--) {
      const prefix = term.slice(0, len);
      if (menu.some((item) => scoreTerm(prefix, fieldsFor(item)))) {
        kept.push(prefix);
        break;
      }
    }
  }
  return kept;
}

// The whole search, best matches first. Each pass is looser than the last, so
// a query that would have returned an empty list still returns the dishes it
// plausibly meant:
//   1. every word matches (the precise answer),
//   2. any word matches (a word was misremembered or extra),
//   3. characters-in-order (a letter was dropped, added or mistyped),
//   4. the start of each word matches (two names typed as one, or a suffix
//      the menu spells differently).
export function searchMenu(menu, query) {
  const terms = searchTerms(query);
  if (!terms.length || !Array.isArray(menu)) return [];

  const strict = rank(menu, terms, scoreTerm, true);
  if (strict.length) return strict;

  if (terms.length > 1) {
    const loose = rank(menu, terms, scoreTerm, false);
    if (loose.length) return loose;
  }

  const fuzzy = rank(menu, terms, fuzzyScoreTerm, false);
  if (fuzzy.length) return fuzzy;

  const prefixes = prefixTerms(menu, terms);
  return prefixes.length ? rank(menu, prefixes, scoreTerm, false) : [];
}

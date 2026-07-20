let pullsPerPatch = [];
let banners = [];
let standardBanner = null;
let luna5Index = -1;
let patch2Index = -1;

const STANDARD_CURVE = { hardPity5: 90, softPityStart5: 74, base5: 0.006 };
const WEAPON_CURVE = { hardPity5: 80, softPityStart5: 63, base5: 0.007 };

const state = {
  patchIndex: 0,
  phase: 1,
  limitedWishes: 0,
  standardWishes: 0,
  pity: {
    character: { pity5: 0, pity4: 0, crCounter: 0, guaranteed: false },
    weapon: { pity5: 0, pity4: 0, fatePoint: 0 },
    chronicled: { pity5: 0, pity4: 0, fatePoint: 0 },
    standard: { pity5: 0, pity4: 0 },
  },
  chosenTarget: { weapon: null, chronicled: null },
  lastBannerKey: { weapon: null, chronicled: null },
  lastResults: {},
  history: { character: [], weapon: [], chronicled: [], standard: [] },
  inventory: { character: {}, weapon: {} },
  historyTab: "character",
  stats: {
    character5050: { won: 0, lost: 0, capturingRadiance: 0 },
    weaponFate: { 0: 0, 1: 0, 2: 0 },
  },
  confirmNextPatch: false,
  spendingTier: "f2p",
};

const STARGLITTER_TO_WISH = 1 / 5; // Paimon's Bargains: 5 Masterless Starglitter = 1 Intertwined Fate

function starglitterAmount(itemType, rarity, constellationMaxed) {
  if (itemType === "weapon") return rarity === 5 ? 10 : 2;
  return constellationMaxed ? (rarity === 5 ? 25 : 5) : rarity === 5 ? 10 : 2;
}

// Welkin bonus assumes a standard 6-week patch; 2.6 ran 3 weeks longer and
// 3.0/3.1/3.2 each ran 1 week shorter, so their bonus scales accordingly.
const WELKIN_BASE_BONUS = 26.25;
const WELKIN_BONUS_OVERRIDES = { "2.6": 39.375, "3.0": 21.875, "3.1": 21.875, "3.2": 21.875 };
const BATTLE_PASS_BONUS = 8.25;

function welkinBonusForPatch(patchLabel) {
  if (state.spendingTier === "f2p") return 0;
  const base = WELKIN_BONUS_OVERRIDES[patchLabel] ?? WELKIN_BASE_BONUS;
  return state.spendingTier === "welkin_bp" ? base + BATTLE_PASS_BONUS : base;
}

let nameTypeMap = {};

function buildNameTypeMap() {
  const map = {};
  const addAll = (names, type) => {
    for (const n of names) map[n] = type;
  };
  addAll(standardBanner.character.initial.five_star, "character");
  addAll(standardBanner.character.initial.four_star, "character");
  for (const addition of standardBanner.character.additions) {
    addAll(addition.five_star, "character");
    addAll(addition.four_star, "character");
  }
  addAll(standardBanner.weapon.initial.five_star, "weapon");
  addAll(standardBanner.weapon.initial.four_star, "weapon");
  for (const addition of standardBanner.weapon.additions) {
    addAll(addition.five_star, "weapon");
    addAll(addition.four_star, "weapon");
  }
  // Chronicled banners mix characters and weapons in one pool with no per-unit type tag, and
  // many chronicled 5-stars are limited units never added to the standard banner. But every
  // character/weapon has appeared on its own dedicated character/weapon banner at some point,
  // so scanning those gives a complete roster to classify chronicled units against.
  for (const bannerEntry of banners) {
    if (bannerEntry.banner_type === "character") {
      addAll(bannerEntry.five_star.map((u) => u.name), "character");
      addAll(bannerEntry.four_star.map((u) => u.name), "character");
    } else if (bannerEntry.banner_type === "weapon") {
      addAll(bannerEntry.five_star.map((u) => u.name), "weapon");
      addAll(bannerEntry.four_star.map((u) => u.name), "weapon");
    }
  }
  return map;
}

function classifyItemType(trackKind, result) {
  if (result.rarity === 3) return "weapon"; // 3-star items are always weapons, regardless of source banner
  if (result.rarity === 4) {
    // The off-banner 4-star pool (character AND weapon banners) mixes standard characters and
    // standard weapons, so trackKind alone can't tell us the type — look the name up directly.
    return nameTypeMap[result.name] ?? (trackKind === "weapon" ? "weapon" : "character");
  }
  // rarity === 5
  if (trackKind === "character") return "character";
  if (trackKind === "weapon") return "weapon";
  if (trackKind === "chronicled") return nameTypeMap[result.name] ?? "character"; // chronicled 5-stars mix characters and weapons
  // standard track 5-star: always present in nameTypeMap since it's drawn from the standard pool
  return nameTypeMap[result.name] ?? "character";
}

async function loadData() {
  const [pullsRes, bannersRes, standardRes] = await Promise.all([
    fetch("data/pulls_per_patch.json"),
    fetch("data/banners.json"),
    fetch("data/standard_banner.json"),
  ]);
  pullsPerPatch = await pullsRes.json();
  banners = await bannersRes.json();
  standardBanner = await standardRes.json();
}

function currentPatch() {
  return pullsPerPatch[state.patchIndex].patch;
}

function entriesForPatch(patch) {
  return banners.filter((b) => b.patch === patch);
}

function maxPhaseForPatch(patch) {
  return entriesForPatch(patch).reduce((max, b) => Math.max(max, b.phase), 0);
}

const BANNER_TITLES = {
  character: "Character Event Wish",
  weapon: "Weapon Event Wish",
  chronicled: "Chronicled Wish",
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fiveStarChance(pity5, curve) {
  if (pity5 >= curve.hardPity5) return 1;
  if (pity5 < curve.softPityStart5) return curve.base5;
  const rampSteps = curve.hardPity5 - curve.softPityStart5;
  const increment = 0.96 / rampSteps;
  const rampIndex = pity5 - curve.softPityStart5 + 1;
  return Math.min(0.99, increment * rampIndex);
}

function fourStarChance(pity4, base4) {
  if (pity4 >= 10) return 1;
  if (pity4 === 9) return 0.5;
  return base4;
}

function rollRarity(pity, curve, base4) {
  pity.pity5 += 1;
  pity.pity4 += 1;
  const p5 = fiveStarChance(pity.pity5, curve);
  if (Math.random() < p5) {
    const pullsAtHit = pity.pity5;
    pity.pity5 = 0;
    pity.pity4 = 0;
    return { rarity: 5, pullsAtHit };
  }
  const p4 = fourStarChance(pity.pity4, base4);
  if (Math.random() < p4) {
    const pullsAtHit = pity.pity4;
    pity.pity4 = 0;
    return { rarity: 4, pullsAtHit };
  }
  return { rarity: 3, pullsAtHit: null };
}

function computeStandardPool(kind) {
  const base = standardBanner[kind];
  const five = [...base.initial.five_star];
  const four = [...base.initial.four_star];
  for (const addition of base.additions) {
    const idx = pullsPerPatch.findIndex((p) => p.patch === addition.patch);
    if (idx !== -1 && idx <= state.patchIndex) {
      five.push(...addition.five_star);
      four.push(...addition.four_star);
    }
  }
  return { five_star: five, four_star: four };
}

function combinedStandardPool() {
  const char = computeStandardPool("character");
  const weap = computeStandardPool("weapon");
  return {
    five_star: [...char.five_star, ...weap.five_star],
    four_star: [...char.four_star, ...weap.four_star],
  };
}

const OFF_BANNER_FOUR_STAR_EXCLUDED = ["Amber", "Kaeya", "Lisa"];

function offBannerFourStarPool() {
  const charFour = computeStandardPool("character").four_star.filter(
    (name) => !OFF_BANNER_FOUR_STAR_EXCLUDED.includes(name)
  );
  const weaponFour = computeStandardPool("weapon").four_star;
  return [...charFour, ...weaponFour];
}

function resolveFourStarSplit(entry, rarity, pullsAtHit) {
  if (rarity === 3) return { name: "3★ Weapon", rarity: 3 };
  if (Math.random() < 0.5) {
    const picked = pickRandom(entry.four_star);
    return { name: picked.name, rarity: 4, pityAtPull: pullsAtHit };
  }
  return { name: pickRandom(offBannerFourStarPool()), rarity: 4, pityAtPull: pullsAtHit };
}

function resolveCharacterPull(entry) {
  const pity = state.pity.character;
  const postCR = luna5Index !== -1 && state.patchIndex >= luna5Index;
  const { rarity, pullsAtHit } = rollRarity(pity, STANDARD_CURVE, 0.051);
  if (rarity === 5) {
    let win;
    let statCategory = null; // null = not a genuine coin toss, don't tally won/lost/CR for it
    let isCRWin = false;

    if (pity.guaranteed) {
      // The classic guarantee: after ANY loss, the very next 5-star is always the featured one —
      // this is not a coin toss, so it doesn't touch crCounter or the won/lost/CR stats.
      win = true;
      pity.guaranteed = false;
    } else {
      const counter = pity.crCounter;
      if (postCR && counter === 2) {
        // Still a genuine 50/50 — Capturing Radiance only adds a 10% save chance *within* the
        // "not won" half (5% overall), it doesn't replace the coin toss.
        const wonDirect = Math.random() < 0.5;
        if (wonDirect) {
          win = true;
          statCategory = "won";
          pity.crCounter = 1;
        } else {
          const crSave = Math.random() < 0.1;
          win = crSave;
          if (crSave) {
            isCRWin = true;
            statCategory = "capturingRadiance";
            pity.crCounter = 1;
          } else {
            statCategory = "lost";
            pity.crCounter = 3;
          }
        }
      } else if (postCR && counter >= 3) {
        win = true;
        isCRWin = true;
        statCategory = "capturingRadiance";
        pity.crCounter = 1;
      } else {
        win = Math.random() < 0.5;
        statCategory = win ? "won" : "lost";
        // Capturing Radiance doesn't exist before 5.0, so the streak only starts accumulating
        // once it's live -- pre-5.0 losses never should, and never do, feed into it.
        if (postCR) pity.crCounter = win ? 0 : counter + 1;
      }
      if (!win) pity.guaranteed = true;
    }

    if (statCategory) state.stats.character5050[statCategory] += 1;

    if (win) {
      const picked = pickRandom(entry.five_star);
      return { name: picked.name, rarity: 5, capturingRadiance: isCRWin, pityAtPull: pullsAtHit };
    }
    const pool = computeStandardPool("character").five_star;
    return { name: pickRandom(pool), rarity: 5, pityAtPull: pullsAtHit };
  }
  return resolveFourStarSplit(entry, rarity, pullsAtHit);
}

function resolveWeaponPullPlain(entry) {
  // Pre-2.0: no Epitomized Path yet — plain split among featured weapons, no target/fate point.
  const roll = Math.random();
  const chosenThreshold = entry.five_star.length > 1 ? 0.375 : 0.75;
  if (roll < chosenThreshold) {
    return { name: entry.five_star[0].name, rarity: 5 };
  }
  if (entry.five_star.length > 1 && roll < 0.75) {
    return { name: entry.five_star[1].name, rarity: 5 };
  }
  const pool = computeStandardPool("weapon").five_star;
  return { name: pickRandom(pool), rarity: 5 };
}

function resolveWeaponPull(entry) {
  const pity = state.pity.weapon;
  const { rarity, pullsAtHit } = rollRarity(pity, WEAPON_CURVE, 0.06);
  if (rarity === 5) {
    if (!isEpitomizedPathActive()) {
      return { ...resolveWeaponPullPlain(entry), pityAtPull: pullsAtHit };
    }
    const threshold = fatePointThreshold();
    state.stats.weaponFate[pity.fatePoint] += 1;
    const target = state.chosenTarget.weapon ?? entry.five_star[0].name;
    if (pity.fatePoint >= threshold) {
      pity.fatePoint = 0;
      return { name: target, rarity: 5, pityAtPull: pullsAtHit };
    }
    const others = entry.five_star.filter((w) => w.name !== target);
    const roll = Math.random();
    const chosenThreshold = others.length ? 0.375 : 0.75;
    if (roll < chosenThreshold) {
      pity.fatePoint = 0;
      return { name: target, rarity: 5, pityAtPull: pullsAtHit };
    }
    if (others.length && roll < 0.75) {
      pity.fatePoint = Math.min(pity.fatePoint + 1, threshold);
      const picked = pickRandom(others);
      return { name: picked.name, rarity: 5, pityAtPull: pullsAtHit };
    }
    pity.fatePoint = Math.min(pity.fatePoint + 1, threshold);
    const pool = computeStandardPool("weapon").five_star;
    return { name: pickRandom(pool), rarity: 5, pityAtPull: pullsAtHit };
  }
  return resolveFourStarSplit(entry, rarity, pullsAtHit);
}

function resolveChronicledPull(entry) {
  const pity = state.pity.chronicled;
  const { rarity, pullsAtHit } = rollRarity(pity, STANDARD_CURVE, 0.051);
  if (rarity === 5) {
    const threshold = CHRONICLED_FATE_THRESHOLD;
    const target = state.chosenTarget.chronicled ?? entry.five_star[0].name;
    if (pity.fatePoint >= threshold) {
      pity.fatePoint = 0;
      return { name: target, rarity: 5, pityAtPull: pullsAtHit };
    }
    // Losing your 50/50 can only give you another unit of the SAME type as your chosen
    // target (character stays within the chronicled banner's characters, weapon stays within
    // its weapons) -- it never crosses over to the other type.
    const targetType = nameTypeMap[target] ?? "character";
    const others = entry.five_star.filter(
      (u) => u.name !== target && (nameTypeMap[u.name] ?? "character") === targetType
    );
    if (Math.random() < 0.5 || others.length === 0) {
      pity.fatePoint = 0;
      return { name: target, rarity: 5, pityAtPull: pullsAtHit };
    }
    pity.fatePoint = Math.min(pity.fatePoint + 1, threshold);
    const picked = pickRandom(others);
    return { name: picked.name, rarity: 5, pityAtPull: pullsAtHit };
  }
  if (rarity === 4) {
    const picked = pickRandom(entry.four_star);
    return { name: picked.name, rarity: 4, pityAtPull: pullsAtHit };
  }
  return { name: "3★ Weapon", rarity: 3 };
}

function resolveStandardPull() {
  const pity = state.pity.standard;
  const { rarity, pullsAtHit } = rollRarity(pity, STANDARD_CURVE, 0.051);
  if (rarity === 3) return { name: "3★ Weapon", rarity: 3 };
  const pool = combinedStandardPool();
  const list = rarity === 5 ? pool.five_star : pool.four_star;
  return { name: pickRandom(list), rarity, pityAtPull: pullsAtHit };
}

function bannerKey(entry) {
  return entry.five_star
    .map((u) => u.name)
    .sort()
    .join("|");
}

function entryKey(entry) {
  return `${entry.patch}|${entry.phase}|${entry.banner_type}|${bannerKey(entry)}`;
}

function isEpitomizedPathActive() {
  return patch2Index !== -1 && state.patchIndex >= patch2Index;
}

function fatePointThreshold() {
  return luna5Index !== -1 && state.patchIndex >= luna5Index ? 1 : 2;
}

// Chronicled Wish's Fate Point has always been 1, unlike Epitomized Path (weapon banner),
// which required 2 before 5.0 and dropped to 1 only from 5.0 onward.
const CHRONICLED_FATE_THRESHOLD = 1;

function ensureBannerContext(trackKind, entry) {
  const key = bannerKey(entry);
  if (state.lastBannerKey[trackKind] !== key) {
    state.lastBannerKey[trackKind] = key;
    state.pity[trackKind].fatePoint = 0;
    state.chosenTarget[trackKind] = entry.five_star[0]?.name ?? null;
  }
}

function doWish(entry, trackKind, count) {
  const currencyKey = trackKind === "standard" ? "standardWishes" : "limitedWishes";
  const available = Math.floor(state[currencyKey]);
  const actualCount = Math.min(count, available);
  if (actualCount <= 0) return;

  const results = [];
  for (let i = 0; i < actualCount; i++) {
    state[currencyKey] -= 1;
    let result;
    if (trackKind === "character") result = resolveCharacterPull(entry);
    else if (trackKind === "weapon") result = resolveWeaponPull(entry);
    else if (trackKind === "chronicled") result = resolveChronicledPull(entry);
    else result = resolveStandardPull();
    results.push(result);

    state.history[trackKind].push({
      name: result.name,
      rarity: result.rarity,
      patch: currentPatch(),
      phase: state.phase,
      capturingRadiance: !!result.capturingRadiance,
      pityAtPull: result.pityAtPull ?? null,
    });

    if (result.rarity !== 3) {
      const itemType = classifyItemType(trackKind, result);
      if (itemType === "weapon") {
        // Every weapon copy (even the first) converts straight to Starglitter -> wishes, but the weapon is still owned.
        state.limitedWishes += starglitterAmount("weapon", result.rarity) * STARGLITTER_TO_WISH;
        const bucket = state.inventory.weapon;
        const existing = bucket[result.name];
        if (existing) existing.count += 1;
        else bucket[result.name] = { rarity: result.rarity, count: 1 };
      } else {
        const bucket = state.inventory.character;
        const existing = bucket[result.name];
        if (!existing) {
          bucket[result.name] = { rarity: result.rarity, constellation: 0 };
          // Ascending a brand-new character grants 3 Acquaint Fates (standard wishes).
          state.standardWishes += 3;
        } else {
          const maxed = existing.constellation >= 6;
          state.limitedWishes += starglitterAmount("character", result.rarity, maxed) * STARGLITTER_TO_WISH;
          if (!maxed) existing.constellation += 1;
        }
      }
    }
  }
  const key = trackKind === "standard" ? "standard" : entryKey(entry);
  state.lastResults[key] = results;
  render();
}

function unitPills(units) {
  return units
    .map(
      (u) =>
        `<span class="unit-pill rarity-${u.rarity}">${u.name}${u.capturingRadiance ? ` <span class="cr-tag">CR</span>` : ""}</span>`
    )
    .join("");
}

function pityBadge(trackKind, pity, hasFatePointConcept, threshold) {
  if (trackKind === "character") {
    const postCR = luna5Index !== -1 && state.patchIndex >= luna5Index;
    const parts = [];
    if (pity.guaranteed) parts.push("Guaranteed");
    // Capturing Radiance doesn't exist before 5.0, so the streak counter -- which keeps ticking
    // in the background regardless of era -- must stay hidden until it's actually active.
    if (postCR && pity.crCounter > 0) parts.push(`CR streak ${pity.crCounter}`);
    return parts.length ? `<span class="badge">${parts.join(" · ")}</span>` : "";
  }
  if (trackKind === "chronicled") {
    const hit = pity.fatePoint >= threshold;
    return `<span class="${hit ? "badge" : "badge-muted"}">Fate Point: ${pity.fatePoint}/${threshold}</span>`;
  }
  if (hasFatePointConcept) {
    if (pity.fatePoint >= threshold) return `<span class="badge">Guaranteed</span>`;
    if (threshold > 1) return `<span class="badge-muted">Fate: ${pity.fatePoint}/${threshold}</span>`;
  }
  return "";
}

function targetSelectHtml(cardId, trackKind, entry) {
  const current = state.chosenTarget[trackKind];
  const options = entry.five_star
    .map((u) => `<option value="${u.name}"${u.name === current ? " selected" : ""}>${u.name}</option>`)
    .join("");
  return `<div class="target-select"><label>Target: <select class="target-select-input" data-card-id="${cardId}">${options}</select></label></div>`;
}

let renderedEntries = {};
let cardCounter = 0;

function bannerCard(title, entry, trackKind) {
  if (!entry) return "";
  const cardId = `card-${cardCounter++}`;
  renderedEntries[cardId] = { entry, trackKind };
  const dropdownId = `four-star-dropdown-${cardId}`;
  const pity = state.pity[trackKind];
  const curve = trackKind === "weapon" ? WEAPON_CURVE : STANDARD_CURVE;
  const currency = trackKind === "standard" ? state.standardWishes : state.limitedWishes;
  const canX1 = Math.floor(currency) >= 1;
  const canX10 = Math.floor(currency) >= 10;

  const weaponEpitomized = trackKind === "weapon" && isEpitomizedPathActive();
  const hasFatePointConcept = trackKind === "chronicled" || weaponEpitomized;
  const threshold = trackKind === "chronicled" ? CHRONICLED_FATE_THRESHOLD : hasFatePointConcept ? fatePointThreshold() : null;

  const targetSelect =
    hasFatePointConcept && entry.five_star.length > 1 ? targetSelectHtml(cardId, trackKind, entry) : "";

  const lastResults = state.lastResults[entryKey(entry)];
  const resultsHtml =
    lastResults && lastResults.length
      ? `<div class="pull-results"><div class="unit-row">${unitPills(lastResults)}</div></div>`
      : "";

  return `
    <div class="banner-card">
      <h3>${title}</h3>
      <div class="unit-row">${unitPills(entry.five_star)}</div>
      <button class="four-star-toggle" data-target="${dropdownId}">4★ Rate-ups &#9662;</button>
      <div id="${dropdownId}" class="four-star-dropdown hidden">
        <div class="unit-row">${unitPills(entry.four_star)}</div>
      </div>
      <div class="pity-readout">Pity: ${pity.pity5}/${curve.hardPity5} · 4★: ${pity.pity4}/10 ${pityBadge(trackKind, pity, hasFatePointConcept, threshold)}</div>
      ${targetSelect}
      <div class="wish-actions">
        <button class="wish-btn" data-card-id="${cardId}" data-count="1" ${canX1 ? "" : "disabled"}>Wish x1</button>
        <button class="wish-btn" data-card-id="${cardId}" data-count="10" ${canX10 ? "" : "disabled"}>Wish x10</button>
      </div>
      ${resultsHtml}
    </div>
  `;
}

function renderInventory() {
  const charItems = Object.entries(state.inventory.character)
    .map(([name, info]) => ({ name, rarity: info.rarity, constellation: info.constellation }))
    .sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name));
  document.getElementById("inventory-character-list").innerHTML = charItems.length
    ? charItems
        .map(
          (item) =>
            `<span class="unit-pill rarity-${item.rarity}">${item.name} <span class="count">C${item.constellation}</span></span>`
        )
        .join("")
    : `<div class="history-empty">None yet.</div>`;

  const weaponItems = Object.entries(state.inventory.weapon)
    .map(([name, info]) => ({ name, rarity: info.rarity, count: info.count }))
    .sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name));
  document.getElementById("inventory-weapon-list").innerHTML = weaponItems.length
    ? weaponItems
        .map(
          (item) =>
            `<span class="unit-pill rarity-${item.rarity}">${item.name} <span class="count">×${item.count}</span></span>`
        )
        .join("")
    : `<div class="history-empty">None yet.</div>`;
}

const HISTORY_TRACK_LABELS = {
  character: "Character",
  weapon: "Weapon",
  standard: "Standard",
  chronicled: "Chronicled",
};

function renderHistoryPanel() {
  const tabsEl = document.getElementById("history-tabs");
  tabsEl.innerHTML = Object.keys(HISTORY_TRACK_LABELS)
    .map(
      (track) =>
        `<button class="history-tab${track === state.historyTab ? " active" : ""}" data-track="${track}">${HISTORY_TRACK_LABELS[track]}</button>`
    )
    .join("");

  const list = state.history[state.historyTab];
  const listEl = document.getElementById("history-list");
  if (!list.length) {
    listEl.innerHTML = `<div class="history-empty">No pulls yet.</div>`;
    return;
  }
  listEl.innerHTML = list
    .map(
      (entry, i) => `
      <div class="history-row">
        <span class="history-index">#${i + 1}</span>
        <span class="unit-pill rarity-${entry.rarity}">${entry.name}${entry.capturingRadiance ? ` <span class="cr-tag">CR</span>` : ""}</span>
        ${entry.rarity !== 3 && entry.pityAtPull != null ? `<span class="history-pity">Pity ${entry.pityAtPull}</span>` : ""}
        <span class="history-meta">Patch ${entry.patch} · Phase ${entry.phase}</span>
      </div>`
    )
    .reverse()
    .join("");
}

function renderStats() {
  const c = state.stats.character5050;
  document.getElementById("stats-character-5050").innerHTML = `
    <div class="stats-row"><span>Won</span><strong>${c.won}</strong></div>
    <div class="stats-row"><span>Lost</span><strong>${c.lost}</strong></div>
    <div class="stats-row"><span>Capturing Radiance</span><strong>${c.capturingRadiance}</strong></div>
  `;

  const w = state.stats.weaponFate;
  document.getElementById("stats-weapon-fate").innerHTML = `
    <div class="stats-row"><span>At 0 Fate Points</span><strong>${w[0]}</strong></div>
    <div class="stats-row"><span>At 1 Fate Point</span><strong>${w[1]}</strong></div>
    <div class="stats-row"><span>At 2 Fate Points</span><strong>${w[2]}</strong></div>
  `;
}

function renderStandardSection() {
  const pity = state.pity.standard;
  document.getElementById("standard-pity").textContent = `Pity: ${pity.pity5}/90 · 4★: ${pity.pity4}/10`;
  document.getElementById("standard-wish-x1").disabled = Math.floor(state.standardWishes) < 1;
  document.getElementById("standard-wish-x10").disabled = Math.floor(state.standardWishes) < 10;

  const panel = document.getElementById("standard-results");
  const lastResults = state.lastResults.standard;
  if (lastResults && lastResults.length) {
    panel.classList.remove("hidden");
    panel.innerHTML = `<div class="unit-row">${unitPills(lastResults)}</div>`;
  } else {
    panel.classList.add("hidden");
    panel.innerHTML = "";
  }
}

function render() {
  const patch = currentPatch();
  const phaseCount = maxPhaseForPatch(patch);
  const activeEntries = entriesForPatch(patch).filter((b) => b.phase === state.phase);

  document.getElementById("patch-label").textContent = `Patch ${patch} – Phase ${state.phase}/${phaseCount}`;
  document.getElementById("limited-count").textContent = Math.floor(state.limitedWishes);
  document.getElementById("standard-count").textContent = Math.floor(state.standardWishes);

  activeEntries.forEach((entry) => {
    if (entry.banner_type === "weapon" || entry.banner_type === "chronicled") {
      ensureBannerContext(entry.banner_type, entry);
    }
  });

  renderedEntries = {};
  cardCounter = 0;
  document.getElementById("banners").innerHTML = activeEntries
    .map((entry) => bannerCard(BANNER_TITLES[entry.banner_type] ?? entry.banner_type, entry, entry.banner_type))
    .join("");

  document.getElementById("standard-roster").textContent = "Standard";
  renderStandardSection();
  renderInventory();
  renderHistoryPanel();
  renderStats();

  const isLastPhase = state.phase >= phaseCount;
  const isLastPatch = state.patchIndex >= pullsPerPatch.length - 1;
  document.getElementById("next-phase-btn").disabled = isLastPhase;
  document.getElementById("next-patch-btn").disabled = isLastPatch;
}

function nextPhase() {
  const phaseCount = maxPhaseForPatch(currentPatch());
  if (state.phase < phaseCount) {
    state.phase += 1;
    render();
  }
}

function nextPatch() {
  if (state.patchIndex >= pullsPerPatch.length - 1) return;
  if (state.confirmNextPatch && !confirm("Are you sure you want to advance to the next patch?")) return;
  state.patchIndex += 1;
  state.phase = 1;
  const patchPulls = pullsPerPatch[state.patchIndex];
  state.limitedWishes += patchPulls.limited_pulls + welkinBonusForPatch(patchPulls.patch);
  state.standardWishes += patchPulls.standard_pulls;
  render();
}

function promptSpendingTier() {
  return new Promise((resolve) => {
    const modal = document.getElementById("spending-tier-modal");
    function handler(event) {
      const btn = event.target.closest("[data-tier]");
      if (!btn) return;
      modal.removeEventListener("click", handler);
      modal.remove();
      document.getElementById("app-shell").classList.remove("hidden");
      resolve(btn.dataset.tier);
    }
    modal.addEventListener("click", handler);
  });
}

async function init() {
  await loadData();
  luna5Index = pullsPerPatch.findIndex((p) => p.patch === "5.0");
  patch2Index = pullsPerPatch.findIndex((p) => p.patch === "2.0");
  nameTypeMap = buildNameTypeMap();

  state.spendingTier = await promptSpendingTier();

  const firstPatchPulls = pullsPerPatch[0];
  state.limitedWishes = firstPatchPulls.limited_pulls + welkinBonusForPatch(firstPatchPulls.patch);
  state.standardWishes = firstPatchPulls.standard_pulls;

  document.getElementById("next-phase-btn").addEventListener("click", nextPhase);
  document.getElementById("next-patch-btn").addEventListener("click", nextPatch);
  document.getElementById("confirm-next-patch-toggle").addEventListener("change", (event) => {
    state.confirmNextPatch = event.target.checked;
  });
  document.getElementById("standard-wish-x1").addEventListener("click", () => doWish(null, "standard", 1));
  document.getElementById("standard-wish-x10").addEventListener("click", () => doWish(null, "standard", 10));

  document.getElementById("toggle-inventory-btn").addEventListener("click", () => {
    document.getElementById("inventory-panel").classList.toggle("hidden");
  });
  document.getElementById("toggle-history-btn").addEventListener("click", () => {
    document.getElementById("history-panel").classList.toggle("hidden");
  });
  document.getElementById("toggle-stats-btn").addEventListener("click", () => {
    document.getElementById("stats-panel").classList.toggle("hidden");
  });
  document.getElementById("history-tabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".history-tab");
    if (!btn) return;
    state.historyTab = btn.dataset.track;
    renderHistoryPanel();
  });

  document.getElementById("banners").addEventListener("click", (event) => {
    const toggle = event.target.closest(".four-star-toggle");
    if (toggle) {
      document.getElementById(toggle.dataset.target).classList.toggle("hidden");
      return;
    }
    const wishBtn = event.target.closest(".wish-btn");
    if (wishBtn) {
      const rec = renderedEntries[wishBtn.dataset.cardId];
      if (!rec) return;
      doWish(rec.entry, rec.trackKind, Number(wishBtn.dataset.count));
    }
  });

  document.getElementById("banners").addEventListener("change", (event) => {
    const select = event.target.closest(".target-select-input");
    if (!select) return;
    const rec = renderedEntries[select.dataset.cardId];
    if (!rec) return;
    state.chosenTarget[rec.trackKind] = select.value;
    state.pity[rec.trackKind].fatePoint = 0;
    render();
  });

  render();
}

init();

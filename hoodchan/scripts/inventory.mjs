#!/usr/bin/env node
// Read tool for the hoodchan Bankr skill. Zero-dep (global fetch, node 18+).
// Never sends a transaction or a signature; prints ONE JSON object.
//
// Usage:
//   node scripts/inventory.mjs --address 0x... [--limit 20]
//       STATUS for a Bankr wallet: every HOODCHAN anon it owns, with leaderboard
//       rank, level, XP breakdown, sealed packs waiting to be ripped, and cards
//       waiting for a keep / cash-out decision. This is the "what do I have /
//       am I top N / which anons got packs" answer in one call.
//   node scripts/inventory.mjs --tba 0x...
//       Cards in ONE anon's token-bound wallet, with the ids settle-tx.mjs needs.
//   node scripts/inventory.mjs --tokenId 495
//       One anon: record + rank + packs + cards.
//   node scripts/inventory.mjs --rank 495
//       Just the leaderboard rank.
//
// Budget: hoodchan.org's /api/v1/* allows 120 requests / 5 min per IP. --address
// spends 2 + 1 per detailed anon there (plus 2 uncounted /api/rip calls per
// anon), so detail is capped by --limit (default 20, ranked anons first); the
// rest are listed by id only. A 429 is reported in `errors`, never hidden.
const BASE = "https://hoodchan.org";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const RANKED_MAX = 200; // the public leaderboard exposes the top 200 only
const RARITY = ["Common", "Rare", "Epic", "Legendary", "Mythic"];
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TOKEN_ID = /^[1-9][0-9]{0,3}$/;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const errors = [];
let calls = 0;
let failed = 0;
async function j(url) {
  calls++;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) {
      failed++;
      errors.push({ url: url.replace(BASE, ""), status: r.status });
      return null;
    }
    return await r.json();
  } catch (e) {
    failed++;
    errors.push({ url: url.replace(BASE, ""), error: String(e?.message || e) });
    return null;
  }
}
function eth(wei) {
  try {
    const n = BigInt(wei || "0");
    const whole = n / 10n ** 18n;
    const frac = ((n % 10n ** 18n) / 10n ** 12n).toString().padStart(6, "0");
    return `${whole}.${frac}`;
  } catch {
    return "0";
  }
}

async function leaderboard() {
  const d = await j(`${BASE}/api/v1/leaderboard?limit=${RANKED_MAX}`);
  const rank = new Map();
  const entry = new Map();
  const byXp = new Map();
  (d?.entries ?? []).forEach((e, i) => {
    const id = String(e.tokenId);
    rank.set(id, i + 1);
    entry.set(id, e);
    byXp.set(e.totalXp, (byXp.get(e.totalXp) ?? 0) + 1);
  });
  return { rank, entry, byXp, total: d?.total ?? null, ok: !!d };
}
const rankOf = (lb, id) => lb.rank.get(String(id)) ?? null; // null = outside top 200

function pack(p) {
  return {
    name: p.name,
    count: p.count,
    dropId: String(p.dropId),
    market: p.market,
  };
}
async function sealedFor(tba) {
  const d = await j(`${BASE}/api/rip/sealed?tba=${tba}`);
  return (d?.packs ?? []).map(pack);
}
async function cardsFor(tba) {
  const d = await j(`${BASE}/api/rip/claims?tba=${tba}`);
  return (d?.cards ?? []).map((c) => ({
    id: String(c.id), // on-chain cardId, what settle-tx.mjs needs
    market: c.market, // Vibe market address for settle-tx.mjs
    dropId: String(c.dropId),
    name: c.name,
    rarity: RARITY[c.rarity] ?? String(c.rarity),
    foil: c.foil,
    // revealed = ripped, waiting for keep (collect) or cash out (sell)
    // collected = kept as an NFT · sold = cashed out · pending = still opening
    state: c.state,
    // false = the market won't settle it right now (already settled, or the
    // claim isn't funded). Don't retry; check the anon's wallet page.
    cashable: !!c.cashable,
    // cash-out value. KEEPING the card forfeits this amount (it goes to the
    // pack creator / shared pot). CASHING OUT pays it but the card never mints.
    rewardEth: eth(c.rewardWei),
    image: c.image ?? null,
  }));
}
function summarizeCards(cards) {
  return {
    waitingForDecision: cards.filter((c) => c.state === "revealed"),
    stillOpening: cards.filter((c) => c.state === "pending").length,
    kept: cards.filter((c) => c.state === "collected").length,
    cashedOut: cards.filter((c) => c.state === "sold").length,
  };
}
function xpFrom(lbEntry, tokenRecord) {
  // The leaderboard computes XP live (includes the "wallet deployed" 75 XP
  // milestone); /api/v1/token hardcodes that milestone off, so prefer the board.
  if (lbEntry) {
    const b = lbEntry.breakdown ?? {};
    return {
      level: lbEntry.level ?? null,
      totalXp: lbEntry.totalXp ?? null,
      xp: {
        milestones: b.milestoneXp ?? 0,
        builder: b.builderXp ?? 0,
        hodler: b.hodlerXp ?? 0,
        collector: b.collectorXp ?? 0,
        topHolder: b.topHolderXp ?? 0,
        nested: b.nestedXp ?? 0,
      },
      xpSource: "leaderboard",
    };
  }
  const x = tokenRecord?.xpBreakdown ?? {};
  return {
    level: tokenRecord?.level ?? null,
    totalXp: tokenRecord?.totalXp ?? null,
    xp: {
      milestones: x.milestoneXp ?? 0,
      builder: x.builderXp ?? 0,
      hodler: x.hodlerXp ?? 0,
      collector: x.collectorXp ?? 0,
      topHolder: x.topHolderXp ?? 0,
      nested: x.nestedXp ?? 0,
    },
    // outside the top 200 the only source omits the 75 XP wallet milestone,
    // so the site's own pages may show up to 75 XP (one level) more
    xpSource: "token-route (may undercount by 75 XP)",
  };
}
async function anonDetail(tokenId, lb, tokenRecord) {
  const t = tokenRecord ?? (await j(`${BASE}/api/v1/token/${tokenId}`));
  const tba = t?.wallet?.address ?? null;
  const [sealedPacks, cards] = tba
    ? await Promise.all([sealedFor(tba), cardsFor(tba)])
    : [[], []];
  const lbEntry = lb.entry.get(String(tokenId));
  const xp = xpFrom(lbEntry, t);
  const rank = rankOf(lb, tokenId);
  return {
    tokenId: String(tokenId),
    rank,
    tiedWith: rank && xp.totalXp != null ? (lb.byXp.get(xp.totalXp) ?? 1) - 1 : 0,
    ...xp,
    activated: !!(lbEntry?.claimed ?? t?.claimed),
    tba,
    sealedPacks,
    cards: summarizeCards(cards),
    links: {
      anonWallet: `https://hoodchan.org/wallet/${tokenId}`,
      explorer: tba ? `${EXPLORER}/address/${tba}` : null,
      // OpenSea may also index kept cards under the anon's wallet; not guaranteed.
      opensea: tba ? `https://opensea.io/${tba}` : null,
    },
  };
}

const address = arg("address");
const tba = arg("tba");
const tokenId = arg("tokenId");
const rankId = arg("rank");
const limit = Math.max(1, Math.min(60, parseInt(arg("limit", "20"), 10) || 20));
const out = { notes: [] };

if (address) {
  if (!ADDR.test(address)) {
    console.error("bad --address (expected 0x + 40 hex)");
    process.exit(1);
  }
  const [wallet, lb] = await Promise.all([
    j(`${BASE}/api/v1/wallet/${address}`),
    leaderboard(),
  ]);
  const ids = (wallet?.tokenIds ?? []).map(String);
  // ranked anons first (best rank first), then the rest by id
  ids.sort((a, b) => {
    const ra = rankOf(lb, a) ?? 1e9;
    const rb = rankOf(lb, b) ?? 1e9;
    return ra - rb || Number(a) - Number(b);
  });
  const detailIds = ids.slice(0, limit);
  const anons = [];
  for (const id of detailIds) anons.push(await anonDetail(id, lb));
  out.address = address;
  out.anonCount = ids.length;
  out.leaderboardTotal = lb.total;
  out.anons = anons;
  if (ids.length > detailIds.length) {
    out.notDetailed = ids.slice(limit);
    out.notes.push(
      `${ids.length - detailIds.length} more anons listed by id only (raise --limit, max 60; each detailed anon costs 1 of the 120 / 5 min public-API requests).`,
    );
  }
  if (wallet && ids.length === 0)
    out.notes.push(
      "No HOODCHAN in this wallet per hoodchan.org (snapshot, up to 5 min stale). The NFT must be in the Bankr wallet on Robinhood Chain (4663).",
    );
  if (anons.some((a) => a.rank === null))
    out.notes.push(
      `rank null = outside the top ${RANKED_MAX} (the public leaderboard exposes the top ${RANKED_MAX} of ${lb.total ?? "?"} anons that have ever activated or posted).`,
    );
  if (anons.some((a) => a.tiedWith > 0))
    out.notes.push(
      "tiedWith = other anons on the board with the same XP; ties are ordered by token id, so quote XP alongside rank.",
    );
  const waiting = anons.reduce((n, a) => n + a.cards.waitingForDecision.length, 0);
  if (waiting)
    out.notes.push(
      `${waiting} ripped card(s) are waiting for a decision: keep (collect → NFT in the anon's wallet, forfeits rewardEth) or cash out (sell → rewardEth to the anon's wallet, card never mints). Nothing is an NFT until kept.`,
    );
}
if (tba) {
  if (!ADDR.test(tba)) {
    console.error("bad --tba (expected 0x + 40 hex)");
    process.exit(1);
  }
  const cards = await cardsFor(tba);
  const s = summarizeCards(cards);
  out.tba = tba;
  out.cards = cards;
  out.summary = {
    waitingCount: s.waitingForDecision.length,
    stillOpening: s.stillOpening,
    kept: s.kept,
    cashedOut: s.cashedOut,
  };
  out.links = {
    explorer: `${EXPLORER}/address/${tba}`,
    opensea: `https://opensea.io/${tba}`,
  };
}
if (tokenId) {
  if (!TOKEN_ID.test(tokenId) || Number(tokenId) > 1200) {
    console.error("bad --tokenId (1..1200)");
    process.exit(1);
  }
  const [lb, t] = await Promise.all([
    leaderboard(),
    j(`${BASE}/api/v1/token/${tokenId}`),
  ]);
  out.anon = await anonDetail(tokenId, lb, t);
  out.leaderboardTotal = lb.total;
  if (out.anon.rank === null)
    out.notes.push(`Outside the top ${RANKED_MAX} (public leaderboard limit).`);
}
if (rankId) {
  if (!TOKEN_ID.test(rankId) || Number(rankId) > 1200) {
    console.error("bad --rank (1..1200)");
    process.exit(1);
  }
  const lb = await leaderboard();
  const e = lb.entry.get(String(rankId));
  out.tokenId = String(rankId);
  out.rank = rankOf(lb, rankId);
  out.totalXp = e?.totalXp ?? null;
  out.level = e?.level ?? null;
  out.tiedWith = e ? (lb.byXp.get(e.totalXp) ?? 1) - 1 : 0;
  out.leaderboardTotal = lb.total;
  if (out.rank === null)
    out.notes.push(`Outside the top ${RANKED_MAX} (public leaderboard limit).`);
}

if (!address && !tba && !tokenId && !rankId) {
  console.error(
    "usage: inventory.mjs [--address 0x.. [--limit N]] [--tba 0x..] [--tokenId N] [--rank N]",
  );
  process.exit(1);
}
if (errors.length) {
  out.errors = errors;
  if (errors.some((e) => e.status === 429))
    out.notes.push(
      "Rate limited by hoodchan.org (120 / 5 min per IP). Wait a few minutes; do not retry in a loop.",
    );
}
if (!out.notes.length) delete out.notes;
console.log(JSON.stringify(out, null, 2));
// exit 2 when nothing could be read at all, so a caller can't mistake it for "empty"
if (calls > 0 && failed === calls) process.exit(2);

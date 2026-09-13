#!/usr/bin/env node
// Dedicated read tool for the hoodchan skill — reliable inventory lookups so the
// model doesn't hand-build HTTP requests. Zero-dep (uses global fetch, node 18+).
// Output: one JSON object.
//
// Usage:
//   node scripts/inventory.mjs --address 0x...   → sealed packs across the holder's anons
//   node scripts/inventory.mjs --tba 0x...       → revealed cards in one anon's TBA
//   node scripts/inventory.mjs --tokenId 495     → full record for one anon (level, etc.)
//
// NOTE: to list WHICH anons a wallet owns, read the Bankr wallet's NFT holdings
// for contract 0x774Db2207D26570F5638028839c816702A40aBC2 on chain 4663 —
// hoodchan's API has no address→tokenIds route. This tool covers packs/cards/detail.
const BASE = "https://hoodchan.org";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
async function j(url) {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const address = arg("address");
const tba = arg("tba");
const tokenId = arg("tokenId");
const out = {};

if (address) {
  const packs = await j(`${BASE}/api/rip/packs?address=${address}`);
  out.sealedPacks = (packs?.packs ?? []).map((p) => ({
    tokenId: p.tokenId,
    tba: p.tba,
    name: p.name,
    dropId: p.dropId,
    market: p.market,
    count: p.count,
  }));
}
if (tba) {
  const claims = await j(`${BASE}/api/rip/claims?tba=${tba}`);
  out.cards = (claims?.cards ?? []).map((c) => ({
    name: c.name,
    rarity: c.rarity,
    foil: c.foil,
    state: c.state, // revealed | collected | sold | pending
    rewardWei: c.rewardWei,
  }));
}
if (tokenId) {
  out.anon = await j(`${BASE}/api/v1/token/${tokenId}`);
}

if (!address && !tba && !tokenId) {
  console.error(
    "usage: inventory.mjs [--address 0x..] [--tba 0x..] [--tokenId N]",
  );
  process.exit(1);
}
console.log(JSON.stringify(out, null, 2));

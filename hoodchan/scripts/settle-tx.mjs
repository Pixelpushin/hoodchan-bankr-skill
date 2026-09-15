#!/usr/bin/env node
// Builds the unsigned "settle" transaction for a revealed Vibe card held by a
// HOODCHAN anon's token-bound account (TBA). A ripped card is a CLAIM inside
// the Vibe market until it is settled one of two ways:
//   --mode collect  → keep it: mints the card NFT into the anon's wallet
//   --mode sell     → cash out: pays the card's reward (ETH) into the anon's wallet, no NFT
// The call is executed FROM the TBA via execute(), exactly like ripping.
// Output: ONE JSON object { to, data, value, chainId } — hand it to Bankr's Submit flow.
//
// Usage:
//   node scripts/settle-tx.mjs --tba <addr> --market <addr> --cardId <id> --mode collect|sell
//
// Get cardId + market from `node scripts/inventory.mjs --tba <addr>` (cards with
// state "revealed" and cashable true). Mirrors what hoodchan.org's own /rip page
// sends (minimums 0, recipient = the TBA). Requires `ethers` (npm i in this folder).
import { Interface } from "ethers";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const tba = arg("tba");
const market = arg("market");
const cardId = arg("cardId");
const mode = (arg("mode", "") || "").toLowerCase();

const ADDR = /^0x[0-9a-fA-F]{40}$/;
if (
  !ADDR.test(tba || "") ||
  !ADDR.test(market || "") ||
  cardId == null ||
  !/^\d+$/.test(String(cardId)) ||
  !["collect", "sell", "keep", "cashout", "cash-out"].includes(mode)
) {
  console.error(
    "usage: settle-tx.mjs --tba <0x..> --market <0x..> --cardId <n> --mode collect|sell",
  );
  process.exit(1);
}
const keep = mode === "collect" || mode === "keep";

const CHAIN_ID = 4663; // Robinhood Chain
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // +30 min (Bankr approval can be slow)

const marketIface = new Interface([
  "function sell(uint256 cardId, uint256 minSaleProceeds, uint256 minPayout, uint256 deadline, address recipient)",
  "function collect(uint256 cardId, uint256 minSaleProceeds, uint256 minCreatorPayout, uint256 deadline, address nftRecipient)",
]);
const accountIface = new Interface([
  "function execute(address to, uint256 value, bytes data, uint8 operation)",
]);

// Minimums are 0 and the recipient is the anon's own wallet, matching the
// hoodchan.org /rip page. The NFT (collect) or the ETH (sell) lands in the TBA.
const inner = keep
  ? marketIface.encodeFunctionData("collect", [BigInt(cardId), 0n, 0n, deadline, tba])
  : marketIface.encodeFunctionData("sell", [BigInt(cardId), 0n, 0n, deadline, tba]);

// operation 0 = CALL. Sent TO the TBA; the TBA forwards to the market. value 0.
const data = accountIface.encodeFunctionData("execute", [market, 0n, inner, 0]);

console.log(
  JSON.stringify({
    to: tba,
    data,
    value: "0x0",
    chainId: CHAIN_ID,
    mode: keep ? "collect" : "sell",
    cardId: String(cardId),
  }),
);

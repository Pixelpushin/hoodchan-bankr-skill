#!/usr/bin/env node
// Builds the unsigned rip transaction for the hoodchan Bankr skill.
// Ripping = call openSealed on the Vibe market, executed FROM the anon's
// ERC-6551 token-bound account (TBA) via execute(). Output: ONE JSON object
// { to, data, value, chainId } — hand that straight to Bankr's Submit flow.
//
// Usage:
//   node scripts/rip-tx.mjs --tba <addr> --market <addr> --dropId <n> --count <1..10>
//
// Requires `ethers` (see package.json in this folder; `npm i` if missing) so the
// calldata is exact — never hand-encode selectors.
import { Interface } from "ethers";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const tba = arg("tba");
const market = arg("market");
const dropId = arg("dropId");
let count = parseInt(arg("count", "1"), 10);

if (!tba || !market || dropId == null || dropId === undefined) {
  console.error(
    "usage: rip-tx.mjs --tba <addr> --market <addr> --dropId <n> --count <1..10>",
  );
  process.exit(1);
}
// Vibe caps openSealed at 10 per call; rip larger stacks in batches of 10.
count = Math.max(1, Math.min(10, Number.isFinite(count) ? count : 1));

const CHAIN_ID = 4663; // Robinhood Chain
const deadline = BigInt(Math.floor(Date.now() / 1000) + 900); // +15 min

const marketIface = new Interface([
  "function openSealed(uint256 dropId, uint8 count, uint256 zero, uint256 minOpeningProceeds, uint256 deadline)",
]);
const accountIface = new Interface([
  "function execute(address to, uint256 value, bytes data, uint8 operation)",
]);

const openSealedData = marketIface.encodeFunctionData("openSealed", [
  BigInt(dropId),
  BigInt(count),
  0n, // zero (unused)
  0n, // minOpeningProceeds
  deadline,
]);

// operation 0 = CALL. The tx is sent TO the TBA; the TBA forwards the call to
// the market. value 0 - ripping (opening) is free; only gas is paid.
const data = accountIface.encodeFunctionData("execute", [
  market,
  0n,
  openSealedData,
  0,
]);

console.log(
  JSON.stringify({ to: tba, data, value: "0x0", chainId: CHAIN_ID }),
);

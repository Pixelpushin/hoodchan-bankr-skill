#!/usr/bin/env node
// Builds the unsigned rip transaction for the hoodchan Bankr skill.
// Ripping = call openSealed on the Vibe market, executed FROM the anon's
// ERC-6551 token-bound account (TBA) via execute(). Output: ONE JSON object
// { to, data, value, chainId, ... } — hand that straight to Bankr's Submit flow.
//
// Usage:
//   node scripts/rip-tx.mjs --tba <addr> --market <addr> --dropId <n> --count <1..10>
//
// `count` must not exceed the sealed packs the anon actually holds of that
// drop (see inventory.mjs); Vibe also caps openSealed at 10 per call.
//
// Entropy fee: Vibe's spec says openSealed carries `entropy.fee()` as value.
// On the live Robinhood runtimes that fee is 0 today. This script reads it
// (best effort, public RPC) and, if non-zero, sets it as the execute value —
// which the TBA itself must hold. If the read fails, value stays 0 and
// `feeCheck` says so; a revert with "insufficient value"-style reason means
// the TBA needs that ETH first.
//
// Requires `ethers` (see package.json in this folder; `npm i` if missing) so the
// calldata is exact — never hand-encode selectors.
import { Interface } from "ethers";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const tba = arg("tba");
const market = arg("market");
const dropId = arg("dropId");
let count = parseInt(arg("count", "1"), 10);

if (
  !ADDR.test(tba || "") ||
  !ADDR.test(market || "") ||
  !/^\d+$/.test(String(dropId ?? ""))
) {
  console.error(
    "usage: rip-tx.mjs --tba <0x..> --market <0x..> --dropId <n> --count <1..10>",
  );
  process.exit(1);
}
// Vibe caps openSealed at 10 per call; rip larger stacks in batches of 10.
count = Math.max(1, Math.min(10, Number.isFinite(count) ? count : 1));

const CHAIN_ID = 4663; // Robinhood Chain
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // +30 min (Bankr approval can be slow)

const marketIface = new Interface([
  "function openSealed(uint256 dropId, uint8 count, uint256 zero, uint256 minOpeningProceeds, uint256 deadline)",
  "function entropy() view returns (address)",
]);
const entropyIface = new Interface(["function fee() view returns (uint256)"]);
const accountIface = new Interface([
  "function execute(address to, uint256 value, bytes data, uint8 operation)",
]);

async function ethCall(to, data) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // the public Robinhood RPC rejects requests without a browser-like UA/Origin
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
      origin: "https://vibechain.com",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error || typeof d.result !== "string") throw new Error("eth_call failed");
  return d.result;
}

let feeWei = 0n;
let feeCheck = "ok";
try {
  const entropyAddr = marketIface.decodeFunctionResult(
    "entropy",
    await ethCall(market, marketIface.encodeFunctionData("entropy", [])),
  )[0];
  feeWei = entropyIface.decodeFunctionResult(
    "fee",
    await ethCall(entropyAddr, entropyIface.encodeFunctionData("fee", [])),
  )[0];
} catch {
  feeCheck = "unavailable (RPC read failed); assuming 0";
}

const openSealedData = marketIface.encodeFunctionData("openSealed", [
  BigInt(dropId),
  BigInt(count),
  0n, // zero (unused, must be 0)
  0n, // minOpeningProceeds (matches hoodchan.org's own rip page)
  deadline,
]);

// operation 0 = CALL. The tx is sent TO the TBA; the TBA forwards the call to
// the market. Outer value is 0: any entropy fee is paid from the TBA's balance.
const data = accountIface.encodeFunctionData("execute", [
  market,
  feeWei,
  openSealedData,
  0,
]);

console.log(
  JSON.stringify({
    to: tba,
    data,
    value: "0x0",
    chainId: CHAIN_ID,
    dropId: String(dropId),
    count,
    entropyFeeWei: feeWei.toString(),
    feeCheck,
    ...(feeWei > 0n
      ? {
          warning: `This runtime charges an entropy fee of ${feeWei} wei per rip, paid from the anon's wallet (TBA). The TBA must hold at least that much ETH or the rip reverts.`,
        }
      : {}),
  }),
);

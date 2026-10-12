#!/usr/bin/env node
// Builds the unsigned buy transaction for Vibe packs on Robinhood Chain.
// Buying = call the market's buy function with ETH payment. Output: ONE JSON
// object { to, data, value, chainId, priceWei, ... } — hand to Bankr's Submit flow.
//
// Usage:
//   node scripts/buy-tx.mjs --dropId <n> --count <1..100> [--market <addr>]
//
// If --market is omitted, the script discovers the current Robinhood Chain
// runtime via the VibeChain API and uses its market contract. Requires a
// VIBECHAIN_API_KEY environment variable (register at https://build.vibechain.com/api/vibemarket2/runtime/versions).
//
// The script reads the current pack price from the market and sets value
// accordingly. Slippage protection: set --maxPriceWei to reject if price exceeds.
//
// NOTE: This script uses direct ABI encoding to avoid ethers import issues.
// The selectors are hardcoded:
// - R5 buy: 0x3d08c576 (buy(uint256,uint256,uint256,uint256))
// - Classic mint: 0x40c10f19 (mint(uint256,address,address,address))

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const dropId = arg("dropId");
let count = parseInt(arg("count", "1"), 10);
const market = arg("market");
const maxPriceWei = arg("maxPriceWei");
const apiKey = process.env.VIBECHAIN_API_KEY;

if (
  !/^\d+$/.test(String(dropId ?? "")) ||
  count < 1 ||
  count > 100 ||
  (market && !ADDR.test(market))
) {
  console.error(
    "usage: buy-tx.mjs --dropId <n> --count <1..100> [--market <0x..>] [--maxPriceWei <wei>]",
  );
  console.error("Set VIBECHAIN_API_KEY environment variable for auto-discovery.");
  process.exit(1);
}

const CHAIN_ID = 4663; // Robinhood Chain
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // +30 min

// ABI encoding helpers (no ethers dependency)
function encodeUint256(value) {
  const v = BigInt(value);
  const hex = v.toString(16).padStart(64, "0");
  return hex;
}

function encodeAddress(addr) {
  return addr.slice(2).padStart(64, "0");
}

function encodeFunctionData(selector, params) {
  let data = selector;
  for (const param of params) {
    data += param;
  }
  return "0x" + data;
}

// R5 market buy function selector: buy(uint256 dropId, uint256 count, uint256 minPayout, uint256 deadline)
const R5_BUY_SELECTOR = "3d08c576";

// Classic BoosterDropV2 mint selector: mint(uint256 amount, address recipient, address referrer, address originReferrer)
const CLASSIC_MINT_SELECTOR = "40c10f19";

async function discoverMarket() {
  if (!apiKey) {
    throw new Error("VIBECHAIN_API_KEY required for market discovery (set env var or use --market)");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const r = await fetch(
    "https://build.vibechain.com/api/vibemarket2/runtime/versions",
    {
      headers: { "API-KEY": apiKey },
      signal: controller.signal,
    },
  );

  clearTimeout(timeoutId);

  if (!r.ok) throw new Error("Failed to fetch runtime versions");

  const data = await r.json();
  const versions = data.versions || [];

  // Find the Robinhood Chain (4663) runtime marked as launchTarget
  const robinhoodRuntime = versions.find(
    (v) => v.chainId === 4663 && v.launchTarget === true,
  );

  if (!robinhoodRuntime) {
    // Fallback: first Robinhood Chain runtime
    const fallback = versions.find((v) => v.chainId === 4663);
    if (!fallback) {
      throw new Error("No Robinhood Chain runtime found");
    }
    return fallback.market;
  }

  return robinhoodRuntime.market;
}

async function main() {
  let targetMarket;
  if (market) {
    targetMarket = market;
  } else {
    targetMarket = await discoverMarket();
  }

  // Try R5 market price first
  let priceWei = 0n;
  let priceCheck = "ok";
  let usesR5 = false;

  try {
    const RPC = "https://rpc.mainnet.chain.robinhood.com";
    // R5 price() selector: 0x313ce567
    const priceData = "0x" + "313ce567" + "0".repeat(64);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const r = await fetch(RPC, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        origin: "https://vibechain.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: targetMarket, data: priceData }, "latest"],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const d = await r.json();
    if (d.error || typeof d.result !== "string") {
      throw new Error("R5 price() call failed");
    }

    priceWei = d.result === "0x" ? 0n : BigInt(d.result);
    usesR5 = true;
  } catch (e) {
    // Fallback to BoosterDropV2 (Classic/Base-style on Robinhood)
    try {
      const RPC = "https://rpc.mainnet.chain.robinhood.com";
      // getMintPrice(uint256 amount) selector: 0x4b1b1be0
      const priceData = "0x" + "4b1b1be0" + encodeUint256(count);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const r = await fetch(RPC, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
          origin: "https://vibechain.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: targetMarket, data: priceData }, "latest"],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const d = await r.json();
      if (d.error || typeof d.result !== "string") {
        throw new Error("getMintPrice() call failed");
      }

      priceWei = d.result === "0x" ? 0n : BigInt(d.result);
      priceCheck = "assumed Classic (getMintPrice fallback)";
    } catch (e2) {
      priceCheck = `unavailable (RPC read failed: ${e2.message})`;
    }
  }

  const totalPriceWei = priceWei * BigInt(count);

  if (maxPriceWei && totalPriceWei > BigInt(maxPriceWei)) {
    console.error(
      `Price ${totalPriceWei} wei exceeds maxPriceWei ${maxPriceWei}`,
    );
    process.exit(1);
  }

  let buyData;
  if (usesR5) {
    // R5 market: buy(dropId, count, minPayout, deadline)
    buyData = encodeFunctionData(R5_BUY_SELECTOR, [
      encodeUint256(dropId),
      encodeUint256(count),
      encodeUint256(0), // minPayout
      encodeUint256(deadline),
    ]);
  } else {
    // Classic: mint(amount, recipient, referrer, originReferrer)
    // Recipient = the caller's address (Bankr will fill this in submit flow)
    buyData = encodeFunctionData(CLASSIC_MINT_SELECTOR, [
      encodeUint256(count),
      encodeAddress("0x0000000000000000000000000000000000000000"), // placeholder recipient
      encodeAddress("0x0000000000000000000000000000000000000000"), // referrer (none)
      encodeAddress("0x0000000000000000000000000000000000000000"), // originReferrer (none)
    ]);
  }

  console.log(
    JSON.stringify({
      to: targetMarket,
      data: buyData,
      value: "0x" + totalPriceWei.toString(16),
      chainId: CHAIN_ID,
      dropId: String(dropId),
      count,
      priceWei: priceWei.toString(),
      totalPriceWei: totalPriceWei.toString(),
      priceCheck,
      usesR5,
      ...(usesR5
        ? {}
        : {
            note: "Classic contract detected: recipient must be set to the buyer's address in the submit flow",
          }),
    }),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});

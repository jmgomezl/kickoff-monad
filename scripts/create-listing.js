const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Creates a marketplace listing with a HIDDEN reserve price.
 * Env knobs:
 *   RESERVE_MCOP    hidden reserve in MONADCOP   (default 20000)
 *   DURATION_SEC    seconds until offers close   (default 90)
 *   ITEM_NAME       label                        (default "Balón oficial Monad Blitz")
 *   AGENT_ADDRESS   who may executeWinner         (default = signer)
 *   MARKET_ADDRESS, TOKEN_ADDRESS (required, from .env)
 */
async function main() {
  const marketAddr = process.env.MARKET_ADDRESS;
  const tokenAddr = process.env.TOKEN_ADDRESS;
  if (!marketAddr || !tokenAddr) throw new Error("Set MARKET_ADDRESS and TOKEN_ADDRESS in .env");

  const [signer] = await hre.ethers.getSigners();
  const market = await hre.ethers.getContractAt("KickoffMarket", marketAddr, signer);

  const reserveMcop = process.env.RESERVE_MCOP || "20000";
  const durationSec = Number(process.env.DURATION_SEC || "90");
  const itemName = process.env.ITEM_NAME || "Balón oficial Monad Blitz";
  const agentAddress = process.env.AGENT_ADDRESS || signer.address;

  const reserve = hre.ethers.parseEther(reserveMcop);
  const salt = hre.ethers.hexlify(hre.ethers.randomBytes(32));
  const commit = hre.ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reserve, salt]);
  const deadline = (await hre.ethers.provider.getBlock("latest")).timestamp + durationSec;

  console.log("─".repeat(60));
  console.log("Creating listing");
  console.log("  item    :", itemName);
  console.log("  reserve :", reserveMcop, "MONADCOP (hidden)");
  console.log("  duration:", durationSec, "s");
  console.log("  agent   :", agentAddress);
  console.log("─".repeat(60));

  const tx = await market.createListing(tokenAddr, commit, deadline, itemName, agentAddress);
  const receipt = await tx.wait();
  let listingId = null;
  for (const log of receipt.logs) {
    try {
      const p = market.interface.parseLog(log);
      if (p?.name === "ListingCreated") listingId = p.args.listingId.toString();
    } catch (_) {}
  }
  if (listingId === null) listingId = (await market.listingCount()).toString();

  console.log(`\n✅ Listing ${listingId} created. tx: ${tx.hash}`);

  const outDir = path.join(__dirname, "..", "demo");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "salt.json"),
    JSON.stringify(
      { listingId, marketAddr, itemName, reserve: reserve.toString(), reserveMcop, salt, commit, deadline },
      null,
      2
    )
  );
  console.log("   reveal data -> demo/salt.json (keep secret!)");
  console.log("LISTING_ID=" + listingId);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

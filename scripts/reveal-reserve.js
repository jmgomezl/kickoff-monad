const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/** The dramatic reveal — reads demo/salt.json and calls revealReserve. */
async function main() {
  const file = path.join(__dirname, "..", "demo", "salt.json");
  if (!fs.existsSync(file)) throw new Error("demo/salt.json not found — create a listing first.");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));

  const [signer] = await hre.ethers.getSigners();
  const market = await hre.ethers.getContractAt("KickoffMarket", r.marketAddr, signer);

  console.log("Revealing reserve for listing", r.listingId, "→", r.reserveMcop, "MONADCOP");
  const tx = await market.revealReserve(r.listingId, r.reserve, r.salt);
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const p = market.interface.parseLog(log);
      if (p?.name === "ReserveRevealed") {
        console.log("\n🎭 REVEAL");
        console.log("  reserve   :", hre.ethers.formatEther(p.args.reserve), "MONADCOP");
        console.log("  final     :", hre.ethers.formatEther(p.args.finalPrice), "MONADCOP");
        console.log("  margin    :", hre.ethers.formatEther(p.args.margin), "MONADCOP (over reserve)");
      }
    } catch (_) {}
  }
  console.log("\n✅ Revealed. tx:", tx.hash);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/** The dramatic on-stage reveal. Reads demo/salt.json and calls revealMinPrice. */
async function main() {
  const file = path.join(__dirname, "..", "demo", "salt.json");
  if (!fs.existsSync(file)) throw new Error("demo/salt.json not found — create an arena first.");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));

  const [signer] = await hre.ethers.getSigners();
  const arena = await hre.ethers.getContractAt("KickoffArena", r.contractAddress, signer);

  console.log("Revealing min price for arena", r.arenaId, "→", r.minPriceMon, "MON");
  const tx = await arena.revealMinPrice(r.arenaId, r.minPrice, r.salt);
  const receipt = await tx.wait();

  for (const log of receipt.logs) {
    try {
      const parsed = arena.interface.parseLog(log);
      if (parsed?.name === "MinPriceRevealed") {
        const { minPrice, winningBid, spread } = parsed.args;
        console.log("\n🎭 REVEAL");
        console.log("  min price  :", hre.ethers.formatEther(minPrice), "MON");
        console.log("  winning bid:", hre.ethers.formatEther(winningBid), "MON");
        console.log("  spread     :", hre.ethers.formatEther(spread), "MON");
      }
    } catch (_) {}
  }
  console.log("\n✅ Revealed. tx:", tx.hash);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

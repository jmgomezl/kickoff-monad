const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Creates a fresh arena for the demo.
 * Env knobs (all optional, sane defaults):
 *   MIN_PRICE_MON   min price the seller commits to        (default 0.5)
 *   COLLATERAL_MON  seller collateral                       (default 0.1)
 *   DURATION_SEC    seconds until offers close              (default 90)
 *   PRIZE_NAME      label                                   (default "Balón oficial Monad Blitz")
 *   AGENT_ADDRESS   address allowed to executeWinner        (default = deployer)
 *   CONTRACT_ADDRESS deployed KickoffArena                  (required)
 */
async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) throw new Error("Set CONTRACT_ADDRESS in .env");

  const [signer] = await hre.ethers.getSigners();
  const arena = await hre.ethers.getContractAt("KickoffArena", contractAddress, signer);

  const minPriceMon = process.env.MIN_PRICE_MON || "0.5";
  const collateralMon = process.env.COLLATERAL_MON || "0.1";
  const durationSec = Number(process.env.DURATION_SEC || "90");
  const prizeName = process.env.PRIZE_NAME || "Balón oficial Monad Blitz";
  const agentAddress = process.env.AGENT_ADDRESS || signer.address;

  const minPrice = hre.ethers.parseEther(minPriceMon);
  const salt = hre.ethers.hexlify(hre.ethers.randomBytes(32));
  const commit = hre.ethers.solidityPackedKeccak256(["uint256", "bytes32"], [minPrice, salt]);

  const block = await hre.ethers.provider.getBlock("latest");
  const deadline = block.timestamp + durationSec;

  console.log("─".repeat(60));
  console.log("Creating arena");
  console.log("  prize     :", prizeName);
  console.log("  minPrice  :", minPriceMon, "MON (hidden via commit)");
  console.log("  collateral:", collateralMon, "MON");
  console.log("  duration  :", durationSec, "s");
  console.log("  agent     :", agentAddress);
  console.log("─".repeat(60));

  const tx = await arena.createArena(commit, deadline, prizeName, agentAddress, {
    value: hre.ethers.parseEther(collateralMon),
  });
  const receipt = await tx.wait();

  // Pull arenaId out of the ArenaCreated event.
  let arenaId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = arena.interface.parseLog(log);
      if (parsed?.name === "ArenaCreated") arenaId = parsed.args.arenaId.toString();
    } catch (_) {}
  }
  if (arenaId === null) arenaId = (await arena.arenaCount()).toString();

  console.log("\n✅ Arena", arenaId, "created. tx:", tx.hash);

  // Persist the salt + reveal data — DO NOT commit this file.
  const outDir = path.join(__dirname, "..", "demo");
  fs.mkdirSync(outDir, { recursive: true });
  const reveal = {
    arenaId,
    contractAddress,
    prizeName,
    minPrice: minPrice.toString(),
    minPriceMon,
    salt,
    commit,
    deadline,
    agentAddress,
    txHash: tx.hash,
  };
  fs.writeFileSync(path.join(outDir, "salt.json"), JSON.stringify(reveal, null, 2));
  console.log("   reveal data saved -> demo/salt.json (keep secret!)");
  console.log("\nReveal later with:");
  console.log(
    `   npx hardhat run scripts/reveal.js --network monad   # reads demo/salt.json`
  );

  // Emit the arenaId for shell scripts to capture.
  console.log("ARENA_ID=" + arenaId);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const bal = await hre.ethers.provider.getBalance(deployer.address);

  console.log("─".repeat(60));
  console.log("Deploying MONADCOP + KickoffMarket");
  console.log("  network :", hre.network.name, "chainId", net.chainId.toString());
  console.log("  deployer:", deployer.address);
  console.log("  balance :", hre.ethers.formatEther(bal), "MON");
  console.log("─".repeat(60));
  if (bal === 0n) throw new Error("Deployer has 0 MON.");

  const Token = await hre.ethers.getContractFactory("MONADCOP");
  const token = await Token.deploy();
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("✅ MONADCOP:", tokenAddr);

  const Market = await hre.ethers.getContractFactory("KickoffMarket");
  const market = await Market.deploy();
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();
  console.log("✅ KickoffMarket:", marketAddr);

  const outDir = path.join(__dirname, "..", "deploy");
  fs.mkdirSync(outDir, { recursive: true });
  const info = {
    chainId: net.chainId.toString(),
    network: hre.network.name,
    deployer: deployer.address,
    token: tokenAddr,
    market: marketAddr,
  };
  fs.writeFileSync(path.join(outDir, "v2.json"), JSON.stringify(info, null, 2));
  console.log("   saved -> deploy/v2.json");

  console.log("\nSet in .env:");
  console.log("  TOKEN_ADDRESS=" + tokenAddr);
  console.log("  MARKET_ADDRESS=" + marketAddr);
  console.log("  VITE_TOKEN_ADDRESS=" + tokenAddr);
  console.log("  VITE_MARKET_ADDRESS=" + marketAddr);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("─".repeat(60));
  console.log("Deploying KickoffArena");
  console.log("  network  :", hre.network.name, "chainId", net.chainId.toString());
  console.log("  deployer :", deployer.address);
  console.log("  balance  :", hre.ethers.formatEther(balance), "MON");
  console.log("─".repeat(60));

  if (balance === 0n) {
    throw new Error("Deployer has 0 MON. Fund the wallet before deploying.");
  }

  const Factory = await hre.ethers.getContractFactory("KickoffArena");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ KickoffArena deployed at:", address);
  console.log("   tx:", contract.deploymentTransaction()?.hash);

  // Persist for other services.
  const outDir = path.join(__dirname, "..", "deploy");
  fs.mkdirSync(outDir, { recursive: true });
  const info = {
    address,
    chainId: net.chainId.toString(),
    network: hre.network.name,
    deployer: deployer.address,
    txHash: contract.deploymentTransaction()?.hash || null,
  };
  fs.writeFileSync(path.join(outDir, "address.json"), JSON.stringify(info, null, 2));
  console.log("   saved -> deploy/address.json");

  console.log("\nNext: set CONTRACT_ADDRESS and VITE_CONTRACT_ADDRESS in your .env to:");
  console.log("  " + address);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

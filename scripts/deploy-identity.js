const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Deploys the ERC-8004 Identity Registry and registers the kickoff negotiator
// agent FROM ITS OWN KEY, so the agent self-owns its on-chain identity.
// The agentURI points at the agent's registration file (Agent Card).
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const bal = await hre.ethers.provider.getBalance(deployer.address);

  console.log("─".repeat(60));
  console.log("Deploying AgentIdentityRegistry (ERC-8004)");
  console.log("  network :", hre.network.name, "chainId", net.chainId.toString());
  console.log("  deployer:", deployer.address);
  console.log("  balance :", hre.ethers.formatEther(bal), "MON");
  console.log("─".repeat(60));
  if (bal === 0n) throw new Error("Deployer has 0 MON.");

  const Reg = await hre.ethers.getContractFactory("AgentIdentityRegistry");
  const reg = await Reg.deploy();
  await reg.waitForDeployment();
  const regAddr = await reg.getAddress();
  console.log("✅ AgentIdentityRegistry:", regAddr);

  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!agentKey) throw new Error("AGENT_PRIVATE_KEY missing");
  const agent = new hre.ethers.Wallet(agentKey, hre.ethers.provider);
  const agentURI = process.env.AGENT_CARD_URI || "https://kickoff.bot/agent-card.json";

  const agentBal = await hre.ethers.provider.getBalance(agent.address);
  console.log("  agent   :", agent.address, "(" + hre.ethers.formatEther(agentBal) + " MON)");
  console.log("  agentURI:", agentURI);

  const tx = await reg.connect(agent)["register(string)"](agentURI, { gasLimit: 500000n });
  console.log("  register tx:", tx.hash);
  const rc = await tx.wait();

  // Pull the agentId out of the Registered event.
  let agentId = null;
  for (const log of rc.logs) {
    try {
      const parsed = reg.interface.parseLog(log);
      if (parsed?.name === "Registered") agentId = parsed.args.agentId.toString();
    } catch (_) {}
  }
  if (agentId == null) agentId = (await reg.registeredCount()).toString();
  console.log(`✅ Registered agentId #${agentId} owned by ${agent.address}`);

  const outDir = path.join(__dirname, "..", "deploy");
  fs.mkdirSync(outDir, { recursive: true });
  const info = {
    chainId: net.chainId.toString(),
    network: hre.network.name,
    registry: regAddr,
    agentId,
    agentURI,
    agentAddress: agent.address,
  };
  fs.writeFileSync(path.join(outDir, "identity.json"), JSON.stringify(info, null, 2));
  console.log("   saved -> deploy/identity.json");

  console.log("\nSet in .env (local + server):");
  console.log("  IDENTITY_REGISTRY=" + regAddr);
  console.log("  AGENT_ID=" + agentId);
  console.log("  VITE_IDENTITY_REGISTRY=" + regAddr);
  console.log("  VITE_AGENT_ID=" + agentId);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

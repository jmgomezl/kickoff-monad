const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentIdentityRegistry (ERC-8004 Identity)", function () {
  let reg, deployer, agent, other;
  const CARD = "https://kickoff.bot/agent-card.json";

  beforeEach(async () => {
    [deployer, agent, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AgentIdentityRegistry");
    reg = await Factory.deploy();
    await reg.waitForDeployment();
  });

  it("registers an agent, assigns a sequential agentId, and resolves the agentURI", async () => {
    await expect(reg.connect(agent)["register(string)"](CARD))
      .to.emit(reg, "Registered")
      .withArgs(1n, CARD, agent.address);

    expect(await reg.registeredCount()).to.equal(1n);
    expect(await reg.ownerOf(1n)).to.equal(agent.address);
    expect(await reg.getAgentWallet(1n)).to.equal(agent.address);
    expect(await reg.tokenURI(1n)).to.equal(CARD); // resolves to the Agent Card
  });

  it("is permissionless and increments ids per registration", async () => {
    await reg.connect(agent)["register(string)"](CARD);
    await reg.connect(other)["register(string)"]("ipfs://other");
    expect(await reg.registeredCount()).to.equal(2n);
    expect(await reg.ownerOf(2n)).to.equal(other.address);
  });

  it("lets only the agent owner update its agentURI", async () => {
    await reg.connect(agent)["register(string)"](CARD);
    await expect(reg.connect(other).setAgentURI(1n, "https://evil")).to.be.revertedWith(
      "not agent owner"
    );
    await expect(reg.connect(agent).setAgentURI(1n, "https://kickoff.bot/v2.json"))
      .to.emit(reg, "URIUpdated")
      .withArgs(1n, "https://kickoff.bot/v2.json", agent.address);
    expect(await reg.tokenURI(1n)).to.equal("https://kickoff.bot/v2.json");
  });

  it("stores and reads on-chain metadata", async () => {
    await reg.connect(agent)["register(string)"](CARD);
    const val = ethers.toUtf8Bytes("negotiation");
    await reg.connect(agent).setMetadata(1n, "skill", val);
    expect(await reg.getMetadata(1n, "skill")).to.equal(ethers.hexlify(val));
  });
});

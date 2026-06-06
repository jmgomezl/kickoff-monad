const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KickoffMarket + MONADCOP", function () {
  let token, market, seller, agent, alice, bob;
  const salt = ethers.id("reserve-salt");
  const reserve = ethers.parseEther("20000"); // 20k MONADCOP hidden reserve

  beforeEach(async () => {
    [seller, agent, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MONADCOP");
    token = await Token.deploy();
    await token.waitForDeployment();
    const Market = await ethers.getContractFactory("KickoffMarket");
    market = await Market.deploy();
    await market.waitForDeployment();

    // Drip 50k to both buyers.
    await token.drip(alice.address);
    await token.drip(bob.address);
  });

  async function openListing() {
    const commit = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reserve, salt]);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await market
      .connect(seller)
      .createListing(token.target, commit, deadline, "Balón oficial Monad", agent.address);
    return 1n;
  }

  it("negotiates a winner below their max and reveals margin over reserve", async () => {
    const id = await openListing();

    // Alice: max 50k, strong human story. Bob: max 40k, weak.
    await token.connect(alice).approve(market.target, ethers.parseEther("50000"));
    await token.connect(bob).approve(market.target, ethers.parseEther("40000"));
    await market.connect(alice).submitOffer(id, ethers.parseEther("50000"), "Es para mi hijo, su regalo de navidad");
    await market.connect(bob).submitOffer(id, ethers.parseEther("40000"), "Soy revendedor");

    expect(await market.getOfferCount(id)).to.equal(2);

    // Agent picks Alice (idx 0) but negotiates 30k (< her 50k max).
    const finalPrice = ethers.parseEther("30000");
    await expect(market.connect(agent).executeWinner(id, 0, finalPrice, "Mejor historia; precio justo sobre el mercado"))
      .to.emit(market, "WinnerChosen")
      .withArgs(id, 0, alice.address, finalPrice, ethers.parseEther("50000"), ethers.parseEther("20000"), "Mejor historia; precio justo sobre el mercado");

    // Seller received 30k; Alice paid 30k (kept 20k of her budget).
    expect(await token.balanceOf(seller.address)).to.equal(ethers.parseEther("100030000"));
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("20000"));
    // Bob untouched.
    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther("50000"));

    // Reveal: reserve 20k, final 30k -> margin +10k (cleared reserve).
    await expect(market.connect(seller).revealReserve(id, reserve, salt))
      .to.emit(market, "ReserveRevealed")
      .withArgs(id, reserve, finalPrice, ethers.parseEther("10000"));
  });

  it("rejects a final price above the winner's max", async () => {
    const id = await openListing();
    await token.connect(alice).approve(market.target, ethers.parseEther("50000"));
    await market.connect(alice).submitOffer(id, ethers.parseEther("50000"), "x");
    await expect(
      market.connect(agent).executeWinner(id, 0, ethers.parseEther("60000"), "too high")
    ).to.be.revertedWith("bad price");
  });

  it("requires approval (proof of funds) before offering", async () => {
    const id = await openListing();
    await expect(
      market.connect(alice).submitOffer(id, ethers.parseEther("50000"), "x")
    ).to.be.revertedWith("approve first");
  });

  it("blocks non-agent execution and seller self-bid", async () => {
    const id = await openListing();
    await token.connect(alice).approve(market.target, ethers.parseEther("50000"));
    await market.connect(alice).submitOffer(id, ethers.parseEther("50000"), "x");
    await expect(market.connect(bob).executeWinner(id, 0, ethers.parseEther("10000"), "no")).to.be.revertedWith("not agent");
    await expect(market.connect(seller).submitOffer(id, ethers.parseEther("1"), "x")).to.be.revertedWith("seller cannot bid");
  });

  it("drips 50k once per address", async () => {
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("50000"));
    await expect(token.drip(alice.address)).to.be.revertedWith("already dripped");
  });
});

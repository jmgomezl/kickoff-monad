const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KickoffArena", function () {
  let arena, seller, agent, alice, bob;
  const salt = ethers.id("super-secret-salt");
  const minPrice = ethers.parseEther("1.0");

  beforeEach(async () => {
    [seller, agent, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("KickoffArena");
    arena = await Factory.deploy();
    await arena.waitForDeployment();
  });

  async function openArena() {
    const commit = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [minPrice, salt]);
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    await arena
      .connect(seller)
      .createArena(commit, deadline, "Balón Monad", agent.address, {
        value: ethers.parseEther("0.5"),
      });
    return 1n;
  }

  it("runs the full happy path: create → offer → decide → reveal", async () => {
    const id = await openArena();

    await arena.connect(alice).submitOffer(id, "Soy fan #1, lo merezco", {
      value: ethers.parseEther("1.5"),
    });
    await arena.connect(bob).submitOffer(id, "Pago más", {
      value: ethers.parseEther("2.0"),
    });

    expect(await arena.getOfferCount(id)).to.equal(2);

    // Agent picks Alice (index 0) despite lower bid — argument quality.
    const sellerBefore = await ethers.provider.getBalance(seller.address);
    await expect(arena.connect(agent).executeWinner(id, 0, "Mejor argumento"))
      .to.emit(arena, "WinnerChosen")
      .withArgs(id, 0, alice.address, ethers.parseEther("1.5"), "Mejor argumento");

    // Seller received winning bid (1.5).
    const sellerAfter = await ethers.provider.getBalance(seller.address);
    expect(sellerAfter - sellerBefore).to.equal(ethers.parseEther("1.5"));

    // Bob (loser) can withdraw his 2.0.
    expect(await arena.pendingReturns(bob.address)).to.equal(ethers.parseEther("2.0"));

    // Reveal: minPrice 1.0, winning bid 1.5, spread +0.5.
    await expect(arena.connect(seller).revealMinPrice(id, minPrice, salt))
      .to.emit(arena, "MinPriceRevealed")
      .withArgs(id, minPrice, ethers.parseEther("1.5"), ethers.parseEther("0.5"));
  });

  it("rejects a wrong reveal", async () => {
    const id = await openArena();
    await arena.connect(alice).submitOffer(id, "x", { value: ethers.parseEther("1.5") });
    await arena.connect(agent).executeWinner(id, 0, "ok");
    await expect(
      arena.connect(seller).revealMinPrice(id, ethers.parseEther("9"), salt)
    ).to.be.revertedWith("commit mismatch");
  });

  it("only the agent can decide", async () => {
    const id = await openArena();
    await arena.connect(alice).submitOffer(id, "x", { value: ethers.parseEther("1.5") });
    await expect(arena.connect(bob).executeWinner(id, 0, "no")).to.be.revertedWith("not agent");
  });

  it("slashes collateral to winner if seller never reveals", async () => {
    const id = await openArena();
    await arena.connect(alice).submitOffer(id, "x", { value: ethers.parseEther("1.5") });
    await arena.connect(agent).executeWinner(id, 0, "ok");

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);

    await expect(arena.slashUnrevealed(id))
      .to.emit(arena, "CollateralSlashed")
      .withArgs(id, alice.address, ethers.parseEther("0.5"));
    // Alice now owed her refund(0) + collateral(0.5)
    expect(await arena.pendingReturns(alice.address)).to.equal(ethers.parseEther("0.5"));
  });
});

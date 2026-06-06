// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title KickoffArena
 * @notice P2P agent-driven negotiation marketplace on Monad.
 *
 * Flow:
 *   1. Seller creates an arena, committing keccak256(minPrice, salt) on-chain
 *      and posting collateral. The min price stays hidden.
 *   2. Buyers submit offers as payable txs — each offer is an escrowed bid
 *      amount plus a free-text argument for *why* they deserve the prize.
 *   3. At the deadline, an authorized AI agent calls executeWinner() with the
 *      chosen offer index and public reasoning. The winning bid is paid to the
 *      seller; losing bids become withdrawable.
 *   4. The seller calls revealMinPrice() — the dramatic reveal. The contract
 *      verifies the commitment and exposes the spread (winningBid - minPrice).
 *
 * Anti-fraud: if the seller never reveals within REVEAL_WINDOW after a winner
 * is chosen, anyone may call slashUnrevealed() to forfeit the seller's
 * collateral to the winner. This forces honest reveals.
 */
contract KickoffArena {
    // ── Types ──────────────────────────────────────────────────────────────

    enum State {
        None,      // does not exist
        Open,      // accepting offers
        Decided,   // winner chosen, awaiting reveal
        Revealed,  // min price revealed — terminal
        Cancelled  // cancelled by seller (no offers) — terminal
    }

    struct Offer {
        address bidder;
        uint256 amount;     // escrowed MON
        string  argument;   // why they deserve the prize
        uint256 timestamp;
    }

    struct Arena {
        address seller;
        address agent;            // authorized to call executeWinner
        bytes32 minPriceCommit;   // keccak256(abi.encodePacked(minPrice, salt))
        uint256 collateral;       // seller stake, returned on honest reveal
        uint256 deadline;         // unix ts after which offers close
        string  prizeName;        // e.g. "Balón oficial Monad Blitz"
        State   state;
        uint256 winnerIndex;      // valid once Decided
        uint256 decidedAt;        // ts of executeWinner
        uint256 revealedMinPrice; // valid once Revealed
        string  reasoning;        // agent's public reasoning
    }

    // ── Storage ────────────────────────────────────────────────────────────

    uint256 public constant REVEAL_WINDOW = 1 hours;

    uint256 public arenaCount;
    mapping(uint256 => Arena) private arenas;
    mapping(uint256 => Offer[]) private offers;
    mapping(address => uint256) public pendingReturns; // pull-pattern withdrawals

    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ── Events ─────────────────────────────────────────────────────────────

    event ArenaCreated(
        uint256 indexed arenaId,
        address indexed seller,
        address indexed agent,
        string prizeName,
        uint256 deadline,
        uint256 collateral
    );
    event OfferSubmitted(
        uint256 indexed arenaId,
        uint256 indexed offerIndex,
        address indexed bidder,
        uint256 amount,
        string argument
    );
    event WinnerChosen(
        uint256 indexed arenaId,
        uint256 indexed winnerIndex,
        address indexed winner,
        uint256 amount,
        string reasoning
    );
    event MinPriceRevealed(
        uint256 indexed arenaId,
        uint256 minPrice,
        uint256 winningBid,
        int256 spread
    );
    event ArenaCancelled(uint256 indexed arenaId);
    event CollateralSlashed(uint256 indexed arenaId, address indexed winner, uint256 amount);
    event Withdrawal(address indexed who, uint256 amount);

    // ── Seller: create ─────────────────────────────────────────────────────

    /**
     * @param minPriceCommit keccak256(abi.encodePacked(uint256 minPrice, bytes32 salt))
     * @param deadline       unix ts after which offers are rejected
     * @param prizeName      human label for the prize
     * @param agent          address authorized to choose the winner
     */
    function createArena(
        bytes32 minPriceCommit,
        uint256 deadline,
        string calldata prizeName,
        address agent
    ) external payable returns (uint256 arenaId) {
        require(deadline > block.timestamp, "deadline in past");
        require(agent != address(0), "agent=0");
        require(minPriceCommit != bytes32(0), "empty commit");

        arenaId = ++arenaCount;
        Arena storage a = arenas[arenaId];
        a.seller = msg.sender;
        a.agent = agent;
        a.minPriceCommit = minPriceCommit;
        a.collateral = msg.value;
        a.deadline = deadline;
        a.prizeName = prizeName;
        a.state = State.Open;

        emit ArenaCreated(arenaId, msg.sender, agent, prizeName, deadline, msg.value);
    }

    // ── Buyer: offer ───────────────────────────────────────────────────────

    function submitOffer(uint256 arenaId, string calldata argument)
        external
        payable
        returns (uint256 offerIndex)
    {
        Arena storage a = arenas[arenaId];
        require(a.state == State.Open, "not open");
        require(block.timestamp < a.deadline, "closed");
        require(msg.value > 0, "zero bid");
        require(msg.sender != a.seller, "seller cannot bid");
        require(bytes(argument).length <= 1000, "argument too long");

        offerIndex = offers[arenaId].length;
        offers[arenaId].push(Offer({
            bidder: msg.sender,
            amount: msg.value,
            argument: argument,
            timestamp: block.timestamp
        }));

        emit OfferSubmitted(arenaId, offerIndex, msg.sender, msg.value, argument);
    }

    // ── Agent: decide ──────────────────────────────────────────────────────

    function executeWinner(uint256 arenaId, uint256 winnerIndex, string calldata reasoning)
        external
        nonReentrant
    {
        Arena storage a = arenas[arenaId];
        require(a.state == State.Open, "not open");
        require(msg.sender == a.agent, "not agent");
        Offer[] storage list = offers[arenaId];
        require(list.length > 0, "no offers");
        require(winnerIndex < list.length, "bad index");

        a.state = State.Decided;
        a.winnerIndex = winnerIndex;
        a.decidedAt = block.timestamp;
        a.reasoning = reasoning;

        Offer storage win = list[winnerIndex];

        // Losers become withdrawable (pull pattern — no loop reverts).
        for (uint256 i = 0; i < list.length; i++) {
            if (i == winnerIndex) continue;
            pendingReturns[list[i].bidder] += list[i].amount;
        }

        // Winning bid goes to the seller.
        _payOrCredit(a.seller, win.amount);

        emit WinnerChosen(arenaId, winnerIndex, win.bidder, win.amount, reasoning);
    }

    // ── Seller: reveal ─────────────────────────────────────────────────────

    function revealMinPrice(uint256 arenaId, uint256 minPrice, bytes32 salt)
        external
        nonReentrant
    {
        Arena storage a = arenas[arenaId];
        require(a.state == State.Decided, "not decided");
        require(msg.sender == a.seller, "not seller");
        require(
            keccak256(abi.encodePacked(minPrice, salt)) == a.minPriceCommit,
            "commit mismatch"
        );

        a.state = State.Revealed;
        a.revealedMinPrice = minPrice;

        uint256 winningBid = offers[arenaId][a.winnerIndex].amount;
        int256 spread = int256(winningBid) - int256(minPrice);

        // Honest reveal — return collateral.
        if (a.collateral > 0) {
            uint256 c = a.collateral;
            a.collateral = 0;
            _payOrCredit(a.seller, c);
        }

        emit MinPriceRevealed(arenaId, minPrice, winningBid, spread);
    }

    // ── Anti-fraud: slash a seller who refuses to reveal ───────────────────

    function slashUnrevealed(uint256 arenaId) external nonReentrant {
        Arena storage a = arenas[arenaId];
        require(a.state == State.Decided, "not decided");
        require(block.timestamp > a.decidedAt + REVEAL_WINDOW, "reveal window open");

        uint256 c = a.collateral;
        require(c > 0, "no collateral");
        a.collateral = 0;

        address winner = offers[arenaId][a.winnerIndex].bidder;
        pendingReturns[winner] += c;

        emit CollateralSlashed(arenaId, winner, c);
    }

    // ── Seller: cancel (only if no offers, before decided) ─────────────────

    function cancelArena(uint256 arenaId) external nonReentrant {
        Arena storage a = arenas[arenaId];
        require(a.state == State.Open, "not open");
        require(msg.sender == a.seller, "not seller");
        require(offers[arenaId].length == 0, "has offers");

        a.state = State.Cancelled;
        if (a.collateral > 0) {
            uint256 c = a.collateral;
            a.collateral = 0;
            _payOrCredit(a.seller, c);
        }
        emit ArenaCancelled(arenaId);
    }

    // ── Withdrawals (pull pattern) ─────────────────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "nothing to withdraw");
        pendingReturns[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawal(msg.sender, amount);
    }

    function _payOrCredit(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) {
            pendingReturns[to] += amount;
        }
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function getArena(uint256 arenaId)
        external
        view
        returns (
            address seller,
            address agent,
            bytes32 minPriceCommit,
            uint256 collateral,
            uint256 deadline,
            string memory prizeName,
            State state,
            uint256 winnerIndex,
            uint256 revealedMinPrice,
            string memory reasoning
        )
    {
        Arena storage a = arenas[arenaId];
        return (
            a.seller,
            a.agent,
            a.minPriceCommit,
            a.collateral,
            a.deadline,
            a.prizeName,
            a.state,
            a.winnerIndex,
            a.revealedMinPrice,
            a.reasoning
        );
    }

    function getOfferCount(uint256 arenaId) external view returns (uint256) {
        return offers[arenaId].length;
    }

    function getOffer(uint256 arenaId, uint256 offerIndex)
        external
        view
        returns (address bidder, uint256 amount, string memory argument, uint256 timestamp)
    {
        Offer storage o = offers[arenaId][offerIndex];
        return (o.bidder, o.amount, o.argument, o.timestamp);
    }

    function getOffers(uint256 arenaId) external view returns (Offer[] memory) {
        return offers[arenaId];
    }

    /// @notice Helper so off-chain tooling computes the same commitment.
    function computeCommit(uint256 minPrice, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(minPrice, salt));
    }
}

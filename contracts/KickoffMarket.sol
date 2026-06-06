// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title KickoffMarket
 * @notice An agent-driven marketplace on Monad. Buyers describe what they want,
 *         their MAX budget (in MONADCOP), and WHY they deserve it. An AI agent
 *         reads every request, picks a winner, and NEGOTIATES the final price —
 *         somewhere above the seller's hidden reserve and at/below the buyer's
 *         max. The winner pays only the negotiated price; the difference is what
 *         "their agent saved them."
 *
 * Money model (allowance-based, refund-free):
 *   • Buyers APPROVE the market for their max budget (proof of funds) — no tokens
 *     move at offer time, so losing buyers are never charged and need no refund.
 *   • At executeWinner the market pulls ONLY the negotiated finalPrice from the
 *     winner to the seller via transferFrom.
 *
 * Trust:
 *   • The seller commits keccak256(reserve, salt) up front; nobody (not even the
 *     agent) sees the reserve until the reveal. The reveal proves whether the
 *     agent's negotiated price cleared the reserve.
 */
contract KickoffMarket {
    using SafeERC20 for IERC20;

    enum State { None, Open, Decided, Revealed, Cancelled }

    struct Offer {
        address buyer;
        uint256 maxBudget;  // willingness-to-pay ceiling (approved, not moved)
        string  request;    // natural-language: what they want + why
        uint256 timestamp;
    }

    struct Listing {
        address seller;
        address agent;
        IERC20  token;
        bytes32 reserveCommit;   // keccak256(abi.encodePacked(reserve, salt))
        uint256 deadline;
        string  itemName;        // what's for sale, e.g. "Balón oficial Monad"
        State   state;
        uint256 winnerIndex;
        uint256 finalPrice;      // agent-negotiated, valid once Decided
        uint256 revealedReserve; // valid once Revealed
        string  reasoning;       // agent's public reasoning
    }

    uint256 public listingCount;
    mapping(uint256 => Listing) private listings;
    mapping(uint256 => Offer[]) private offers;
    mapping(uint256 => mapping(address => bool)) public hasOffered;

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        address indexed agent,
        address token,
        string itemName,
        uint256 deadline
    );
    event OfferSubmitted(
        uint256 indexed listingId,
        uint256 indexed offerIndex,
        address indexed buyer,
        uint256 maxBudget,
        string request
    );
    event WinnerChosen(
        uint256 indexed listingId,
        uint256 indexed winnerIndex,
        address indexed winner,
        uint256 finalPrice,
        uint256 maxBudget,
        uint256 savings,
        string reasoning
    );
    event ReserveRevealed(
        uint256 indexed listingId,
        uint256 reserve,
        uint256 finalPrice,
        int256 margin
    );
    event ListingCancelled(uint256 indexed listingId);

    // ── Seller ──────────────────────────────────────────────────────────────

    function createListing(
        IERC20 token,
        bytes32 reserveCommit,
        uint256 deadline,
        string calldata itemName,
        address agent
    ) external returns (uint256 listingId) {
        require(deadline > block.timestamp, "deadline in past");
        require(agent != address(0), "agent=0");
        require(address(token) != address(0), "token=0");
        require(reserveCommit != bytes32(0), "empty commit");

        listingId = ++listingCount;
        Listing storage l = listings[listingId];
        l.seller = msg.sender;
        l.agent = agent;
        l.token = token;
        l.reserveCommit = reserveCommit;
        l.deadline = deadline;
        l.itemName = itemName;
        l.state = State.Open;

        emit ListingCreated(listingId, msg.sender, agent, address(token), itemName, deadline);
    }

    // ── Buyer ───────────────────────────────────────────────────────────────

    /**
     * @param maxBudget the most the buyer is willing to pay. The buyer must have
     *        approved this market for at least `maxBudget` of the listing token.
     */
    function submitOffer(uint256 listingId, uint256 maxBudget, string calldata request)
        external
        returns (uint256 offerIndex)
    {
        Listing storage l = listings[listingId];
        require(l.state == State.Open, "not open");
        require(block.timestamp < l.deadline, "closed");
        require(msg.sender != l.seller, "seller cannot bid");
        require(maxBudget > 0, "zero budget");
        require(!hasOffered[listingId][msg.sender], "already offered");
        require(bytes(request).length <= 1500, "request too long");
        // Proof of funds: must be good for the full max they claim.
        require(l.token.allowance(msg.sender, address(this)) >= maxBudget, "approve first");
        require(l.token.balanceOf(msg.sender) >= maxBudget, "insufficient balance");

        hasOffered[listingId][msg.sender] = true;
        offerIndex = offers[listingId].length;
        offers[listingId].push(Offer({
            buyer: msg.sender,
            maxBudget: maxBudget,
            request: request,
            timestamp: block.timestamp
        }));

        emit OfferSubmitted(listingId, offerIndex, msg.sender, maxBudget, request);
    }

    // ── Agent ───────────────────────────────────────────────────────────────

    /**
     * @param finalPrice the negotiated price. Must be <= winner's maxBudget.
     *        Pulled from the winner to the seller. (Whether it cleared the hidden
     *        reserve is proven at reveal.)
     */
    function executeWinner(
        uint256 listingId,
        uint256 winnerIndex,
        uint256 finalPrice,
        string calldata reasoning
    ) external {
        Listing storage l = listings[listingId];
        require(l.state == State.Open, "not open");
        require(msg.sender == l.agent, "not agent");
        Offer[] storage list = offers[listingId];
        require(list.length > 0, "no offers");
        require(winnerIndex < list.length, "bad index");

        Offer storage win = list[winnerIndex];
        require(finalPrice > 0 && finalPrice <= win.maxBudget, "bad price");

        l.state = State.Decided;
        l.winnerIndex = winnerIndex;
        l.finalPrice = finalPrice;
        l.reasoning = reasoning;

        // Pull the negotiated price from winner to seller.
        l.token.safeTransferFrom(win.buyer, l.seller, finalPrice);

        emit WinnerChosen(
            listingId,
            winnerIndex,
            win.buyer,
            finalPrice,
            win.maxBudget,
            win.maxBudget - finalPrice,
            reasoning
        );
    }

    // ── Reveal ──────────────────────────────────────────────────────────────

    function revealReserve(uint256 listingId, uint256 reserve, bytes32 salt) external {
        Listing storage l = listings[listingId];
        require(l.state == State.Decided, "not decided");
        require(msg.sender == l.seller, "not seller");
        require(
            keccak256(abi.encodePacked(reserve, salt)) == l.reserveCommit,
            "commit mismatch"
        );

        l.state = State.Revealed;
        l.revealedReserve = reserve;
        int256 margin = int256(l.finalPrice) - int256(reserve);
        emit ReserveRevealed(listingId, reserve, l.finalPrice, margin);
    }

    // ── Seller cancel (only with no offers) ─────────────────────────────────

    function cancelListing(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.state == State.Open, "not open");
        require(msg.sender == l.seller, "not seller");
        require(offers[listingId].length == 0, "has offers");
        l.state = State.Cancelled;
        emit ListingCancelled(listingId);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function getListing(uint256 listingId)
        external
        view
        returns (
            address seller,
            address agent,
            address token,
            bytes32 reserveCommit,
            uint256 deadline,
            string memory itemName,
            State state,
            uint256 winnerIndex,
            uint256 finalPrice,
            uint256 revealedReserve,
            string memory reasoning
        )
    {
        Listing storage l = listings[listingId];
        return (
            l.seller, l.agent, address(l.token), l.reserveCommit, l.deadline,
            l.itemName, l.state, l.winnerIndex, l.finalPrice, l.revealedReserve, l.reasoning
        );
    }

    function getOfferCount(uint256 listingId) external view returns (uint256) {
        return offers[listingId].length;
    }

    function getOffer(uint256 listingId, uint256 offerIndex)
        external
        view
        returns (address buyer, uint256 maxBudget, string memory request, uint256 timestamp)
    {
        Offer storage o = offers[listingId][offerIndex];
        return (o.buyer, o.maxBudget, o.request, o.timestamp);
    }

    function getOffers(uint256 listingId) external view returns (Offer[] memory) {
        return offers[listingId];
    }

    function computeCommit(uint256 reserve, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(reserve, salt));
    }
}

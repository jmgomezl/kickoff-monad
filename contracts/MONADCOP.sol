// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MONADCOP
 * @notice The play-money currency of the kickoff marketplace demo.
 *
 * Every person who joins via the Telegram Mini App is dripped 50,000 MONADCOP
 * to spend trying to convince the agent. ERC20Permit is included so the backend
 * can do gasless approvals (single tx) when submitting offers.
 */
contract MONADCOP is ERC20, ERC20Permit, Ownable {
    uint256 public constant DRIP_AMOUNT = 50_000 ether; // 50,000 MONADCOP
    mapping(address => bool) public hasClaimed;

    event Dripped(address indexed to, uint256 amount);

    constructor() ERC20("Monad COP", "MONADCOP") ERC20Permit("Monad COP") Ownable(msg.sender) {
        // Pre-mint a treasury supply to the deployer for funding/liquidity.
        _mint(msg.sender, 100_000_000 ether);
    }

    /// @notice Owner (backend treasury) drips the standard welcome amount to a new user.
    function drip(address to) external onlyOwner {
        require(!hasClaimed[to], "already dripped");
        hasClaimed[to] = true;
        _mint(to, DRIP_AMOUNT);
        emit Dripped(to, DRIP_AMOUNT);
    }

    /// @notice Self-serve faucet (one-time) — handy for testing without the backend.
    function claim() external {
        require(!hasClaimed[msg.sender], "already claimed");
        hasClaimed[msg.sender] = true;
        _mint(msg.sender, DRIP_AMOUNT);
        emit Dripped(msg.sender, DRIP_AMOUNT);
    }

    /// @notice Owner mint for treasury top-ups.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

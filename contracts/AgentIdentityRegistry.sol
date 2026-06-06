// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/**
 * @title AgentIdentityRegistry
 * @notice A minimal ERC-8004 ("Trustless Agents") Identity Registry on Monad.
 *
 * Every autonomous agent gets a portable, censorship-resistant on-chain handle:
 * an ERC-721 token whose id is the `agentId` and whose `tokenURI` (the
 * "agentURI") resolves to the agent's registration file — the Agent Card —
 * describing its name, capabilities, service endpoints and supported trust
 * models.
 *
 * The registry is permissionless: any address can `register()` and self-issue
 * an identity; no central party mints or revokes. The agent itself owns its
 * identity token and is the only one that can update its agentURI / metadata.
 *
 * This implements the core Identity Registry surface of ERC-8004
 * (register / agentURI resolution / metadata). Reputation and Validation
 * registries are intentionally out of scope for this deployment.
 */
contract AgentIdentityRegistry is ERC721URIStorage {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    uint256 private _nextId = 1;
    // agentId => keccak256(key) => value
    mapping(uint256 => mapping(bytes32 => bytes)) private _metadata;

    /// @notice Emitted when a new agent identity is registered.
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    /// @notice Emitted when an agent's registration file URI changes.
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    /// @notice Emitted when an agent's on-chain metadata changes.
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );

    constructor() ERC721("Trustless Agent", "AGENT") {}

    // ───────────────────────── Registration ─────────────────────────

    /// @notice Register a new agent with no agentURI (set it later).
    function register() external returns (uint256 agentId) {
        return _register(msg.sender, "");
    }

    /// @notice Register a new agent whose `agentURI` resolves to its Agent Card.
    function register(string calldata agentURI) external returns (uint256 agentId) {
        return _register(msg.sender, agentURI);
    }

    /// @notice Register a new agent with an `agentURI` and initial on-chain metadata.
    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _register(msg.sender, agentURI);
        for (uint256 i = 0; i < metadata.length; i++) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function _register(address to, string memory agentURI) internal returns (uint256 agentId) {
        agentId = _nextId++;
        _safeMint(to, agentId);
        if (bytes(agentURI).length > 0) {
            _setTokenURI(agentId, agentURI);
        }
        emit Registered(agentId, agentURI, to);
    }

    // ───────────────────────── Resolution / updates ─────────────────────────

    /// @notice Update the agent's registration file URI. Only the agent (token owner).
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(ownerOf(agentId) == msg.sender, "not agent owner");
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// @notice Set a metadata entry for an agent. Only the agent (token owner).
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external {
        require(ownerOf(agentId) == msg.sender, "not agent owner");
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    function _setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) internal {
        _metadata[agentId][keccak256(bytes(metadataKey))] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    /// @notice Read a metadata entry for an agent.
    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory) {
        return _metadata[agentId][keccak256(bytes(metadataKey))];
    }

    /// @notice The controlling wallet of an agent (its identity-token owner).
    function getAgentWallet(uint256 agentId) external view returns (address) {
        return ownerOf(agentId);
    }

    /// @notice Total number of registered agents.
    function registeredCount() external view returns (uint256) {
        return _nextId - 1;
    }
}

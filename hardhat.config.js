require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  MONAD_RPC_URL = "https://rpc.monad.xyz",
  MONAD_CHAIN_ID = "10143",
  PRIVATE_KEY,
} = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    monad: {
      url: MONAD_RPC_URL,
      chainId: Number(MONAD_CHAIN_ID),
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    hardhat: {
      chainId: 31337,
    },
  },
};

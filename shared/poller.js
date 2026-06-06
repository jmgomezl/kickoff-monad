/**
 * Filter-free event poller for Monad.
 *
 * Monad's public RPC does not support eth_newFilter (which ethers' contract.on
 * relies on), but it does support eth_getLogs over small block ranges. This
 * polls getLogs in chunks, parses logs against the contract ABI, and dispatches
 * to named handlers.
 *
 *   const stop = startEventPoller({
 *     contract, provider,
 *     handlers: { OfferSubmitted: (args, log) => {...} },
 *   });
 */
function startEventPoller({
  contract,
  provider,
  handlers = {},
  intervalMs = 1000,
  chunk = 90,
  lookbackBlocks = 5,
  onError = () => {},
}) {
  let last = null;
  let running = true;

  async function tick() {
    if (!running) return;
    try {
      const current = await provider.getBlockNumber();
      if (last === null) last = Math.max(0, current - lookbackBlocks) - 1;

      while (last < current) {
        const to = Math.min(last + chunk, current);
        const logs = await provider.getLogs({
          address: contract.target,
          fromBlock: last + 1,
          toBlock: to,
        });
        for (const log of logs) {
          let parsed;
          try {
            parsed = contract.interface.parseLog(log);
          } catch (_) {
            continue;
          }
          const h = handlers[parsed.name];
          if (h) {
            try {
              h(parsed.args, log);
            } catch (e) {
              onError(e);
            }
          }
        }
        last = to;
      }
    } catch (e) {
      onError(e);
    }
    if (running) setTimeout(tick, intervalMs);
  }

  tick();
  return () => {
    running = false;
  };
}

module.exports = { startEventPoller };

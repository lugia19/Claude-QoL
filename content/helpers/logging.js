// logging.js
// Names this extension's logs (common/log/logger.js). Loaded in both worlds, right after the logger;
// the MAIN world's entries are relayed to the ISOLATED world, which stores them.
configureLogger({ app: 'qol', prefix: '[QoL]' });

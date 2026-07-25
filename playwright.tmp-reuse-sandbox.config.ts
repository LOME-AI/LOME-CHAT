import base from './playwright.config';

const servers = Array.isArray(base.webServer) ? base.webServer : [];

export default {
  ...base,
  webServer: servers.map((server) =>
    server.name === 'Sandbox' ? { ...server, reuseExistingServer: true } : server
  ),
};

/** Wire contract for explicitly negotiated redirects between Osnova peers. */
export const InspectableRedirectProtocol = {
  header: "x-osnova-redirect",
  statusHeader: "x-osnova-redirect-status",
  version: "manual-v1",
} as const;

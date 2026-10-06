/** Wire contract for explicitly negotiated redirects between Bazis peers. */
export const InspectableRedirectProtocol = {
  header: "x-bazis-redirect",
  statusHeader: "x-bazis-redirect-status",
  version: "manual-v1",
} as const;

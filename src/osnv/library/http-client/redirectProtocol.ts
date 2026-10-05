/** Wire contract for explicitly negotiated redirects between Osnv peers. */
export const InspectableRedirectProtocol = {
  header: "x-osnv-redirect",
  statusHeader: "x-osnv-redirect-status",
  version: "manual-v1",
} as const;
